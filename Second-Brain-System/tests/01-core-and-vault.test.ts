/**
 * ============================================================================
 * الملف: tests/01-core-and-vault.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر طبقة النواة (الإعدادات والهوية، محرك التشفير، مفتاح الطوارئ وخانة التحقق)
 *               والخزنة v2: الفتح بكلمة المرور أو بمفتاح الطوارئ، الحفظ، وتأمين الملفات الحساسة
 *               مع النسخ التاريخية واسترجاعها.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, updateBrandingIdentity } from '../src/core/config-manager.ts';
import {
  decryptWithAes256Gcm,
  encryptWithAes256Gcm,
  generateEmergencyRecoveryKey,
  isValidEmergencyKey,
  normalizeEmergencyKey,
} from '../src/core/crypto-engine.ts';
import {
  backupCriticalFileToVault,
  restoreCriticalFileFromVault,
  unlockVault,
  upsertVaultSecret,
} from '../src/features/vault/vault-manager.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات النواة والخزنة المشفرة وإرجاع قائمة بنتائج الفحص.
 */
export async function runCoreAndVaultTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  assert.ok(config.appName.length > 0, 'يجب أن يتم تحميل اسم البرنامج من الإعدادات');

  // 1. مرونة تغيير الهوية (White-Label Branding)
  const tempBrandPath = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'test-branding.json');
  updateBrandingIdentity({ assistantNameAr: 'العقل الثاني الذكي' }, tempBrandPath);
  assert.equal(loadSystemConfig(tempBrandPath).assistantNameAr, 'العقل الثاني الذكي');
  fs.unlinkSync(tempBrandPath);
  passedChecks.push('اختبار مرونة تغيير اسم البرنامج والهوية (White-Label Branding) بنجاح.');

  // 2. محرك التشفير بكلمة مرور (مع حفظ معاملات scrypt داخل الحزمة)
  const sampleSecret = 'حساب البنك والإيميل الرئيسي: SuperSecret#2026';
  const encrypted = encryptWithAes256Gcm(sampleSecret, TEST_MASTER_PASSWORD);
  assert.equal(encrypted.kdf?.N, 131072, 'يجب استخدام scrypt بمعامل N = 2^17');
  assert.equal(decryptWithAes256Gcm(encrypted, TEST_MASTER_PASSWORD), sampleSecret);
  assert.throws(() => decryptWithAes256Gcm(encrypted, 'wrong-password-123'));
  passedChecks.push('اختبار محرك التشفير (AES-256-GCM + scrypt N=2^17) ورفض كلمة المرور الخاطئة بنجاح.');

  // 3. مفتاح الطوارئ: 128 بت + خانة تحقق تكتشف أخطاء الكتابة + قبول الأحرف الصغيرة والمسافات
  const sampleKey = generateEmergencyRecoveryKey();
  assert.match(sampleKey, /^SB-(?:[0-9A-F]{4}-){8}[0-9A-F]{4}$/);
  assert.ok(isValidEmergencyKey(sampleKey));
  assert.ok(isValidEmergencyKey(sampleKey.toLowerCase().replace(/-/g, ' ')), 'يجب قبول الأحرف الصغيرة والمسافات');
  const typo = sampleKey.slice(0, 3) + (sampleKey[3] === 'A' ? 'B' : 'A') + sampleKey.slice(4);
  assert.equal(isValidEmergencyKey(typo), false, 'يجب أن تكتشف خانة التحقق خطأ الكتابة');
  passedChecks.push('اختبار مفتاح الطوارئ (128 بت + خانة تحقق تكتشف أخطاء الكتابة) بنجاح.');

  // 4. الخزنة v2: الفتح بكلمة المرور وبمفتاح الطوارئ (حتى لو كُتب بأحرف صغيرة ومسافات)
  const { vault, emergencyKey } = ensureTestVault();
  upsertVaultSecret(vault, {
    id: 'SEC-MAIN-EMAIL',
    category: 'email_account',
    title: 'الإيميل الرسمي الرئيسي للمشاريع',
    usernameOrEmail: 'owner@example.test',
    secretValue: 'Test-Only-Email-Pass',
    notesForCommanderAr: 'الإيميل الأساسي المربوط بكل الحسابات',
    notesForWifeAr: 'هذا أهم إيميل؛ من خلاله يمكن استعادة أي حساب.',
  });
  assert.equal(unlockVault(TEST_MASTER_PASSWORD).unlockedBy, 'commander');
  const byWife = unlockVault(normalizeEmergencyKey(emergencyKey.toLowerCase().replace(/-/g, ' ')));
  assert.equal(byWife.unlockedBy, 'wife_emergency');
  assert.equal(byWife.secrets.find((s) => s.id === 'SEC-MAIN-EMAIL')?.usernameOrEmail, 'owner@example.test');
  assert.throws(() => unlockVault('wrong-password-123'));
  passedChecks.push('اختبار الخزنة v2 (فتح بكلمة المرور + فتح بمفتاح الطوارئ + رفض المفتاح الخاطئ) بنجاح.');

  // 5. تأمين ملف حساس مع نسخ تاريخية، واسترجاعه بمفتاح الطوارئ دون الكتابة فوق ملف موجود
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const dummyEnvPath = path.join(dataDir, 'sample.env');
  const restoredEnvPath = path.join(dataDir, 'restored.env');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dummyEnvPath, 'DATABASE_URL=postgres://test-only@localhost/db\n', 'utf-8');

  const first = backupCriticalFileToVault(vault, 'test-project', dummyEnvPath, 'ملف بيئة تجريبي');
  assert.equal(first.changed, true);
  assert.equal(backupCriticalFileToVault(vault, 'test-project', dummyEnvPath, 'ملف بيئة تجريبي').changed, false, 'الملف غير المتغير لا يُحفظ مرتين');
  fs.writeFileSync(dummyEnvPath, 'DATABASE_URL=postgres://test-only-v2@localhost/db\n', 'utf-8');
  assert.equal(backupCriticalFileToVault(vault, 'test-project', dummyEnvPath, 'ملف بيئة تجريبي').changed, true);
  assert.equal(vault.secrets.find((s) => s.id === first.secretId)?.fileVersions?.length, 1, 'يجب حفظ النسخة السابقة');

  const wifeVault = unlockVault(emergencyKey);
  restoreCriticalFileFromVault(wifeVault, first.secretId, restoredEnvPath);
  assert.ok(fs.readFileSync(restoredEnvPath, 'utf-8').includes('test-only-v2'));
  assert.throws(() => restoreCriticalFileFromVault(wifeVault, first.secretId, restoredEnvPath), 'لا يكتب فوق ملف موجود');
  fs.unlinkSync(dummyEnvPath);
  fs.unlinkSync(restoredEnvPath);
  passedChecks.push('اختبار تأمين ملف حساس بنسخ تاريخية واسترجاعه بمفتاح الطوارئ دون الكتابة فوق ملف موجود بنجاح.');

  return passedChecks;
}
