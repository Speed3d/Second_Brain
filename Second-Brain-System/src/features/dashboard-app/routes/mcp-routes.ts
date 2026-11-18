/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/mcp-routes.ts
 * القسم: Features -> Dashboard App -> Routes (أدوات MCP وسجل عملياتها، 3.8.0)
 * Hint بالعربي: عرض أدوات خادم الذاكرة المشتركة وحالة كل منها، وتفعيلها أو تعطيلها على هذا الجهاز،
 *               وآخر سطور سجل العمليات (بلا محتوى). كلها للقائد فقط.
 * ============================================================================
 */

import { readMcpAudit, isMcpToolEnabled, setMcpToolEnabled } from '../../ai-memory/mcp-controls.ts';
import { buildMcpTools } from '../../../tools/mcp-memory-server.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة إرجاع مسارات أدوات MCP.
 */
export function getMcpRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/mcp/tools',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        sendJson(res, 200, {
          tools: buildMcpTools().map((t) => ({ name: t.name, title: t.title, enabled: isMcpToolEnabled(t.name), writes: t.name === 'second_brain_record_shared_memory' })),
          audit: readMcpAudit(100),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/mcp/tools',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        const name = readString(body, 'name', 120);
        if (!buildMcpTools().some((t) => t.name === name)) throw new HttpError(400, 'أداة غير معروفة.');
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'حدد التفعيل أو التعطيل.');
        setMcpToolEnabled(name, body.enabled);
        sendJson(res, 200, { ok: true, messageAr: `${body.enabled ? '✅ فُعّلت' : '⛔ عُطّلت'} الأداة ${name} على هذا الجهاز. يسري ذلك فوراً على Claude Code و Antigravity.` });
      },
    },
  ];
}
