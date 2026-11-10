/**
 * ============================================================================
 * الملف: src/tools/mcp-memory-server.ts
 * القسم: Tools (الأدوات المستقلة — خادم الذاكرة المشتركة MCP)
 * Hint بالعربي: يعمل هذا الملف كخادم بروتوكول سياق النماذج (MCP Server) لربط
 *               Google Antigravity (Gemini) و Claude Code بذاكرة واحدة مشتركة
 *               تقرأ وتكتب مباشرة داخل Obsidian Vault.
 * ============================================================================
 */

import * as readline from 'node:readline';
import { loadSystemConfig } from '../core/config-manager.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../features/ai-memory/shared-memory-service.ts';
import { scanAndAnalyzeProject } from '../features/project-indexer/project-scanner.ts';

/**
 * Hint بالعربي: دالة معالجة طلبات بروتوكول JSON-RPC 2.0 الخاصة بـ MCP
 * وتوفر 3 أدوات ذكية لكل من Antigravity و Claude Code.
 */
export function handleMcpJsonRpcRequest(request: {
  jsonrpc?: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}): Record<string, unknown> {
  const id = request.id ?? 1;

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'second-brain-mcp',
          version: '1.0.0',
        },
      },
    };
  }

  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'second_brain_get_commander_and_projects_context',
            description: 'جلب هوية القائد، القوانين الثمانية الصارمة، وتفاصيل كافة المشاريع المراقبة وطرق تشغيلها.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'second_brain_recall_shared_memory',
            description: 'البحث في الذاكرة المشتركة للمحادثات والقرارات السابقة بين Antigravity و Claude Code.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'معرف المشروع (اختياري)' },
              },
            },
          },
          {
            name: 'second_brain_record_shared_memory',
            description: 'حفظ قرار برمجي أو ملخص محادثة جديدة في الذاكرة المشتركة وملفات Obsidian.',
            inputSchema: {
              type: 'object',
              required: ['sourceAI', 'projectId', 'title', 'summaryAr'],
              properties: {
                sourceAI: { type: 'string', enum: ['antigravity-gemini', 'claude-code', 'second-brain-assistant'] },
                projectId: { type: 'string' },
                title: { type: 'string' },
                summaryAr: { type: 'string' },
                keyDecisionsAr: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        ],
      },
    };
  }

  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    const toolName = String(params.name ?? '');
    const args = (params.arguments as Record<string, unknown>) ?? {};

    if (toolName === 'second_brain_get_commander_and_projects_context') {
      const config = loadSystemConfig();
      const projectReports = config.watchedProjects.map((p) => scanAndAnalyzeProject(p));
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                commander: config.commanderName,
                strictLawsCount: 8,
                projects: projectReports,
              }),
            },
          ],
        },
      };
    }

    if (toolName === 'second_brain_recall_shared_memory') {
      const memories = querySharedAIMemory(args.projectId ? String(args.projectId) : undefined);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(memories) }],
        },
      };
    }

    if (toolName === 'second_brain_record_shared_memory') {
      const saved = recordSharedAIMemory({
        sourceAI: (args.sourceAI as 'antigravity-gemini' | 'claude-code' | 'second-brain-assistant') ?? 'antigravity-gemini',
        projectId: String(args.projectId ?? 'general'),
        title: String(args.title ?? 'تحديث ذاكرة'),
        summaryAr: String(args.summaryAr ?? ''),
        keyDecisionsAr: Array.isArray(args.keyDecisionsAr) ? args.keyDecisionsAr.map(String) : [],
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(saved) }],
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `الطريقة غير مدعومة: ${request.method}` },
  };
}

// تشغيل خادم MCP عبر stdio عند استدعائه من Antigravity أو Claude Code
if (process.argv[1] && process.argv[1].endsWith('mcp-memory-server.ts')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const req = JSON.parse(line);
      const res = handleMcpJsonRpcRequest(req);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch {
      // تجاهل الأسطر غير الصالحة
    }
  });
}
