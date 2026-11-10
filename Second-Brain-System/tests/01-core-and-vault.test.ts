/**
 * ============================================================================
 * الملف: tests/01-core-and-vault.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر هذا الملف طبقة النواة (Core) ومحرك التشفير العسكري AES-256-GCM
 *               وميزة الخزنة السرية المزدوجة (فتح الخزنة بكلمة مرور القائد أو بمفتاح طوارئ الزوجة)
 *               بالإضافة إلى تأمين واسترجاع الملفات الحساسة.
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
} from '../src/core/crypto-engine.ts';
import {
  backupCriticalFileToVault,
  initializeEncryptedVault,
  restoreCriticalFileFromVault,
  unlockAndReadVault,
  upsertVaultSecret,
} from '../src/features/vault/vault-manager.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات النواة والخزنة المشفرة وإرجاع قائمة بنتائج الفحص.
 */
export async function runCoreAndVaultTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  assert.ok(config.appName.length > 0, 'يجب أن يتم تحميل اسم البرنامج من الإعدادات');

  // 1. اختبار مرونة تغيير الهوية (White-Label Branding)
  const tempBrandPath = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'test-branding.json');
  updateBrandingIdentity({ assistantNameAr: 'العقل الثاني الذكي' }, tempBrandPath);
  const reloadedBrand = loadSystemConfig(tempBrandPath);
  assert.equal(reloadedBrand.assistantNameAr, 'العقل الثاني الذكي');
  if (fs.existsSync(tempBrandPath)) fs.unlinkSync(tempBrandPath);
  passedChecks.push('اختبار مرونة تغيير اسم البرنامج والهوية (White-Label Branding) بنجاح.');

  // 2. اختبار التشفير وفك التشفير AES-256-GCM
  const sampleSecret = 'حساب البنك والإيميل الرئيسي: SuperSecret#2026';
  const masterPass = 'Commander-Master-Pass-999';
  const encrypted = encryptWithAes256Gcm(sampleSecret, masterPass);
  const decrypted = decryptWithAes256Gcm(encrypted, masterPass);
  assert.equal(decrypted, sampleSecret, 'النص المفكوك يجب أن يطابق النص الأصلي تماماً');
  passedChecks.push('اختبار محرك التشفير العسكري (AES-256-GCM + Scrypt) بنجاح.');

  // 3. اختبار الخزنة المزدوجة (فتح بكلمة مرور القائد + فتح بمفتاح الطوارئ للزوجة)
  const emergencyKey = generateEmergencyRecoveryKey();
  assert.ok(emergencyKey.startsWith('SB-'), 'مفتاح الطوارئ يجب أن يبدأ بـ SB-');

  initializeEncryptedVault(masterPass, [], emergencyKey);
  upsertVaultSecret(
    {
      id: 'SEC-MAIN-EMAIL',
      category: 'email_account',
      title: 'الإيميل الرسمي الرئيسي للمشاريع',
      usernameOrEmail: 'commander@projects.dev',
      secretValue: 'MyStrongEmailPass!2026',
      notesForCommanderAr: 'الإيميل الأساسي المربوط بكل الحسابات',
      notesForWifeAr: 'هذا أهم إيميل؛ من خلاله يمكن استعادة أي حساب أو متجر تطبيقات.',
      updatedAt: new Date().toISOString(),
    },
    masterPass,
    emergencyKey
  );

  const unlockedByCmd = unlockAndReadVault(masterPass);
  assert.equal(unlockedByCmd.unlockedBy, 'commander');
  assert.ok(unlockedByCmd.secrets.length >= 1);

  const unlockedByWife = unlockAndReadVault(emergencyKey);
  assert.equal(unlockedByWife.unlockedBy, 'wife_emergency');
  assert.equal(unlockedByWife.secrets[0].usernameOrEmail, 'commander@projects.dev');
  passedChecks.push('اختبار الخزنة المزدوجة (فتح بصلاحية القائد + فتح بمفتاح طوارئ الزوجة) بنجاح.');

  // 4. اختبار تشفير واسترجاع ملف حساس (.env) من الخزنة
  const dummyEnvPath = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'sample.env');
  const restoredEnvPath = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'restored.env');
  fs.writeFileSync(dummyEnvPath, 'DATABASE_URL=postgres://secret:1234@localhost:5432/db\n', 'utf-8');

  const fileSecretId = backupCriticalFileToVault(
    'second-brain',
    dummyEnvPath,
    'ملف بيئة تجريبي للاختبار',
    masterPass,
    emergencyKey
  );
  restoreCriticalFileFromVault(fileSecretId, emergencyKey, restoredEnvPath);
  const restoredContent = fs.readFileSync(restoredEnvPath, 'utf-8');
  assert.ok(restoredContent.includes('DATABASE_URL=postgres://secret'));

  if (fs.existsSync(dummyEnvPath)) fs.unlinkSync(dummyEnvPath);
  if (fs.existsSync(restoredEnvPath)) fs.unlinkSync(restoredEnvPath);
  passedChecks.push('اختبار تشفير ملف حساس (.env) داخل الخزنة واسترجاعه بمفتاح الطوارئ بنجاح.');

  return passedChecks;
}
