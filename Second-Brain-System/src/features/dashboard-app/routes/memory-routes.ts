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
      handler: ({ res, body }) => {
        const harvested = harvestLocalAITranscripts({ force: body.force === true });
        sendJson(res, 200, {
          ok: true,
          ...harvested,
          archivedFiles: harvested.archivedFiles.length,
          messageAr: `✅ تمت أرشفة ${harvested.claudeCodeCount} محادثة من Claude Code و ${harvested.antigravityCount} من Antigravity (جديدة أو محدَّثة)، وتُرك ${harvested.skippedUnchanged} دون تغيير${
            harvested.redactions ? `، وحُذف ${harvested.redactions} سر تلقائياً` : ''
          }${harvested.errors ? `، وتعذرت ${harvested.errors} جلسة (راجع السجل)` : ''}.`,
        });
      },
    },
  ];
}
