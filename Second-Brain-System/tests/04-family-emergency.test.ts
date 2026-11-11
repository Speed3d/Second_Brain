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
import { createEncryptedSystemBackup, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../src/features/family-emergency/emergency-kit-service.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات المساعد الذكي، وضع الطوارئ للزوجة، والنسخ الاحتياطي المشفر.
 */
export async function runFamilyEmergencyTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();

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

  // 4. النسخة الاحتياطية v2: تُفتح بمفتاح الطوارئ وبكلمة المرور الرئيسية
  const backup = createEncryptedSystemBackup(vault);
  assert.ok(fs.existsSync(backup.backupFilePath));
  assert.ok(backup.filesIncluded >= 5, 'يجب أن تشمل ملفات Obsidian والخزنة والإعدادات');
  const byKey = openEncryptedBackup(backup.backupFilePath, emergencyKey);
  const byPassword = openEncryptedBackup(backup.backupFilePath, TEST_MASTER_PASSWORD);
  assert.equal(byKey.filesCount, backup.filesIncluded);
  assert.equal(byPassword.filesCount, backup.filesIncluded);
  assert.ok(Object.keys(byKey.filesMap).includes('Second-Brain-System/config/branding.json'), 'يجب تضمين الإعدادات');
  passedChecks.push(
    `اختبار النسخة الاحتياطية v2 (${backup.filesIncluded} ملف) وفتحها بمفتاح الطوارئ وبكلمة المرور الرئيسية بنجاح.`
  );

  return passedChecks;
}
