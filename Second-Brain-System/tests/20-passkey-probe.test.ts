/**
 * ============================================================================
 * الملف: tests/20-passkey-probe.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات قياس دعم Passkeys و PRF (الإصدار 3.2.0، بداية المرحلة 2.2 من docs/12):
 *               - التصنيف: PRF ثابت مع تحقق ← prf، و Passkey بلا PRF ← keystore، والإلغاء والعنوان الرقمي ← unsupported.
 *               - التقرير: قائمة بيضاء للحقول، ورفض أي حقل يشبه ناتج PRF، وأطوال محدودة.
 *               - المسارات: للقائد فقط، والتقرير يُحفظ على الجهاز بلا أي سر.
 *               - المشغّلات تفتح الواجهة على localhost (WebAuthn يرفض 127.0.0.1)، وفحص الصحة يبقى على 127.0.0.1.
 *               القياس الفعلي (نافذة الوجه أو البصمة) لا يُختبر آلياً: يجريه القائد على كل جهاز.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { classifyProbe, listProbeReports, normalizeProbeReport, resolveProbeDir } from '../src/features/auth/passkey-probe.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const INSTALL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install');

const OK_PRF = {
  requested: 'platform',
  userAgent: 'Mozilla/5.0 Chrome/131',
  platform: 'Windows',
  origin: 'http://localhost:4777',
  webauthn: true,
  platformAuthenticator: true,
  clientPrfCapability: true,
  created: true,
  attachment: 'platform',
  createPrfEnabled: true,
  getPrfReturned: true,
  prfLength: 32,
  prfStable: true,
  userVerified: true,
  errorName: null,
  errorStep: null,
};

/**
 * Hint بالعربي: دالة تشغيل اختبارات قياس Passkeys وإرجاع نتائج الفحص.
 */
export async function runPasskeyProbeTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // ===================== 1. التصنيف =====================
  const at = new Date('2026-11-18T12:00:00Z');
  assert.equal(normalizeProbeReport(OK_PRF, 'Asus', at).verdict, 'prf', 'PRF ثابت بطول 32 مع تحقق ← الطريقة الأولى');
  assert.equal(normalizeProbeReport({ ...OK_PRF, getPrfReturned: false, prfLength: 0, prfStable: false, createPrfEnabled: false }, 'Asus', at).verdict, 'keystore', 'بلا PRF ← البديل');
  assert.equal(normalizeProbeReport({ ...OK_PRF, prfStable: false }, 'Asus', at).verdict, 'keystore', 'PRF متغيّر ← لا يصلح مفتاحاً');
  assert.equal(normalizeProbeReport({ ...OK_PRF, userVerified: false }, 'Asus', at).verdict, 'unsupported', 'بلا تحقق من المستخدم ← لا يصلح');
  assert.equal(normalizeProbeReport({ ...OK_PRF, prfLength: 16 }, 'Asus', at).verdict, 'keystore', 'طول غير 32 ← لا يُعتمد');
  const cancelled = normalizeProbeReport({ ...OK_PRF, created: false, getPrfReturned: false, errorName: 'NotAllowedError', errorStep: 'create' }, 'Asus', at);
  assert.equal(cancelled.verdict, 'unsupported');
  assert.match(cancelled.verdictAr, /أُلغي/);
  const ipHost = classifyProbe({ webauthn: true, created: false, getPrfReturned: false, prfLength: 0, prfStable: false, userVerified: false, errorName: 'SecurityError', errorStep: 'create', origin: 'http://127.0.0.1:4777' });
  assert.equal(ipHost.verdict, 'unsupported');
  assert.match(ipHost.verdictAr, /localhost/, 'العنوان الرقمي: الرسالة تطلب localhost');
  assert.equal(normalizeProbeReport({ webauthn: false }, 'Asus', at).verdict, 'unsupported');
  passedChecks.push('اختبار تصنيف القياس (PRF ثابت ← الطريقة الأولى، وبلا PRF أو متغيّر ← مخزن مفاتيح النظام، وبلا تحقق أو ملغى أو على 127.0.0.1 ← غير صالح) بنجاح.');

  // ===================== 2. التقرير بلا أسرار =====================
  assert.throws(() => normalizeProbeReport({ ...OK_PRF, prfOutput: 'AAAA' }, 'Asus', at), /PRF/, 'ناتج PRF يُرفض');
  assert.throws(() => normalizeProbeReport({ ...OK_PRF, first: 'AAAA' }, 'Asus', at), /PRF/);
  const dirty = normalizeProbeReport({ ...OK_PRF, userAgent: 'x'.repeat(5000), errorName: 'EvilError<script>', errorStep: 'nowhere', extra: 'ignored', prfLength: 99999 } as Record<string, unknown>, 'Asus\u0007', at);
  assert.equal(dirty.userAgent.length, 300);
  assert.equal(dirty.errorName, 'Error', 'اسم خطأ غير معروف يُوحَّد');
  assert.equal(dirty.errorStep, null);
  assert.equal(dirty.prfLength, 0);
  assert.equal(dirty.deviceName, 'Asus ');
  assert.equal((dirty as unknown as Record<string, unknown>).extra, undefined, 'الحقول خارج القائمة لا تُحفظ');
  passedChecks.push('اختبار تقرير القياس (رفض أي حقل يشبه ناتج PRF، وقائمة بيضاء للحقول، وأطوال وأسماء أخطاء محدودة) بنجاح.');

  // ===================== 3. المسارات =====================
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await postJson(port, '/api/passkeys/probe/report', OK_PRF)).status, 401, 'بلا جلسة مرفوض');
    const { emergencyKey, masterPassword } = ensureTestVault();
    const login = await postJson(port, '/api/vault/unlock', { key: masterPassword });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const saved = await postJson(port, '/api/passkeys/probe/report', OK_PRF, cookie);
    assert.equal(saved.status, 200, saved.body);
    assert.equal((JSON.parse(saved.body) as { report: { verdict: string } }).report.verdict, 'prf');
    assert.equal((await postJson(port, '/api/passkeys/probe/report', { ...OK_PRF, prfOutput: 'x' }, cookie)).status, 400);
    const listed = JSON.parse((await rawRequest(port, { path: '/api/passkeys/probe/reports', headers: { Cookie: cookie } })).body) as { reports: Array<{ verdict: string }> };
    assert.equal(listed.reports[0]?.verdict, 'prf');
    assert.equal(listProbeReports().length, 1);
    const onDisk = fs.readdirSync(resolveProbeDir()).map((n) => fs.readFileSync(path.join(resolveProbeDir(), n), 'utf8')).join('');
    assert.ok(!/prfOutput|"first"/.test(onDisk), 'لا ناتج PRF على القرص');
    resetSessionStateForTests();
    const wife = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
    const wifeCookie = String(wife.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await postJson(port, '/api/passkeys/probe/report', OK_PRF, wifeCookie)).status, 403, 'جلسة العائلة لا تقيس');
    passedChecks.push('اختبار مسارات القياس (بلا جلسة 401، والعائلة 403، والقائد يحفظ ويسرد، ولا ناتج PRF على القرص) بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ===================== 4. المشغّلات على localhost =====================
  const ps1 = fs.readFileSync(path.join(INSTALL_DIR, 'windows', 'open-app.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(INSTALL_DIR, 'macos', 'open-app.sh'), 'utf8');
  assert.match(ps1, /\$url = "http:\/\/localhost:\$port\/"/, 'Windows يفتح localhost');
  assert.match(sh, /URL="http:\/\/localhost:\$PORT\/"/, 'الماك يفتح localhost');
  assert.match(sh, /HEALTH="http:\/\/127\.0\.0\.1:\$PORT\/api\/health"/, 'فحص الصحة على الماك يبقى 127.0.0.1');
  assert.match(fs.readFileSync(path.join(INSTALL_DIR, '..', '..', 'Launch-Second-Brain.bat'), 'utf8'), /Start-Process \('http:\/\/localhost:'/, 'ملف التشغيل يفتح localhost');
  passedChecks.push('اختبار المشغّلات (Windows والماك وملف التشغيل تفتح الواجهة على localhost، لأن Passkeys ترفض 127.0.0.1) بنجاح.');

  return passedChecks;
}
