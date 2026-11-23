/**
 * ============================================================================
 * الملف: src/tools/mcp-memory-server.ts
 * القسم: Tools (الأدوات المستقلة — خادم الذاكرة المشتركة MCP)
 * Hint بالعربي: خادم بروتوكول سياق النماذج (MCP) عبر stdio يربط Claude Code و Google Antigravity
 *               بذاكرة واحدة مشتركة داخل Obsidian. ملتزم بالبروتوكول:
 *               - لا يرد على الإشعارات (الرسائل بلا id).
 *               - يتفاوض على إصدار البروتوكول، ويدعم ping.
 *               - أخطاء JSON-RPC صحيحة (-32700 / -32600 / -32601 / -32602)، وأخطاء الأدوات تُعاد بـ isError.
 *               - لا يطبع أي شيء على stdout غير رسائل البروتوكول، ولا يصل إلى الخزنة إطلاقاً.
 *               - 4.0.1: يقرأ المعرفة ويكتب فيها بالنسخة المحلية من مفتاح المعرفة (لا مفتاح البيانات)،
 *                 وأداتان جديدتان: second_brain_search_knowledge و second_brain_get_decision_log.
 *                 وتسجيل الذاكرة ينشئ عقدة محادثة، وقراراته اقتراحات تنتظر موافقة القائد.
 *               - 3.8.0: مفتاح تشغيل لكل أداة (المعطّلة لا تظهر وتُرفض)، وسجل عمليات بلا محتوى (mcp-controls.ts).
 *               - 3.8.2 (ISS-043): يُعلن listChanged ويرسل notifications/tools/list_changed عند تغيّر الأدوات المعطّلة،
 *                 فتظهر الأداة المعادة في المحادثة المفتوحة بلا محادثة جديدة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { SharedAIMemoryEntry } from '../shared/types.ts';
import { redactSecrets } from '../shared/secret-redaction.ts';
import { loadSystemConfig, readAppVersion } from '../core/config-manager.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../features/ai-memory/shared-memory-service.ts';
import { scanAndAnalyzeProject } from '../features/project-indexer/project-scanner.ts';
import { checkWriteAccess } from '../features/sync/sync-context.ts';
import { appendMcpAudit, isMcpToolEnabled, readDisabledMcpTools, type McpAuditResult } from '../features/ai-memory/mcp-controls.ts';
import { readDeviceKnowledgeKey } from '../features/knowledge/knowledge-access.ts';
import { conversationNodeId, migrateSharedMemoryToKnowledge } from '../features/knowledge/knowledge-migration.ts';
import { decisionLog, neighborsOf, searchKnowledge } from '../features/knowledge/knowledge-query.ts';
import { readKnowledgeGraph, type KnowledgeGraph } from '../features/knowledge/knowledge-store.ts';
import { NODE_TYPES, type KnowledgeNode, type KnowledgeNodeType } from '../features/knowledge/knowledge-types.ts';

/** إصدارات البروتوكول المدعومة (الأحدث أولاً) */
export const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** إصدار الخادم = إصدار البرنامج (package.json) حتى يعرف Claude Code و Antigravity أي نسخة يتصلان بها */
const SERVER_VERSION = readAppVersion();
const SOURCE_AI_VALUES = ['antigravity-gemini', 'claude-code', 'second-brain-assistant', 'manual'] as const;

/** البرنامج المتصل بهذه العملية (من رسالة initialize)، لسجل العمليات */
let connectedClient: { name: string; version: string } = { name: '', version: '' };

/**
 * Hint بالعربي: للاختبارات فقط: تصفير البرنامج المتصل.
 */
export function resetMcpClientForTests(): void {
  connectedClient = { name: '', version: '' };
}

/**
 * Hint بالعربي: خطأ في معاملات الأداة يُعاد للعميل كخطأ JSON-RPC رقم -32602.
 */
export class McpInvalidParamsError extends Error {}

type ToolArgs = Record<string, unknown>;
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: ToolArgs) => string;
}

/**
 * Hint بالعربي: دالة قراءة نص اختياري من معاملات الأداة مع حد للطول.
 */
export function optionalString(args: ToolArgs, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new McpInvalidParamsError(`المعامل ${key} يجب أن يكون نصاً.`);
  if (value.length > maxLength) throw new McpInvalidParamsError(`المعامل ${key} أطول من ${maxLength} حرفاً.`);
  return value;
}

/**
 * Hint بالعربي: دالة قراءة نص إلزامي من معاملات الأداة.
 */
export function requiredString(args: ToolArgs, key: string, maxLength: number): string {
  const value = optionalString(args, key, maxLength);
  if (!value || !value.trim()) throw new McpInvalidParamsError(`المعامل ${key} مطلوب.`);
  return value.trim();
}

/**
 * Hint بالعربي: دالة تلخيص سجل ذاكرة بشكل مضغوط لإرساله للذكاء الاصطناعي.
 */
export function compactMemory(m: SharedAIMemoryEntry): Record<string, unknown> {
  return { id: m.id, date: m.createdAt, source: m.sourceAI, projectId: m.projectId, title: m.title, summary: m.summaryAr, decisions: m.keyDecisionsAr };
}

/**
 * Hint بالعربي: دالة بناء قائمة أدوات الخادم مع منفّذ كل أداة.
 */
export function buildMcpTools(): ToolDefinition[] {
  const limitSchema = { type: 'integer', minimum: 1, maximum: 100, description: 'أقصى عدد للنتائج (افتراضياً 20)' };
  const readLimit = (args: ToolArgs): number => {
    const n = Number(args.limit ?? 20);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new McpInvalidParamsError('المعامل limit يجب أن يكون بين 1 و 100.');
    return n;
  };

  return [
    {
      name: 'second_brain_get_commander_profile',
      title: 'ملف القائد وقواعده البرمجية',
      description: 'يعيد ملف هوية القائد وتفضيلاته، والدستور البرمجي الملزم (القوانين الثمانية). اقرأه قبل بدء أي عمل على مشاريعه.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => {
        const config = loadSystemConfig();
        const dir = path.join(config.paths.obsidianVaultDir, '01-Commander-Profile');
        const read = (name: string): string => {
          try {
            return fs.readFileSync(path.join(dir, name), 'utf-8');
          } catch {
            return '(غير موجود)';
          }
        };
        return redactSecrets(`# About-Commander.md\n\n${read('About-Commander.md')}\n\n# AI-Coding-Standards.md\n\n${read('AI-Coding-Standards.md')}`).text;
      },
    },
    {
      name: 'second_brain_get_commander_and_projects_context',
      title: 'نظرة عامة على المشاريع',
      description: 'يعيد قائمة مختصرة بكل المشاريع المراقبة: المسار، التقنيات، أوامر التشغيل، عدد الملفات الحساسة، وحالة Git.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => {
        const config = loadSystemConfig();
        const projects = config.watchedProjects.map((p) => {
          const r = scanAndAnalyzeProject(p);
          return {
            id: p.id,
            name: p.name,
            path: p.path,
            description: p.descriptionAr,
            stack: r.detectedStack,
            run: r.runCommands,
            criticalFiles: r.criticalFilesFound.length,
            gitBranch: r.gitBranch ?? null,
            lastCommit: r.lastCommitMessage ?? null,
          };
        });
        return JSON.stringify({ commander: config.commanderName, strictLawsCount: 8, projects }, null, 2);
      },
    },
    {
      name: 'second_brain_get_project_context',
      title: 'تفاصيل مشروع واحد',
      description: 'يعيد التقرير الكامل لمشروع واحد (التقنيات، أوامر التشغيل والبناء والتحديث، الملفات المهمة، Git) مع سجلات الذاكرة الخاصة به.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'معرّف المشروع كما في قائمة المشاريع' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      run: (args) => {
        const projectId = requiredString(args, 'projectId', 200);
        const config = loadSystemConfig();
        const project = config.watchedProjects.find((p) => p.id.toLowerCase() === projectId.toLowerCase());
        if (!project) throw new McpInvalidParamsError(`لا يوجد مشروع بالمعرّف: ${projectId}`);
        const report = scanAndAnalyzeProject(project);
        const memories = querySharedAIMemory(project.id).slice(0, 20).map(compactMemory);
        return redactSecrets(
          JSON.stringify(
            {
              project: { id: project.id, name: project.name, path: project.path, description: project.descriptionAr },
              report: { ...report, criticalFilesFound: report.criticalFilesFound.map((c) => ({ path: c.relativePath, reason: c.reasonAr })) },
              memories,
            },
            null,
            2
          )
        ).text;
      },
    },
    {
      name: 'second_brain_recall_shared_memory',
      title: 'استرجاع الذاكرة المشتركة',
      description: 'يعيد أحدث سجلات الذاكرة المشتركة (القرارات وملخصات العمل السابقة)، لكل المشاريع أو لمشروع محدد.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'معرّف المشروع (اختياري)' }, limit: limitSchema },
        additionalProperties: false,
      },
      run: (args) => {
        const projectId = optionalString(args, 'projectId', 200);
        return JSON.stringify(querySharedAIMemory(projectId).slice(0, readLimit(args)).map(compactMemory), null, 2);
      },
    },
    {
      name: 'second_brain_search_memory',
      title: 'بحث في الذاكرة المشتركة',
      description: 'يبحث نصياً في عناوين وملخصات وقرارات الذاكرة المشتركة (يدعم العربية والإنجليزية).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'الكلمات المطلوبة' }, limit: limitSchema },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args) => {
        const terms = requiredString(args, 'query', 500).toLowerCase().split(/\s+/).filter(Boolean);
        const results = querySharedAIMemory()
          .map((m) => {
            const haystack = [m.title, m.summaryAr, m.projectId, ...m.keyDecisionsAr].join(' ').toLowerCase();
            const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
            return { m, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
          .slice(0, readLimit(args))
          .map((x) => compactMemory(x.m));
        return JSON.stringify(results, null, 2);
      },
    },
    {
      name: 'second_brain_record_shared_memory',
      title: 'حفظ قرار أو ملخص في الذاكرة',
      description: 'يحفظ ملخص ما أُنجز والقرارات المهمة في الذاكرة المشتركة و Obsidian. لا تضع كلمات مرور أو مفاتيح (تُحذف تلقائياً).',
      inputSchema: {
        type: 'object',
        properties: {
          sourceAI: { type: 'string', enum: [...SOURCE_AI_VALUES] },
          projectId: { type: 'string' },
          title: { type: 'string' },
          summaryAr: { type: 'string', description: 'ملخص العمل بالعربية' },
          keyDecisionsAr: { type: 'array', items: { type: 'string' } },
        },
        required: ['sourceAI', 'projectId', 'title', 'summaryAr'],
        additionalProperties: false,
      },
      run: (args) => {
        const sourceAI = requiredString(args, 'sourceAI', 50);
        if (!(SOURCE_AI_VALUES as readonly string[]).includes(sourceAI)) {
          throw new McpInvalidParamsError(`sourceAI يجب أن يكون أحد: ${SOURCE_AI_VALUES.join(', ')}`);
        }
        const decisions = args.keyDecisionsAr;
        if (decisions !== undefined && (!Array.isArray(decisions) || decisions.some((d) => typeof d !== 'string'))) {
          throw new McpInvalidParamsError('keyDecisionsAr يجب أن تكون قائمة نصوص.');
        }
        // وضع القراءة (المرحلة ج): الذاكرة المشتركة يكتبها حامل صلاحية الكتابة فقط، وإلا ضاع التسجيل عند الاستيراد
        const access = checkWriteAccess();
        if (!access.allowed) throw new Error(`لم يُحفظ: ${access.reasonAr}`);
        const saved = recordSharedAIMemory({
          sourceAI: sourceAI as SharedAIMemoryEntry['sourceAI'],
          projectId: requiredString(args, 'projectId', 200),
          title: requiredString(args, 'title', 300),
          summaryAr: requiredString(args, 'summaryAr', 20000),
          keyDecisionsAr: ((decisions as string[] | undefined) ?? []).slice(0, 50).map((d) => d.slice(0, 2000)),
          // 4.0.1: القرارات اقتراحات في قائمة المراجعة، لا تدخل المعرفة إلا بموافقة القائد
          knowledgeReview: true,
        });
        // عقدة المحادثة واقتراحات القرارات الآن إن وُجدت النسخة المحلية من مفتاح المعرفة، وإلا عند فتح القائد التالي
        const kk = readDeviceKnowledgeKey();
        let knowledge: Record<string, unknown> = { added: false, noteAr: 'تُضاف إلى المعرفة عند فتح الخزنة التالي على هذا الجهاز.' };
        if (kk) {
          const r = migrateSharedMemoryToKnowledge(kk, [saved]);
          knowledge = { added: true, conversationNode: conversationNodeId(saved.id), pendingReview: r.createdReviews, noteAr: 'القرارات تنتظر موافقة القائد في «قائمة مراجعة المعرفة».' };
        }
        return JSON.stringify({ ok: true, id: saved.id, createdAt: saved.createdAt, knowledge });
      },
    },
    {
      name: 'second_brain_search_knowledge',
      title: 'بحث في المعرفة المترابطة',
      description: 'يبحث في عُقد المعرفة (القرارات، والحقائق، والمحادثات، والمهام…) بالعربية والإنجليزية. الساري أولاً، والمُستبدَل لا يظهر إلا بطلب. كل عقدة بمعرّفها وجيرانها المباشرين.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'الكلمات المطلوبة' },
          type: { type: 'string', enum: [...NODE_TYPES], description: 'نوع العقدة (اختياري)' },
          projectId: { type: 'string', description: 'معرّف المشروع (اختياري)' },
          includeSuperseded: { type: 'boolean', description: 'إظهار القرارات المُستبدَلة أيضاً' },
          limit: limitSchema,
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args) => {
        const query = requiredString(args, 'query', 500);
        const type = optionalString(args, 'type', 40);
        if (type && !(NODE_TYPES as readonly string[]).includes(type)) throw new McpInvalidParamsError(`type يجب أن يكون أحد: ${NODE_TYPES.join(', ')}`);
        if (args.includeSuperseded !== undefined && typeof args.includeSuperseded !== 'boolean') throw new McpInvalidParamsError('includeSuperseded يجب أن يكون true أو false.');
        const graph = openKnowledgeForMcp();
        const hits = searchKnowledge(graph, query, {
          types: type ? [type as KnowledgeNodeType] : undefined,
          projectId: optionalString(args, 'projectId', 200),
          includeSuperseded: args.includeSuperseded === true,
          limit: readLimit(args),
        });
        return JSON.stringify(
          hits.map((h) => ({ ...compactNode(h.node), score: h.score, neighbors: neighborsOf(graph, h.node.id).slice(0, 10).map((n) => ({ relation: n.edge.type, direction: n.direction, id: n.node.id, type: n.node.type, title: n.node.title })) })),
          null,
          2
        );
      },
    },
    {
      name: 'second_brain_get_decision_log',
      title: 'سجل القرارات',
      description: 'يعيد سجل القرارات لمشروع (أو لكل المشاريع): الأحدث أولاً، ولكل قرار المحادثة التي اتُّخذ فيها، وما استبدله وما استُبدل به، وما أثّر عليه. المُستبدَل يبقى بحالته.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'معرّف المشروع (اختياري)' }, limit: limitSchema },
        additionalProperties: false,
      },
      run: (args) => {
        const log = decisionLog(openKnowledgeForMcp(), optionalString(args, 'projectId', 200)).slice(0, readLimit(args));
        const brief = (n: KnowledgeNode) => ({ id: n.id, title: n.title, date: n.createdAt });
        return JSON.stringify(
          log.map((l) => ({ ...compactNode(l.decision), decidedIn: l.decidedIn.map(brief), supersedes: l.supersedes.map(brief), supersededBy: l.supersededBy.map(brief), affects: l.affects.map(brief) })),
          null,
          2
        );
      },
    },
  ];
}

/**
 * Hint بالعربي: دالة فتح المعرفة لخادم MCP بالنسخة المحلية من مفتاحها (بلا جلسة الخزنة).
 *               ترمي برسالة واضحة إن لم تتوفر، فتصل إلى أداة الذكاء خطأً مفهوماً.
 */
function openKnowledgeForMcp(): KnowledgeGraph {
  const kk = readDeviceKnowledgeKey();
  if (!kk) throw new Error('المعرفة غير متاحة الآن على هذا الجهاز: افتح الخزنة مرة في Second Brain، أو فعّل «المعرفة لأدوات الذكاء والخزنة مقفلة» في بطاقة «🧩 أدوات MCP».');
  return readKnowledgeGraph(kk);
}

/**
 * Hint بالعربي: تلخيص عقدة بشكل مضغوط لأداة الذكاء.
 */
export function compactNode(n: KnowledgeNode): Record<string, unknown> {
  return { id: n.id, type: n.type, title: n.title, body: n.body.length > 2000 ? `${n.body.slice(0, 2000)}…` : n.body, projectId: n.projectId, status: n.status, confidence: n.confidence, source: n.source, date: n.createdAt };
}

/**
 * Hint بالعربي: دالة بناء رد خطأ JSON-RPC.
 */
export function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Hint بالعربي: دالة معالجة رسالة JSON-RPC واحدة. المخرجات: الرد، أو null للإشعارات (لا يُرسل عليها رد).
 */
export function handleMcpJsonRpcRequest(request: unknown): Record<string, unknown> | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return jsonRpcError(null, -32600, 'طلب JSON-RPC غير صالح.');
  }
  const { id, method, params } = request as { id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
  const isNotification = id === undefined;
  if (typeof method !== 'string') return isNotification ? null : jsonRpcError(id, -32600, 'الحقل method مفقود.');
  if (isNotification || method.startsWith('notifications/')) return null;

  const ok = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize': {
      const info = (params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
      connectedClient = { name: typeof info.name === 'string' ? info.name : '', version: typeof info.version === 'string' ? info.version : '' };
      const requested = String(params?.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_MCP_VERSIONS.includes(requested) ? requested : SUPPORTED_MCP_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'second-brain-mcp', title: 'Second Brain', version: SERVER_VERSION },
        instructions:
          'ذاكرة Second Brain المشتركة: ابدأ بـ second_brain_get_commander_profile ثم second_brain_get_project_context للمشروع الحالي، وسجّل ملخص عملك وقراراتك في النهاية بـ second_brain_record_shared_memory.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: buildMcpTools().filter((t) => isMcpToolEnabled(t.name)).map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'tools/call': {
      const started = Date.now();
      const toolName = String(params?.name ?? '');
      const args = params?.arguments;
      const projectId = args && typeof args === 'object' && !Array.isArray(args) ? (args as ToolArgs).projectId : undefined;
      const audit = (result: McpAuditResult): void =>
        appendMcpAudit({ client: connectedClient.name, clientVersion: connectedClient.version, tool: toolName, projectId, result, durationMs: Date.now() - started });
      const tool = buildMcpTools().find((t) => t.name === toolName);
      if (!tool) {
        audit('unknown_tool');
        return jsonRpcError(id, -32602, `أداة غير معروفة: ${toolName}`);
      }
      if (!isMcpToolEnabled(toolName)) {
        audit('disabled');
        return ok({ content: [{ type: 'text', text: `الأداة ${toolName} معطّلة على هذا الجهاز من إعدادات Second Brain (صفحة «🔌 الربط»).` }], isError: true });
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        audit('invalid');
        return jsonRpcError(id, -32602, 'المعامل arguments يجب أن يكون كائناً.');
      }
      try {
        const text = tool.run((args as ToolArgs) ?? {});
        audit('ok');
        return ok({ content: [{ type: 'text', text }] });
      } catch (err) {
        if (err instanceof McpInvalidParamsError) {
          audit('invalid');
          return jsonRpcError(id, -32602, err.message);
        }
        audit('error');
        return ok({ content: [{ type: 'text', text: `خطأ أثناء تنفيذ الأداة: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
      }
    }
    default:
      return jsonRpcError(id, -32601, `الطريقة غير مدعومة: ${method}`);
  }
}

/** الفاصل الافتراضي لفحص تغيّر الأدوات المعطّلة (ISS-043) */
export const MCP_TOOL_WATCH_INTERVAL_MS = 2000;

/**
 * Hint بالعربي: بصمة الأدوات المعطّلة الآن (نص ثابت الترتيب) للمقارنة.
 */
export function disabledToolsFingerprint(): string {
  return [...readDisabledMcpTools()].sort().join('\n');
}

/**
 * Hint بالعربي: مراقب تغيّر الأدوات المعطّلة (ISS-043). يفحص الإعداد كل فترة، وعند أي تغيّر يرسل
 *               notifications/tools/list_changed فيعيد البرنامج طلب tools/list. لا يمنع إنهاء العملية (unref).
 *               المخرجات: دالة إيقاف.
 */
export function startMcpToolListWatcher(send: (message: Record<string, unknown>) => void, intervalMs: number = MCP_TOOL_WATCH_INTERVAL_MS): () => void {
  let last = disabledToolsFingerprint();
  const timer = setInterval(() => {
    const now = disabledToolsFingerprint();
    if (now === last) return;
    last = now;
    try {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch {
      // القناة أُغلقت: لا شيء نفعله
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Hint بالعربي: دالة معالجة سطر نصي واحد قادم عبر stdio. المخرجات: نص الرد أو null إذا لا يُرسل رد.
 */
export function processMcpLine(line: string): string | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return JSON.stringify(jsonRpcError(null, -32700, 'تعذر تحليل JSON.'));
  }
  const response = handleMcpJsonRpcRequest(parsed);
  return response ? JSON.stringify(response) : null;
}

// تشغيل خادم MCP عبر stdio عند استدعائه من Antigravity أو Claude Code
if (process.argv[1] && process.argv[1].endsWith('mcp-memory-server.ts')) {
  // أي طباعة عرضية تذهب إلى stderr حتى لا تُفسد قناة البروتوكول على stdout
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const watchMs = Number(process.env.SECOND_BRAIN_MCP_WATCH_MS) || MCP_TOOL_WATCH_INTERVAL_MS;
  const stopWatcher = startMcpToolListWatcher((message) => process.stdout.write(JSON.stringify(message) + '\n'), watchMs);
  rl.on('line', (line) => {
    const reply = processMcpLine(line);
    if (reply) process.stdout.write(reply + '\n');
  });
  // عند إغلاق الإدخال لا نستدعي process.exit: نترك البرنامج ينتهي طبيعياً بعد إرسال كل الردود
  // (على Windows قد تُقطع الكتابة غير المكتملة إلى القناة إذا أُنهي البرنامج فوراً).
  rl.on('close', () => {
    stopWatcher();
    process.stdin.unref?.();
  });
}
