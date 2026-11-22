/**
 * ============================================================================
 * الملف: tests/29-security-review-leads.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات خيوط المراجعة الأمنية المستقلة للمرحلة 2 (2.9، ISS-046..ISS-053).
 *               كل خيط يُعاد إنتاجه هنا في البيئة المعزولة: إن فشل الفحص قبل الإصلاح صار الخلل مثبتاً،
 *               ويبقى الفحص بعد الإصلاح اختبار انحدار دائماً.
 *               - ISS-046: فحص صلاحيات مجلد البرنامج (مجلد حقيقي يُفتح للحسابات الأخرى ثم يُغلق)، وتحذير /api/health،
 *                 وإعادة فحص مسار Claude Code وعنوان Ollama عند تحميل الإعدادات.
 *               - ISS-047: فتح الإعدادات بكلمة المرور لا يمنح جلسة قائد بلا الرمز الثاني حين تكون 2FA مفعّلة.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, normalizeSystemConfig } from '../src/core/config-manager.ts';
import { checkFolderPermissions, findBroadWindowsWriters, getFolderPermissionStatus, resetFolderPermissionStatusForTests, runStartupFolderPermissionCheck } from '../src/core/folder-permissions.ts';
import { beginTwoFactorSetup, disableTwoFactor, finishTwoFactorSetup, readTwoFactor, resetTwoFactorPendingForTests } from '../src/features/auth/two-factor.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { unlockVault } from '../src/features/vault/vault-manager.ts';
import { base32Decode, totp } from '../src/shared/totp.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const cookieOf = (headers: Record<string, unknown>): string => String(headers['set-cookie'] ?? '').split(';')[0];

/**
 * Hint بالعربي: ISS-047 — مسار /api/settings/auth كان يفتح جلسة قائد بكلمة المرور وحدها رغم تفعيل 2FA.
 */
async function checkSettingsAuthSecondFactor(passedChecks: string[]): Promise<void> {
  resetSessionStateForTests();
  resetTwoFactorPendingForTests();
  const { vault, masterPassword, emergencyKey } = ensureTestVault();
  const now = Date.now();
  const setup = beginTwoFactorSetup(vault, 'Test', now - 60_000);
  const secret = base32Decode(setup.secretBase32);
  const codes = finishTwoFactorSetup(vault, totp(secret, now - 60_000), now - 60_000);
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // 1. بلا جلسة: كلمة المرور وحدها لا تكفي، ولا كوكي جلسة
    const bare = await postJson(port, '/api/settings/auth', { password: masterPassword });
    assert.equal(bare.status, 401, `ISS-047: كلمة المرور وحدها فتحت جلسة قائد (${bare.status})`);
    assert.equal(JSON.parse(bare.body).twoFactorRequired, true);
    assert.equal(bare.headers['set-cookie'], undefined, 'ISS-047: لا جلسة بلا الرمز الثاني');
    // ولا يمكن تعطيل 2FA عبر هذا الباب
    assert.equal((await postJson(port, '/api/2fa/disable', { masterPassword })).status, 401);
    // 2. رمز خاطئ مرفوض ويُحتسب فشلاً
    const wrong = await postJson(port, '/api/settings/auth', { password: masterPassword, twoFactorCode: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    resetSessionStateForTests();
    // 3. من جلسة عائلية: الترقية إلى القائد تطلب الرمز أيضاً
    const family = cookieOf((await postJson(port, '/api/vault/unlock', { key: emergencyKey })).headers);
    const fromFamily = await postJson(port, '/api/settings/auth', { password: masterPassword }, family);
    assert.equal(fromFamily.status, 401, 'ISS-047: جلسة العائلة ترقّت إلى القائد بكلمة المرور وحدها');
    // 4. مع رمز احتياطي صحيح: تُفتح جلسة قائد والإعدادات
    const ok = await postJson(port, '/api/settings/auth', { password: masterPassword, twoFactorCode: codes[0] });
    assert.equal(ok.status, 200, ok.body);
    const commander = cookieOf(ok.headers);
    assert.ok(commander, 'جلسة جديدة');
    assert.equal((await rawRequest(port, { path: '/api/settings', headers: { Cookie: commander } })).status, 200);
    // 5. جلسة قائد قائمة (فُتحت بالعاملين): إعادة التأكيد بكلمة المرور وحدها كافية، ولا جلسة جديدة
    await postJson(port, '/api/settings/lock', {}, commander);
    const reconfirm = await postJson(port, '/api/settings/auth', { password: masterPassword }, commander);
    assert.equal(reconfirm.status, 200, reconfirm.body);
    assert.equal(reconfirm.headers['set-cookie'], undefined, 'لا جلسة جديدة عند إعادة التأكيد');
    passedChecks.push('ISS-047: فتح الإعدادات بكلمة المرور لا يمنح جلسة قائد بلا الرمز الثاني (بلا جلسة، ومن جلسة العائلة، والرمز الخاطئ مرفوض)، والرمز الاحتياطي يعمل، وإعادة التأكيد داخل جلسة القائد بكلمة المرور وحدها.');
  } finally {
    try {
      const v = unlockVault(masterPassword);
      if (readTwoFactor(v)) disableTwoFactor(v);
    } catch {
      // لا شيء
    }
    resetSessionStateForTests();
    resetTwoFactorPendingForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Hint بالعربي: ISS-046 — مجلد البرنامج كان يرث صلاحية «تعديل لكل مستخدم مسجّل» من القرص بلا أي تحذير،
 *               ومسار Claude Code وعنوان Ollama يُقبلان من ملف الإعدادات بلا فحص عند التحميل.
 */
async function checkFolderPermissionLead(passedChecks: string[]): Promise<void> {
  // 1. تحليل أسطر Windows (بالمعرّفات، فلا تتأثر بلغة النظام)
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-11|1245631|Allow', 'S-1-5-32-545|1179817|Allow', 'S-1-5-18|2032127|Allow']), ['Authenticated Users'], 'Modify لـ Authenticated Users مفتوح، و RX لـ Users ليس كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-32-545|-1610612736|Allow']), [], 'GENERIC_READ|GENERIC_EXECUTE (الموروث IO) ليس كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-1-0|1073741824|Allow']), ['Everyone'], 'GENERIC_WRITE كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-1-0|2032127|Deny']), [], 'سطر المنع لا يُحتسب');
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-21-1-2-3-1001|2032127|Allow', 'S-1-5-32-544|2032127|Allow']), [], 'صاحب المجلد و Administrators ليسا حسابات عامة');

  // 2. مجلد حقيقي على هذا الجهاز: مغلق ← ثم يُفتح للحسابات الأخرى ← يُكشف
  const dir = path.join(loadSystemConfig().paths.rootDir, 'perm-sim');
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (process.platform === 'win32') {
      // مجلد الاختبار المؤقت داخل ملف المستخدم: موروث لصاحبه و SYSTEM و Administrators فقط
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore' });
      const closed = checkFolderPermissions(dir);
      assert.equal(closed.checked, true, closed.detailAr);
      assert.equal(closed.open, false, `مجلد مغلق كُشف مفتوحاً: ${closed.broadWriters.join(',')}`);
      execFileSync('icacls', [dir, '/grant', '*S-1-5-11:(OI)(CI)M'], { stdio: 'ignore' });
    } else {
      fs.chmodSync(dir, 0o700);
      assert.equal(checkFolderPermissions(dir).open, false);
      fs.chmodSync(dir, 0o777);
    }
    const open = checkFolderPermissions(dir);
    assert.equal(open.open, true, 'ISS-046: المجلد المفتوح للحسابات الأخرى لم يُكشف');
    assert.match(open.detailAr, /ISS-046/);
    // فشل القراءة لا يرمي ولا يدّعي الأمان
    const failed = checkFolderPermissions(dir, () => {
      throw new Error('x');
    });
    if (process.platform === 'win32') assert.equal(failed.checked, false);

    // 3. /api/health يحمل التحذير بعد فحص بدء الخادم، ولا يحمله قبل الفحص
    assert.equal(getFolderPermissionStatus(), null, 'لا فحص في الاختبارات إلا بطلب');
    runStartupFolderPermissionCheck(dir);
    const server = await startSecondBrainDesktopServer(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const health = JSON.parse((await rawRequest(port, { path: '/api/health' })).body) as { folderPermissions: { open: boolean; detailAr: string } | null };
      assert.equal(health.folderPermissions?.open, true, '/api/health يحمل التحذير');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    resetFolderPermissionStatusForTests();
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4. إعادة الفحص عند التحميل: ملف الإعدادات قد يُعدَّل خارج الواجهة
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const absExe = path.join(path.parse(process.cwd()).root, 'tools', exe);
  const load = (ai: Record<string, unknown>) => normalizeSystemConfig({ aiConfig: ai });
  const planted = load({ claudeCliPath: path.join(path.parse(process.cwd()).root, 'Users', 'Public', 'evil.exe'), ollamaEndpoint: 'http://evil.example:11434' });
  assert.equal(planted.config.aiConfig.claudeCliPath, '', 'ISS-046: برنامج مزروع باسم آخر لا يُشغَّل كـ Claude Code');
  assert.equal(planted.config.aiConfig.ollamaEndpoint, 'http://127.0.0.1:11434', 'ISS-046: عنوان Ollama خارجي لا يُقبل من الملف');
  assert.equal(planted.warnings.length, 2, planted.warnings.join(' | '));
  assert.equal(load({ claudeCliPath: `relative/${exe}` }).config.aiConfig.claudeCliPath, '', 'مسار نسبي مرفوض');
  assert.equal(load({ claudeCliPath: absExe }).config.aiConfig.claudeCliPath, absExe, 'المسار الصحيح يبقى');
  assert.equal(load({ ollamaEndpoint: 'http://localhost:11500/x' }).config.aiConfig.ollamaEndpoint, 'http://localhost:11500');
  assert.equal(load({ ollamaEndpoint: 'https://127.0.0.1:11434' }).config.aiConfig.ollamaEndpoint, 'http://127.0.0.1:11434', 'https مرفوض كما في مسار الحفظ');

  passedChecks.push('ISS-046: فحص صلاحيات مجلد البرنامج (أقنعة NTFS بالمعرّفات، ومجلد حقيقي مغلق ثم مفتوح للحسابات الأخرى يُكشف، وفشل القراءة لا يدّعي الأمان)، وتحذير /api/health، وإعادة فحص مسار Claude Code وعنوان Ollama عند تحميل الإعدادات.');
}

/**
 * Hint بالعربي: معرّف حساب المستخدم الحالي على Windows (لاختبار مجلد مغلق لصاحبه).
 */
function currentUserSid(): string {
  const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf-8' });
  const sid = out.match(/S-1-5-[\d-]+/);
  if (!sid) throw new Error('تعذّر قراءة معرّف المستخدم.');
  return sid[0];
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات خيوط المراجعة الأمنية وإرجاع نتائج الفحص.
 */
export async function runSecurityReviewLeadsTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  await checkFolderPermissionLead(passedChecks);
  await checkSettingsAuthSecondFactor(passedChecks);
  return passedChecks;
}
