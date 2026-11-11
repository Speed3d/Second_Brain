/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/assistant-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المساعد الذكي)
 * Hint بالعربي: استقبال أسئلة القائد أو الزوجة وتمريرها لعقل المساعد الذكي.
 * ============================================================================
 */

import { askSecondBrainAssistant } from '../../assistant/assistant-engine.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات المساعد الذكي.
 */
export function getAssistantRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/assistant',
      handler: async ({ res, body }) => {
        const question = readString(body, 'question', 4000).trim();
        if (!question) throw new HttpError(400, 'يرجى كتابة السؤال.');
        const mode = body.mode === 'wife_emergency' ? 'wife_emergency' : 'commander';
        sendJson(res, 200, await askSecondBrainAssistant(question, mode));
      },
    },
  ];
}
