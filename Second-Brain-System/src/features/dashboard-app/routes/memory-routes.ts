/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/memory-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الذاكرة المشتركة)
 * Hint بالعربي: سحب وأرشفة محادثات Antigravity و Claude Code داخل Obsidian.
 * ============================================================================
 */

import { harvestLocalAITranscripts } from '../../ai-memory/transcript-harvester.ts';
import { sendJson, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات الذاكرة المشتركة.
 */
export function getMemoryRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/memory/harvest',
      commanderOnly: true,
      handler: ({ res }) => {
        const harvested = harvestLocalAITranscripts();
        sendJson(res, 200, {
          ok: true,
          messageAr: `✅ تم سحب وأرشفة (${harvested.antigravityCount}) محادثة من Antigravity، واكتشاف (${harvested.claudeCodeCount}) مجلد مشاريع في Claude Code.`,
        });
      },
    },
  ];
}
