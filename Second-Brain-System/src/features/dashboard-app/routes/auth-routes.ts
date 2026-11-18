/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/auth-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الدخول بالبصمة أو رمز الجهاز: القياس 3.2.0، والدخول 3.3.0)
 * Hint بالعربي: - قياس دعم Passkeys و PRF (3.2.0، للقائد): حفظ وسرد التقارير، بلا أي سر.
 *               - الدخول بالبصمة أو رمز الجهاز (3.3.0، التصميم «أ»): التسجيل بكلمة المرور، والفتح بلا جلسة
 *                 بنفس حماية فتح الخزنة (التأخير بعد الفشل)، والقائمة والحذف. الأغلفة محلية على هذا الجهاز.
 * ============================================================================
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import { listProbeReports, normalizeProbeReport, saveProbeReport } from '../../auth/passkey-probe.ts';
import { readDeviceInfo } from '../../sync/sync-context.ts';
import { beginRegistration, beginUnlock, countUsablePasskeys, finishRegistration, finishUnlock, listLocalPasskeys, removeLocalPasskey, type RegistrationResponse, type UnlockResponse } from '../../auth/passkey-store.ts';
import { syncOnUnlock } from '../../sync/sync-service.ts';
import { vaultExists, verifyMasterPassword } from '../../vault/vault-manager.ts';
import { buildSessionCookie, HttpError, readString, sendJson, type RouteContext, type RouteDefinition } from '../http-utils.ts';
import { openVaultSession, recordUnlockFailure, recordUnlockSuccess } from '../session-manager.ts';
import { assertUnlockAllowed } from './vault-routes.ts';

function portOf(ctx: RouteContext): number {
  return ctx.req.socket.localPort ?? 0;
}

function deviceName(): string {
  try {
    return readDeviceInfo(path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data'))?.deviceName ?? os.hostname();
  } catch {
    return os.hostname();
  }
}

/**
 * Hint بالعربي: دالة إرجاع مسارات قياس Passkeys.
 */
export function getAuthRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/passkeys/probe/report',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        let report;
        try {
          report = normalizeProbeReport(body, deviceName());
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        saveProbeReport(report);
        sendJson(res, 200, { ok: true, report });
      },
    },
    {
      // هل يوجد Passkey صالح على هذا الجهاز؟ (لإظهار زر الفتح؛ العدد فقط)
      method: 'GET',
      path: '/api/passkeys/status',
      handler: ({ res }) => {
        let count = 0;
        try {
          count = vaultExists() ? countUsablePasskeys() : 0;
        } catch {
          count = 0;
        }
        sendJson(res, 200, { count });
      },
    },
    {
      method: 'GET',
      path: '/api/passkeys',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        countUsablePasskeys();
        sendJson(res, 200, { passkeys: listLocalPasskeys() });
      },
    },
    {
      method: 'POST',
      path: '/api/passkeys/register/begin',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (!verifyMasterPassword(readString(body, 'masterPassword', 512), vault.vaultFilePath)) throw new HttpError(400, 'كلمة المرور الرئيسية غير صحيحة.');
        try {
          sendJson(res, 200, beginRegistration(vault, readString(body, 'label', 80)));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'POST',
      path: '/api/passkeys/register/finish',
      requiresSession: true,
      commanderOnly: true,
      handler: (ctx) => {
        let saved;
        try {
          saved = finishRegistration(ctx.session!.vault, portOf(ctx), ctx.body as unknown as RegistrationResponse);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        sendJson(ctx.res, 200, { ok: true, ...saved, messageAr: `👆 سُجّل «${saved.label}» على هذا الجهاز. يمكنك الآن فتح الخزنة به.` });
      },
    },
    {
      method: 'POST',
      path: '/api/passkeys/delete',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        if (!removeLocalPasskey(readString(body, 'credentialId', 2000))) throw new HttpError(404, 'الـ Passkey غير موجود على هذا الجهاز.');
        sendJson(res, 200, { ok: true, messageAr: '🗑️ أُلغي الـ Passkey على هذا الجهاز. (يبقى محفوظاً في مدير كلمات المرور حتى تحذفه هناك.)' });
      },
    },
    {
      method: 'POST',
      path: '/api/passkeys/unlock/begin',
      handler: ({ res }) => {
        assertUnlockAllowed();
        if (!vaultExists()) throw new HttpError(404, 'لا توجد خزنة بعد.');
        try {
          sendJson(res, 200, beginUnlock());
        } catch (err) {
          throw new HttpError(404, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'POST',
      path: '/api/passkeys/unlock/finish',
      handler: (ctx) => {
        assertUnlockAllowed();
        let vault;
        try {
          vault = finishUnlock(portOf(ctx), ctx.body as unknown as UnlockResponse);
        } catch (err) {
          recordUnlockFailure();
          throw new HttpError(401, err instanceof Error ? err.message : String(err));
        }
        recordUnlockSuccess();
        const sync = syncOnUnlock(vault);
        const token = openVaultSession(vault);
        sendJson(ctx.res, 200, { ok: true, unlockedBy: vault.unlockedBy, secretsCount: vault.secrets.length, syncMessageAr: sync.messageAr ?? null }, { 'Set-Cookie': buildSessionCookie(token) });
      },
    },
    {
      method: 'GET',
      path: '/api/passkeys/probe/reports',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        sendJson(res, 200, { reports: listProbeReports() });
      },
    },
  ];
}
