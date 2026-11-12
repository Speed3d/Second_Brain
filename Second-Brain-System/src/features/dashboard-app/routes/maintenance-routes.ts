/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/maintenance-routes.ts
 * القسم: Features -> Dashboard App -> Routes (وضع التطوير والتصفير)
 * Hint بالعربي: مسارات التصفير إلى السلة، واسترجاع آخر تصفير، وإفراغ السلة، والاعتماد النهائي.
 *               كل مسار يتطلب صلاحية الإعدادات (كلمة المرور الرئيسية في هذه الزيارة للقسم)،
 *               والعمليات الخطرة تتطلب كتابة عبارة التأكيد. بعد الاعتماد النهائي (إطفاء وضع التطوير)
 *               يرفض الخادم كل عمليات التصفير والاسترجاع، ولا يمكن إعادة تفعيله من الواجهة.
 * ============================================================================
 */

import { updateSystemSettings } from '../../../core/config-manager.ts';
import { logSystemInfo } from '../../../core/logger.ts';
import {
  emptyTrash,
  EMPTY_TRASH_CONFIRM_PHRASE,
  FINALIZE_CONFIRM_PHRASE,
  isDeveloperModeEnabled,
  listTrashBatches,
  matchesConfirmPhrase,
  RESET_CONFIRM_PHRASE,
  resetToTrash,
  restoreLastBatch,
} from '../../maintenance/reset-service.ts';
import { buildSessionCookie, HttpError, sendJson, type RouteDefinition } from '../http-utils.ts';
import { closeVaultSession } from '../session-manager.ts';
import { assertSettingsAuth } from './state-routes.ts';

/**
 * Hint بالعربي: دالة رفض الطلب إذا كان وضع التطوير مطفأً (بعد الاعتماد النهائي).
 */
export function assertDeveloperMode(): void {
  if (!isDeveloperModeEnabled()) throw new HttpError(403, 'وضع التطوير مطفأ (اعتُمد البرنامج نهائياً)؛ التصفير غير متاح.');
}

/**
 * Hint بالعربي: دالة التحقق من عبارة التأكيد أو رمي خطأ يوضح العبارة المطلوبة.
 */
export function assertConfirmPhrase(input: unknown, phrase: string): void {
  if (!matchesConfirmPhrase(input, phrase)) throw new HttpError(400, `اكتب عبارة التأكيد كما هي: «${phrase}»`);
}

/**
 * Hint بالعربي: دالة إرجاع مسارات الصيانة ووضع التطوير.
 */
export function getMaintenanceRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/maintenance',
      handler: ({ res, session }) => {
        assertSettingsAuth(session);
        sendJson(res, 200, {
          developerMode: isDeveloperModeEnabled(),
          phrases: { reset: RESET_CONFIRM_PHRASE, emptyTrash: EMPTY_TRASH_CONFIRM_PHRASE, finalize: FINALIZE_CONFIRM_PHRASE },
          trash: listTrashBatches().map((b) => ({ id: b.id, kind: b.kind, createdAt: b.createdAt, itemCount: b.items.length })),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/maintenance/reset',
      handler: ({ res, body, session }) => {
        assertSettingsAuth(session);
        assertDeveloperMode();
        assertConfirmPhrase(body.confirm, RESET_CONFIRM_PHRASE);
        closeVaultSession();
        const manifest = resetToTrash();
        logSystemInfo('Maintenance', `تصفير إلى السلة: ${manifest.items.length} عنصر (${manifest.id}).`);
        sendJson(
          res,
          200,
          { ok: true, batchId: manifest.id, itemCount: manifest.items.length, messageAr: `🧹 صُفّر البرنامج. نُقل ${manifest.items.length} عنصر إلى السلة ويمكن استرجاعها.` },
          { 'Set-Cookie': buildSessionCookie(null) }
        );
      },
    },
    {
      method: 'POST',
      path: '/api/maintenance/restore-last',
      handler: ({ res, session }) => {
        assertSettingsAuth(session);
        assertDeveloperMode();
        closeVaultSession();
        const restored = restoreLastBatch();
        logSystemInfo('Maintenance', `استرجاع دفعة من السلة: ${restored.id}.`);
        sendJson(
          res,
          200,
          { ok: true, batchId: restored.id, messageAr: '♻️ استُرجعت آخر حالة من السلة. الحالة التي كانت قبلها محفوظة في السلة أيضاً.' },
          { 'Set-Cookie': buildSessionCookie(null) }
        );
      },
    },
    {
      method: 'POST',
      path: '/api/maintenance/empty-trash',
      handler: ({ res, body, session }) => {
        assertSettingsAuth(session);
        assertDeveloperMode();
        assertConfirmPhrase(body.confirm, EMPTY_TRASH_CONFIRM_PHRASE);
        const count = emptyTrash();
        logSystemInfo('Maintenance', `إفراغ السلة نهائياً: ${count} دفعة.`);
        sendJson(res, 200, { ok: true, messageAr: `🗑️ أُفرغت السلة نهائياً (${count} دفعة).` });
      },
    },
    {
      method: 'POST',
      path: '/api/maintenance/finalize',
      handler: ({ res, body, session }) => {
        assertSettingsAuth(session);
        assertDeveloperMode();
        assertConfirmPhrase(body.confirm, FINALIZE_CONFIRM_PHRASE);
        updateSystemSettings({ developerMode: false });
        logSystemInfo('Maintenance', 'اعتماد نهائي: أُطفئ وضع التطوير.');
        sendJson(res, 200, { ok: true, messageAr: '✅ اعتُمد البرنامج نهائياً وأُطفئ وضع التطوير. زر التصفير لم يعد متاحاً. السلة الحالية تبقى كما هي.' });
      },
    },
  ];
}
