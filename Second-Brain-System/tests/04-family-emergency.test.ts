/**
 * ============================================================================
 * الملف: tests/04-family-emergency.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر المساعد الذكي بوضعيه (القائد + العائلة)، وكتيب الطوارئ (يُولَّد في الذاكرة دون
 *               كتابة المفتاح على القرص)، والنسخة الاحتياطية v2 التي تُفتح بكلمة المرور أو بمفتاح الطوارئ.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { askSecondBrainAssistant } from '../src/features/assistant/assistant-engine.ts';
import { createEncryptedSystemBackup, isFamilyBackupEntry, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../src/features/family-emergency/emergency-kit-service.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات المساعد الذكي، وضع الطوارئ للزوجة، والنسخ الاحتياطي المشفر.
 */
export async function runFamilyEmergencyTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();

  // 0. ISS-021: البيئة المعزولة لا تحمل أي مجلد حقيقي للنسخ الإضافية ولا مزامنة حقيقية
  assert.ok(!config.security?.extraBackupDir, 'لا يجوز أن يشير اختبار إلى مجلد النسخ الإضافي الحقيقي');
  const isolatedSettings = JSON.parse(fs.readFileSync(process.env.SECOND_BRAIN_CONFIG_PATH!.replace(/branding\.json$/, 'settings.json'), 'utf-8'));
  assert.ok(!isolatedSettings.sync?.enabled, 'لا يجوز أن تكون المزامنة الحقيقية مفعّلة في الاختبارات');
  passedChecks.push('البيئة المعزولة لا تكتب نسخاً في مجلد النسخ الحقيقي ولا تزامن مع Drive الحقيقي (ISS-021).');

  // 1. المساعد الذكي في وضع القائد
  const cmdReply = await askSecondBrainAssistant('ما هي حالة المشاريع والملفات الحساسة؟', 'commander');
  assert.ok(cmdReply.answerAr.includes(config.watchedProjects[0].name), 'يجب أن يتضمن رد القائد تفاصيل المشروع');
  passedChecks.push('اختبار عقل المساعد الذكي في (وضع القائد) بنجاح.');

  // 2. المساعد الذكي في وضع العائلة (الفواتير + التعامل مع المبرمجين)
  const wifeBillingReply = await askSecondBrainAssistant('ما هي الفواتير المطلوبة؟', 'wife_emergency');
  assert.ok(wifeBillingReply.answerAr.includes('الفواتير'));
  const wifeDevReply = await askSecondBrainAssistant('كيف أتعامل مع المبرمج لصيانة التطبيق؟', 'wife_emergency');
  assert.ok(wifeDevReply.answerAr.includes('لا تعطي المبرمج'));
  passedChecks.push('اختبار عقل المساعد الذكي في (وضع العائلة والطوارئ) بنجاح.');

  // 3. كتيب الطوارئ: يحتوي المفتاح وخطوات الجهاز الجديد، ولا يُكتب أي ملف على القرص
  const { vault, emergencyKey } = ensureTestVault();
  const kitsDirBefore = fs.existsSync(config.paths.emergencyKitsDir) ? fs.readdirSync(config.paths.emergencyKitsDir).length : 0;
  const kitHtml = generatePrintableEmergencyKit(emergencyKey);
  assert.ok(kitHtml.includes(emergencyKey), 'يجب أن يحتوي الكتيب على مفتاح الطوارئ');
  assert.ok(kitHtml.includes('جهاز جديد'), 'يجب أن يشرح التشغيل على جهاز جديد');
  assert.ok(kitHtml.includes(config.paths.encryptedBackupsDir), 'يجب أن يذكر مكان النسخ الاحتياطية');
  const kitsDirAfter = fs.existsSync(config.paths.emergencyKitsDir) ? fs.readdirSync(config.paths.emergencyKitsDir).length : 0;
  assert.equal(kitsDirAfter, kitsDirBefore, 'يجب ألا يُكتب الكتيب (ولا المفتاح) على القرص');
  passedChecks.push('اختبار كتيب الطوارئ (المفتاح + مكان النسخ + خطوات الجهاز الجديد) دون كتابة أي ملف على القرص بنجاح.');

  // 4. النسخة الاحتياطية v3 (3.0.0): كلمة المرور تفتح الكل، ومفتاح الطوارئ يفتح الحمولة العائلية وحدها
  const backup = createEncryptedSystemBackup(vault);
  assert.ok(fs.existsSync(backup.backupFilePath));
  assert.ok(backup.filesIncluded >= 5, 'يجب أن تشمل ملفات Obsidian والخزنة والإعدادات');
  const rawBackup = JSON.parse(fs.readFileSync(backup.backupFilePath, 'utf8')) as { version: number; vaultKeys: Record<string, unknown> };
  assert.equal(rawBackup.version, 3);
  assert.equal(rawBackup.vaultKeys.emergencyWrap, undefined, 'لا غلاف طوارئ للحمولة الكاملة');
  const byKey = openEncryptedBackup(backup.backupFilePath, emergencyKey);
  const byPassword = openEncryptedBackup(backup.backupFilePath, TEST_MASTER_PASSWORD);
  assert.equal(byPassword.scope, 'full');
  assert.equal(byPassword.filesCount, backup.filesIncluded);
  assert.equal(byKey.scope, 'family');
  assert.ok(byKey.filesCount < byPassword.filesCount, 'الحمولة العائلية أصغر من الكاملة');
  const familyFiles = Object.keys(byKey.filesMap);
  assert.ok(familyFiles.includes('Second-Brain-System/config/branding.json'), 'يجب تضمين الهوية');
  assert.ok(familyFiles.includes('Second-Brain-System/config/settings.json'), 'يجب تضمين الإعدادات (المشاريع والفواتير)');
  assert.ok(familyFiles.some((f) => /encrypted-vault\/[^/]+\.json$/.test(f)), 'يجب تضمين ملف الخزنة (تفتح العائلة جزءها منه)');
  const leaked = familyFiles.filter((f) => !isFamilyBackupEntry(f) && !/data\/conversations\//.test(f));
  assert.deepEqual(leaked, [], 'لا يدخل الحمولة العائلية إلا ما تحتاجه العائلة');
  assert.ok(!familyFiles.some((f) => f.endsWith('ai-memory-store.json')), 'الذاكرة المشتركة لا تدخل الحمولة العائلية');
  passedChecks.push(
    `اختبار النسخة الاحتياطية v3 (${backup.filesIncluded} ملف): كلمة المرور تفتح الكل، ومفتاح الطوارئ يفتح الحمولة العائلية وحدها (${byKey.filesCount} ملف) بنجاح.`
  );

  return passedChecks;
}
