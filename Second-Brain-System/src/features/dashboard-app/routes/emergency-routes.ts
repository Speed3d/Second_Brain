/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/emergency-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الطوارئ والنسخ الاحتياطي)
 * Hint بالعربي: طباعة كتيب الطوارئ (صفحة تُعرض مرة واحدة ولا تُحفظ على القرص)، إنشاء النسخ
 *               الاحتياطية المشفرة، سردها، واستعادتها إلى مجلد جديد (تعمل حتى بدون خزنة على الجهاز).
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import { isValidEmergencyKey } from '../../../core/crypto-engine.ts';
import { createEncryptedSystemBackup, listEncryptedBackups, restoreEncryptedBackup } from '../../family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../../family-emergency/emergency-kit-service.ts';
import { verifyEmergencyKey } from '../../vault/vault-manager.ts';
import { HttpError, readString, sendHtml, sendJson, type RouteDefinition } from '../http-utils.ts';
import { getUnlockRetryAfterMs, recordUnlockFailure, recordUnlockSuccess } from '../session-manager.ts';
import { assertUnlockAllowed } from './vault-routes.ts';

/** صفحات الطباعة المؤقتة: تُعرض مرة واحدة خلال دقيقتين ثم تُحذف من الذاكرة */
const pendingPrintPages = new Map<string, { html: string; nonce: string; expiresAt: number }>();
const PRINT_PAGE_TTL_MS = 2 * 60 * 1000;

/**
 * Hint بالعربي: دالة حذف صفحات الطباعة المنتهية من الذاكرة.
 */
export function purgeExpiredPrintPages(): void {
  const now = Date.now();
  for (const [token, page] of pendingPrintPages) {
    if (page.expiresAt < now) pendingPrintPages.delete(token);
  }
}

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات الطوارئ والنسخ الاحتياطي.
 */
export function getEmergencyRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/emergency/kit',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        const emergencyKey = readString(body, 'emergencyKey', 200);
        if (!isValidEmergencyKey(emergencyKey)) {
          throw new HttpError(400, 'شكل مفتاح الطوارئ غير صحيح (تحقق من الحروف وخانة التحقق الأخيرة).');
        }
        if (!verifyEmergencyKey(emergencyKey)) {
          throw new HttpError(400, 'هذا المفتاح لا يفتح الخزنة الحالية، فلن يُطبع حتى لا تحصل زوجتك على مفتاح خاطئ.');
        }
        purgeExpiredPrintPages();
        const token = crypto.randomBytes(24).toString('hex');
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = generatePrintableEmergencyKit(emergencyKey, {
          personalMessageAr: readString(body, 'personalMessageAr', 4000).trim() || undefined,
          scriptNonce: nonce,
        });
        pendingPrintPages.set(token, { html, nonce, expiresAt: Date.now() + PRINT_PAGE_TTL_MS });
        sendJson(res, 200, { ok: true, printUrl: `/emergency-kit/print/${token}` });
      },
    },
    {
      method: 'GET',
      path: /^\/emergency-kit\/print\/([0-9a-f]{48})$/,
      handler: ({ res, params }) => {
        purgeExpiredPrintPages();
        const page = pendingPrintPages.get(params[0]);
        if (!page) throw new HttpError(404, 'انتهت صلاحية صفحة الطباعة. ولّد الكتيب من جديد.');
        pendingPrintPages.delete(params[0]);
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        sendHtml(res, 200, page.html, csp);
      },
    },
    {
      method: 'POST',
      path: '/api/emergency/backup',
      requiresSession: true,
      handler: ({ res, session }) => {
        const result = createEncryptedSystemBackup(session!.vault);
        sendJson(res, 200, {
          ok: true,
          ...result,
          messageAr: `✅ تم إنشاء نسخة احتياطية مشفرة (${result.filesIncluded} ملف)${
            result.extraCopyPath ? ' ونسخة إضافية في المجلد الاحتياطي' : ''
          }.`,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/emergency/backups',
      handler: ({ res }) => {
        sendJson(res, 200, { backupsDir: loadSystemConfig().paths.encryptedBackupsDir, backups: listEncryptedBackups() });
      },
    },
    {
      method: 'POST',
      path: '/api/emergency/restore',
      handler: ({ res, body }) => {
        assertUnlockAllowed();
        const backupFile = readString(body, 'backupFile', 1000).trim();
        const key = readString(body, 'key', 512);
        const targetDir = readString(body, 'targetDir', 1000).trim();
        if (!backupFile || !key) throw new HttpError(400, 'يرجى تحديد ملف النسخة ومفتاح الفتح.');
        const dryRun = body.dryRun !== false;
        if (!dryRun && !targetDir) throw new HttpError(400, 'يرجى تحديد مجلد جديد للاستعادة.');
        let result;
        try {
          result = restoreEncryptedBackup(path.resolve(backupFile), key, targetDir || path.dirname(path.resolve(backupFile)), { dryRun });
        } catch (err) {
          if (err instanceof Error && err.message.includes('غير صحيح')) {
            recordUnlockFailure();
            throw new HttpError(401, err.message, { retryAfterSeconds: Math.ceil(getUnlockRetryAfterMs() / 1000) });
          }
          throw err;
        }
        recordUnlockSuccess();
        sendJson(res, 200, { ok: true, ...result, filesCount: result.files.length, files: result.files.slice(0, 200) });
      },
    },
  ];
}
