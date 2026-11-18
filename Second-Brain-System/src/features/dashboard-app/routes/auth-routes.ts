/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/auth-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الدخول بالبصمة أو رمز الجهاز: القياس 3.2.0، والدخول 3.3.0)
 * Hint بالعربي: - قياس دعم Passkeys و PRF (3.2.0، للقائد): حفظ وسرد التقارير، بلا أي سر.
 *               - الدخول بالبصمة أو رمز الجهاز (3.3.0، التصميم «أ»): التسجيل بكلمة المرور، والفتح بلا جلسة
 *                 بنفس حماية فتح الخزنة (التأخير بعد الفشل)، والقائمة والحذف. الأغلفة محلية على هذا الجهاز.
 *               - المصادقة الثنائية (3.5.0): التفعيل بباركود، والتعطيل، ورموز احتياطية جديدة، وورقة طباعتها
 *                 (صفحة تُعرض مرة واحدة خلال دقيقتين ولا تُحفظ على القرص). كلها للقائد وبكلمة المرور.
 * ============================================================================
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import { listProbeReports, normalizeProbeReport, saveProbeReport } from '../../auth/passkey-probe.ts';
import { readDeviceInfo } from '../../sync/sync-context.ts';
import { beginRegistration, beginUnlock, countUsablePasskeys, finishRegistration, finishUnlock, listLocalPasskeys, removeLocalPasskey, type RegistrationResponse, type UnlockResponse } from '../../auth/passkey-store.ts';
import { syncOnUnlock } from '../../sync/sync-service.ts';
import * as crypto from 'node:crypto';
import { beginTwoFactorSetup, describeTwoFactor, disableTwoFactor, finishTwoFactorSetup, regenerateBackupCodes } from '../../auth/two-factor.ts';
import { escapeHtml } from '../../../shared/html-helpers.ts';
import { sendHtml } from '../http-utils.ts';
import { vaultExists, verifyMasterPassword } from '../../vault/vault-manager.ts';
import { buildSessionCookie, HttpError, readString, sendJson, type RouteContext, type RouteDefinition } from '../http-utils.ts';
import { openVaultSession, recordUnlockFailure, recordUnlockSuccess } from '../session-manager.ts';
import { assertUnlockAllowed } from './vault-routes.ts';

/** صفحات طباعة الرموز الاحتياطية: مرة واحدة خلال دقيقتين، في الذاكرة فقط */
const pendingCodePages = new Map<string, { html: string; nonce: string; expiresAt: number }>();
const CODE_PAGE_TTL_MS = 2 * 60 * 1000;

/**
 * Hint بالعربي: صفحة طباعة الرموز الاحتياطية (ورقة منفصلة للقائد، لا كتيب العائلة).
 */
export function buildBackupCodesPage(codes: string[], deviceLabel: string, nonce: string, now: Date = new Date()): string {
  const rows = codes.map((c, i) => `<li><span class="n">${i + 1}</span><code>${escapeHtml(c)}</code><span class="box"></span></li>`).join('');
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>الرموز الاحتياطية — Second Brain</title>
<style>body{font-family:'Segoe UI',Tahoma,sans-serif;color:#0f172a;padding:28px;line-height:1.7}.card{max-width:720px;margin:0 auto;border:2px solid #0f172a;border-radius:14px;padding:24px}h1{margin-top:0}ol{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}li{display:flex;align-items:center;gap:10px;border:1px solid #cbd5e1;border-radius:8px;padding:8px 12px}.n{color:#64748b;width:1.5em}code{direction:ltr;font-family:Consolas,monospace;font-size:19px;letter-spacing:1px;flex:1;white-space:nowrap}.box{width:18px;height:18px;border:2px solid #0f172a;border-radius:3px}.warn{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px}@media print{.no-print{display:none}body{padding:0}.card{border:none}}</style></head>
<body><div class="card"><h1>🔑 الرموز الاحتياطية للمصادقة الثنائية</h1>
<p><strong>للقائد وحده.</strong> كل رمز يُستخدم <strong>مرة واحدة</strong> بدل الرقم ذي الستة أرقام، إن ضاع الهاتف أو تعطّل تطبيق المصادقة. ضع ✓ في المربع بعد استخدامه.</p>
<ol>${rows}</ol>
<p class="warn">⚠️ احفظ الورقة في مكان آمن <strong>منفصل</strong> عن كتيب العائلة وعن كلمة المرور. الرموز لا تفتح شيئاً وحدها: تلزم معها كلمة المرور الرئيسية. إنشاء رموز جديدة يُبطل هذه كلها.</p>
<p style="color:#64748b;font-size:13px">أُنشئت ${escapeHtml(now.toISOString().slice(0, 10))} · ${escapeHtml(deviceLabel)}</p>
<p class="no-print"><button id="p" type="button">🖨️ طباعة</button></p></div>
<script nonce="${escapeHtml(nonce)}">document.getElementById('p').addEventListener('click',function(){window.print();});</script></body></html>`;
}

function stashCodesPage(codes: string[]): string {
  const now = Date.now();
  for (const [k, v] of pendingCodePages) if (v.expiresAt < now) pendingCodePages.delete(k);
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  pendingCodePages.set(token, { html: buildBackupCodesPage(codes, deviceName(), nonce), nonce, expiresAt: now + CODE_PAGE_TTL_MS });
  return `/two-factor/print/${token}`;
}

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
      path: '/api/2fa/status',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        sendJson(res, 200, describeTwoFactor(session!.vault));
      },
    },
    {
      method: 'POST',
      path: '/api/2fa/setup/begin',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (!verifyMasterPassword(readString(body, 'masterPassword', 512), vault.vaultFilePath)) throw new HttpError(400, 'كلمة المرور الرئيسية غير صحيحة.');
        try {
          sendJson(res, 200, beginTwoFactorSetup(vault, deviceName()));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'POST',
      path: '/api/2fa/setup/finish',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        let codes: string[];
        try {
          codes = finishTwoFactorSetup(session!.vault, readString(body, 'code', 20));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        sendJson(res, 200, { ok: true, codes, printUrl: stashCodesPage(codes), messageAr: '🔐 فُعّلت المصادقة الثنائية. اطبع الرموز الاحتياطية الآن واحفظها منفصلة عن كتيب العائلة.' });
      },
    },
    {
      method: 'POST',
      path: '/api/2fa/backup-codes',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (!verifyMasterPassword(readString(body, 'masterPassword', 512), vault.vaultFilePath)) throw new HttpError(400, 'كلمة المرور الرئيسية غير صحيحة.');
        let codes: string[];
        try {
          codes = regenerateBackupCodes(vault);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        sendJson(res, 200, { ok: true, codes, printUrl: stashCodesPage(codes), messageAr: '🔑 أُنشئت رموز احتياطية جديدة، وأُبطلت القديمة كلها. اطبعها الآن.' });
      },
    },
    {
      method: 'POST',
      path: '/api/2fa/disable',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (!verifyMasterPassword(readString(body, 'masterPassword', 512), vault.vaultFilePath)) throw new HttpError(400, 'كلمة المرور الرئيسية غير صحيحة.');
        if (!disableTwoFactor(vault)) throw new HttpError(400, 'المصادقة الثنائية غير مفعّلة.');
        sendJson(res, 200, { ok: true, messageAr: '🔓 عُطّلت المصادقة الثنائية، على هذا الجهاز وعلى الأجهزة الأخرى بعد المزامنة. يمكنك حذف الحساب من تطبيق المصادقة.' });
      },
    },
    {
      method: 'GET',
      path: /^\/two-factor\/print\/([0-9a-f]{48})$/,
      handler: ({ res, params }) => {
        const now = Date.now();
        const page = pendingCodePages.get(params[0]);
        pendingCodePages.delete(params[0]);
        if (!page || page.expiresAt < now) throw new HttpError(404, 'انتهت صلاحية صفحة الطباعة. أنشئ رموزاً جديدة.');
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        sendHtml(res, 200, page.html, csp);
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
