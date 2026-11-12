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
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { SharedAIMemoryEntry } from '../shared/types.ts';
import { redactSecrets } from '../shared/secret-redaction.ts';
import { loadSystemConfig } from '../core/config-manager.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../features/ai-memory/shared-memory-service.ts';
import { scanAndAnalyzeProject } from '../features/project-indexer/project-scanner.ts';

/** إصدارات البروتوكول المدعومة (الأحدث أولاً) */
export const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '2.0.0';
const SOURCE_AI_VALUES = ['antigravity-gemini', 'claude-code', 'second-brain-assistant', 'manual'] as const;

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
        const saved = recordSharedAIMemory({
          sourceAI: sourceAI as SharedAIMemoryEntry['sourceAI'],
          projectId: requiredString(args, 'projectId', 200),
          title: requiredString(args, 'title', 300),
          summaryAr: requiredString(args, 'summaryAr', 20000),
          keyDecisionsAr: ((decisions as string[] | undefined) ?? []).slice(0, 50).map((d) => d.slice(0, 2000)),
        });
        return JSON.stringify({ ok: true, id: saved.id, createdAt: saved.createdAt });
      },
    },
  ];
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
      const requested = String(params?.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_MCP_VERSIONS.includes(requested) ? requested : SUPPORTED_MCP_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'second-brain-mcp', title: 'Second Brain', version: SERVER_VERSION },
        instructions:
          'ذاكرة Second Brain المشتركة: ابدأ بـ second_brain_get_commander_profile ثم second_brain_get_project_context للمشروع الحالي، وسجّل ملخص عملك وقراراتك في النهاية بـ second_brain_record_shared_memory.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: buildMcpTools().map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'tools/call': {
      const toolName = String(params?.name ?? '');
      const tool = buildMcpTools().find((t) => t.name === toolName);
      if (!tool) return jsonRpcError(id, -32602, `أداة غير معروفة: ${toolName}`);
      const args = params?.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return jsonRpcError(id, -32602, 'المعامل arguments يجب أن يكون كائناً.');
      }
      try {
        return ok({ content: [{ type: 'text', text: tool.run((args as ToolArgs) ?? {}) }] });
      } catch (err) {
        if (err instanceof McpInvalidParamsError) return jsonRpcError(id, -32602, err.message);
        return ok({ content: [{ type: 'text', text: `خطأ أثناء تنفيذ الأداة: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
      }
    }
    default:
      return jsonRpcError(id, -32601, `الطريقة غير مدعومة: ${method}`);
  }
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
  rl.on('line', (line) => {
    const reply = processMcpLine(line);
    if (reply) process.stdout.write(reply + '\n');
  });
  // عند إغلاق الإدخال لا نستدعي process.exit: نترك البرنامج ينتهي طبيعياً بعد إرسال كل الردود
  // (على Windows قد تُقطع الكتابة غير المكتملة إلى القناة إذا أُنهي البرنامج فوراً).
  rl.on('close', () => {
    process.stdin.unref?.();
  });
}
