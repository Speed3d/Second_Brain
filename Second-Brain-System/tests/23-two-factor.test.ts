/**
 * ============================================================================
 * الملف: tests/23-two-factor.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المصادقة الثنائية والرموز الاحتياطية (الإصدار 3.5.0، المرحلة 2.3 من docs/12):
 *               - متجهات RFC 4226 (HOTP) و RFC 6238 (TOTP، SHA-1)، و Base32، ورابط otpauth، والنافذة ±1، ومنع إعادة الاستخدام.
 *               - الحالة داخل الخزنة: التفعيل برمز صحيح فقط، والرموز الاحتياطية (مجزّأة، لمرة واحدة، والتجديد يُبطل القديمة)،
 *                 والتعطيل، وعدم ظهورها للعائلة ولا في الاقتراحات، وأنها تُزامَن.
 *               - المسارات: التفعيل بكلمة المرور، وورقة الطباعة لمرة واحدة، والفتح بكلمة المرور يطلب الرمز، والرمز الخاطئ
 *                 يُحتسب فشلاً، والرمز الاحتياطي يعمل مرة واحدة، ومفتاح الطوارئ لا يطلب الرمز، والعنصر محمي من مسارات الأسرار.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import {
  BACKUP_CODE_COUNT,
  beginTwoFactorSetup,
  describeTwoFactor,
  disableTwoFactor,
  finishTwoFactorSetup,
  isTwoFactorEnabled,
  readTwoFactor,
  regenerateBackupCodes,
  resetTwoFactorPendingForTests,
  TWO_FACTOR_ID,
  verifySecondFactor,
} from '../src/features/auth/two-factor.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { readLocalRecords } from '../src/features/sync/records.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { suggestFamilySecrets } from '../src/features/vault/family-vault.ts';
import { createVault, unlockVault } from '../src/features/vault/vault-manager.ts';
import { base32Decode, base32Encode, buildOtpauthUri, hotp, totp, totpStep, verifyTotp } from '../src/shared/totp.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const PASS = 'Two-Factor-Test-Pass-01';

/**
 * Hint بالعربي: دالة تشغيل اختبارات المصادقة الثنائية وإرجاع نتائج الفحص.
 */
export async function runTwoFactorTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const base = path.join(config.paths.rootDir, 'two-factor-sim');
  fs.mkdirSync(base, { recursive: true });
  resetTwoFactorPendingForTests();

  // ===================== 1. متجهات RFC =====================
  const rfc = Buffer.from('12345678901234567890');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(rfc, c)),
    ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'],
    'RFC 4226، الملحق D'
  );
  assert.deepEqual(
    [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000].map((t) => totp(rfc, t * 1000, 8)),
    ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
    'RFC 6238، الملحق B (SHA-1)'
  );
  assert.equal(base32Encode(Buffer.from('48656c6c6f21deadbeef', 'hex')), 'JBSWY3DPEHPK3PXP');
  assert.equal(base32Decode('jbsw y3dp-ehpk 3pxp').toString('hex'), '48656c6c6f21deadbeef', 'Base32 يتسامح مع الحروف الصغيرة والمسافات');
  assert.throws(() => base32Decode('ABC1'), /Base32/);
  assert.equal(buildOtpauthUri(base32Decode('JBSWY3DPEHPK3PXP'), 'Asus'), 'otpauth://totp/Second%20Brain:Asus?secret=JBSWY3DPEHPK3PXP&issuer=Second%20Brain&algorithm=SHA1&digits=6&period=30');
  const now = Date.UTC(2026, 10, 18, 12, 0, 10);
  const s = base32Decode('JBSWY3DPEHPK3PXP');
  assert.equal(verifyTotp(s, totp(s, now), now), totpStep(now));
  assert.equal(verifyTotp(s, totp(s, now - 30000), now), totpStep(now) - 1, 'الخطوة السابقة مقبولة (فرق ساعة)');
  assert.equal(verifyTotp(s, totp(s, now + 30000), now), totpStep(now) + 1, 'والتالية');
  assert.equal(verifyTotp(s, totp(s, now - 90000), now), null, 'أبعد من ±1 مرفوض');
  assert.equal(verifyTotp(s, totp(s, now), now, { lastUsedStep: totpStep(now) }), null, 'الرمز المستخدم لا يُقبل مرة ثانية');
  assert.equal(verifyTotp(s, '12345', now), null);
  assert.equal(verifyTotp(s, 'abcdef', now), null);
  passedChecks.push('اختبار TOTP (متجهات RFC 4226 و RFC 6238، و Base32، ورابط otpauth، والنافذة ±1، ومنع إعادة استخدام الرمز) بنجاح.');

  // ===================== 2. الحالة داخل الخزنة =====================
  const vaultPath = path.join(base, 'vault', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const { vault, emergencyRecoveryKey } = createVault(PASS, vaultPath);
  assert.equal(isTwoFactorEnabled(vault), false);
  assert.throws(() => finishTwoFactorSetup(vault, '123456', now), /انتهت مهلة/, 'لا تفعيل بلا بداية');
  const setup = beginTwoFactorSetup(vault, 'Asus', now);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\/Second%20Brain:Asus\?secret=[A-Z2-7]{32}&/);
  assert.ok(setup.qrSvg.startsWith('<svg'), 'باركود الربط');
  const secret = base32Decode(setup.secretBase32);
  assert.equal(secret.length, 20, 'سرّ 160 بت');
  assert.throws(() => finishTwoFactorSetup(vault, '000000', now), /غير صحيح/, 'رمز خاطئ لا يفعّل');
  assert.throws(() => finishTwoFactorSetup(vault, totp(secret, now), now + 11 * 60 * 1000), /انتهت مهلة/, 'مهلة 10 دقائق');
  const setup2 = beginTwoFactorSetup(vault, 'Asus', now);
  const secret2 = base32Decode(setup2.secretBase32);
  const codes = finishTwoFactorSetup(vault, totp(secret2, now), now);
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  assert.equal(new Set(codes).size, BACKUP_CODE_COUNT, 'رموز مختلفة');
  assert.ok(codes.every((c) => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c)), 'شكل XXXXX-XXXXX بلا حروف ملتبسة');
  assert.equal(isTwoFactorEnabled(vault), true);
  assert.throws(() => beginTwoFactorSetup(vault, 'Asus', now), /مفعّلة بالفعل/);
  const stored = vault.secrets.find((x) => x.id === TWO_FACTOR_ID)!;
  assert.ok(codes.every((c) => !stored.secretValue.includes(c) && !stored.secretValue.includes(c.replace('-', ''))), 'الرموز الاحتياطية مجزّأة لا مكشوفة');
  assert.equal(stored.familyVisible, false);
  // التحقق: الرمز المستخدم في التفعيل لا يُقبل مرة ثانية، والتالي يُقبل
  assert.equal(verifySecondFactor(vault, totp(secret2, now), now).ok, false, 'رمز التفعيل لا يُعاد استخدامه');
  assert.equal(verifySecondFactor(vault, totp(secret2, now + 30000), now + 30000).method, 'totp');
  assert.equal(verifySecondFactor(vault, '', now).ok, false);
  // الرمز الاحتياطي: مرة واحدة، ويقبل الحروف الصغيرة وبلا شرطة
  const b1 = verifySecondFactor(vault, codes[0].toLowerCase().replace('-', ''), now);
  assert.equal(b1.method, 'backup');
  assert.equal(b1.backupLeft, 9);
  assert.equal(verifySecondFactor(vault, codes[0], now).ok, false, 'الرمز الاحتياطي لمرة واحدة');
  assert.equal(verifySecondFactor(vault, 'ZZZZZ-ZZZZZ', now).ok, false);
  // يبقى بعد إعادة الفتح (محفوظ في الخزنة)
  const reopened = unlockVault(PASS, vaultPath);
  assert.equal(describeTwoFactor(reopened).backupLeft, 9, 'الشطب محفوظ في الخزنة');
  // التجديد يُبطل القديمة
  const fresh = regenerateBackupCodes(reopened);
  assert.equal(verifySecondFactor(reopened, codes[1], now).ok, false, 'القديمة أُبطلت');
  assert.equal(verifySecondFactor(reopened, fresh[0], now).ok, true);
  // العائلة والاقتراحات
  const wife = unlockVault(emergencyRecoveryKey, vaultPath);
  assert.ok(!wife.secrets.some((x) => x.id === TWO_FACTOR_ID), 'لا يصل إلى الخزنة العائلية');
  assert.equal(isTwoFactorEnabled(wife), false, 'جلسة العائلة لا يُطلب منها رمز');
  assert.ok(!suggestFamilySecrets(reopened.secrets).some((x) => x.id === TWO_FACTOR_ID));
  // يُزامَن (سجل سرّ عادي مشفّر)
  const ctx = { device: { deviceId: 'd', deviceName: 'd', platform: 'test' }, syncRoot: base, rootDir: base, dataDir: path.join(base, 'none'), vaultFile: vaultPath, obsidianDir: path.join(base, 'none-obs'), brandingPath: path.join(base, 'nb.json'), settingsPath: path.join(base, 'ns.json') } as SyncContext;
  assert.ok(readLocalRecords(ctx, reopened).has(`secret:${TWO_FACTOR_ID}`), 'الحالة تُزامَن بين الأجهزة');
  assert.equal(disableTwoFactor(reopened), true);
  assert.equal(readTwoFactor(unlockVault(PASS, vaultPath)), null, 'التعطيل محفوظ');
  passedChecks.push('اختبار حالة المصادقة الثنائية (التفعيل برمز صحيح وفي المهلة، و10 رموز احتياطية مجزّأة لمرة واحدة، والتجديد يُبطل القديمة، والعائلة لا تراها، وتُزامَن، والتعطيل) بنجاح.');

  // ===================== 3. المسارات =====================
  resetSessionStateForTests();
  resetTwoFactorPendingForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  const { masterPassword, emergencyKey } = ensureTestVault();
  let cookie = '';
  const login = async (extra: Record<string, unknown> = {}) => postJson(port, '/api/vault/unlock', { key: masterPassword, ...extra });
  try {
    cookie = String((await login()).headers['set-cookie'] ?? '').split(';')[0];
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/2fa/status', headers: { Cookie: cookie } })).body).enabled, false);
    assert.equal((await postJson(port, '/api/2fa/setup/begin', { masterPassword: 'wrong-password-123' }, cookie)).status, 400);
    const b = JSON.parse((await postJson(port, '/api/2fa/setup/begin', { masterPassword }, cookie)).body);
    const sec = base32Decode(b.secretBase32);
    const fin = await postJson(port, '/api/2fa/setup/finish', { code: totp(sec, Date.now()) }, cookie);
    assert.equal(fin.status, 200, fin.body);
    const { codes: srvCodes, printUrl } = JSON.parse(fin.body) as { codes: string[]; printUrl: string };
    const page = await rawRequest(port, { path: printUrl });
    assert.equal(page.status, 200);
    assert.ok(srvCodes.every((c) => page.body.includes(c)), 'ورقة الطباعة فيها الرموز');
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.equal((await rawRequest(port, { path: printUrl })).status, 404, 'ورقة الطباعة لمرة واحدة');
    // الأسرار: العنصر لا يظهر ولا يُعدَّل ولا يُحذف من مسارات الأسرار
    const list = JSON.parse((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: cookie } })).body) as { secrets: Array<{ id: string }> };
    assert.ok(!list.secrets.some((x) => x.id === TWO_FACTOR_ID), 'لا يظهر في قائمة الأسرار');
    assert.equal((await postJson(port, '/api/vault/secrets', { id: TWO_FACTOR_ID, category: 'password', title: 'x', secretValue: 'y' }, cookie)).status, 400);
    assert.equal((await postJson(port, '/api/vault/secrets/delete', { id: TWO_FACTOR_ID }, cookie)).status, 400);
    await postJson(port, '/api/vault/lock', {}, cookie);
    resetSessionStateForTests();
    // الفتح بكلمة المرور يطلب الرمز
    const noCode = await login();
    assert.equal(noCode.status, 401);
    assert.equal(JSON.parse(noCode.body).twoFactorRequired, true);
    assert.equal(noCode.headers['set-cookie'], undefined, 'لا جلسة بلا الرمز');
    const wrong = await login({ twoFactorCode: '000000' });
    assert.equal(wrong.status, 401);
    const viaBackup = await login({ twoFactorCode: srvCodes[0] });
    assert.equal(viaBackup.status, 200, viaBackup.body);
    assert.match(String(JSON.parse(viaBackup.body).twoFactorNoteAr), /بقي 9/);
    resetSessionStateForTests();
    assert.equal((await login({ twoFactorCode: srvCodes[0] })).status, 401, 'الرمز الاحتياطي لمرة واحدة عبر الخادم');
    resetSessionStateForTests();
    const viaTotp = await login({ twoFactorCode: totp(sec, Date.now() + 30000) });
    assert.equal(viaTotp.status, 200, viaTotp.body);
    cookie = String(viaTotp.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/2fa/status', headers: { Cookie: cookie } })).body).backupLeft, 9);
    // مفتاح الطوارئ لا يطلب الرمز
    resetSessionStateForTests();
    assert.equal((await postJson(port, '/api/vault/unlock', { key: emergencyKey })).status, 200, 'العائلة بلا رمز');
    resetSessionStateForTests();
    // التأخير بعد 3 رموز خاطئة
    for (let i = 0; i < 3; i++) await login({ twoFactorCode: '111111' });
    assert.equal((await login({ twoFactorCode: totp(sec, Date.now()) })).status, 429, 'الرموز الخاطئة تُحتسب في التأخير');
    resetSessionStateForTests();
    // التعطيل
    const again = await login({ twoFactorCode: srvCodes[1] });
    cookie = String(again.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await postJson(port, '/api/2fa/disable', { masterPassword: 'wrong-password-123' }, cookie)).status, 400);
    assert.equal((await postJson(port, '/api/2fa/disable', { masterPassword }, cookie)).status, 200);
    resetSessionStateForTests();
    assert.equal((await login()).status, 200, 'بعد التعطيل: كلمة المرور وحدها');
    passedChecks.push('اختبار مسارات المصادقة الثنائية (التفعيل بكلمة المرور، وورقة طباعة لمرة واحدة، والفتح بكلمة المرور يطلب الرمز بلا جلسة، والرمز الاحتياطي لمرة واحدة، والتأخير بعد الخطأ، ومفتاح الطوارئ بلا رمز، والعنصر محمي، والتعطيل) بنجاح.');
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

  fs.rmSync(base, { recursive: true, force: true });
  return passedChecks;
}
