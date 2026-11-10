/**
 * ============================================================================
 * الملف: tests/04-family-emergency.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر هذا الملف المساعد الذكي بوضعيه (القائد + وضع العائلة للزوجة)،
 *               ومولد كتيب الطوارئ المطبوع (Emergency Kit)، ونظام النسخ الاحتياطي
 *               المشفر الشامل وفك تشفيره.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { askSecondBrainAssistant } from '../src/features/assistant/assistant-engine.ts';
import {
  createEncryptedSystemBackup,
  verifyAndReadEncryptedBackup,
} from '../src/features/family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../src/features/family-emergency/emergency-kit-service.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات المساعد الذكي، وضع الطوارئ للزوجة، والنسخ الاحتياطي المشفر.
 */
export async function runFamilyEmergencyTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // 1. اختبار المساعد الذكي في وضع القائد
  const cmdReply = await askSecondBrainAssistant('ما هي حالة المشاريع والملفات الحساسة؟', 'commander');
  const projectName = loadSystemConfig().watchedProjects[0].name;
  assert.ok(cmdReply.answerAr.includes(projectName), 'يجب أن يتضمن رد القائد تفاصيل المشروع');
  passedChecks.push('اختبار عقل المساعد الذكي في (وضع القائد HUD) بنجاح.');

  // 2. اختبار المساعد الذكي في وضع العائلة/الزوجة (الفواتير + التعامل مع المبرمجين)
  const wifeBillingReply = await askSecondBrainAssistant('ما هي الفواتير المطلوبة؟', 'wife_emergency');
  assert.ok(wifeBillingReply.answerAr.includes('الفواتير'), 'يجب أن يشرح للزوجة تفاصيل الفواتير ببساطة');

  const wifeDevReply = await askSecondBrainAssistant('كيف أتعامل مع المبرمج لصيانة التطبيق؟', 'wife_emergency');
  assert.ok(wifeDevReply.answerAr.includes('لا تعطي المبرمج'), 'يجب أن يحذر الزوجة من إعطاء الحسابات الرئيسية للمبرمج');
  passedChecks.push('اختبار عقل المساعد الذكي في (وضع العائلة والطوارئ للزوجة) بنجاح.');

  // 3. اختبار توليد كتيب الطوارئ العائلي المطبوع (HTML/PDF + Markdown)
  const testEmergencyKey = 'SB-WIFE-SAFE-2026-KEY1';
  const kit = generatePrintableEmergencyKit(testEmergencyKey);
  assert.ok(fs.existsSync(kit.htmlFilePath), 'يجب توليد ملف كتيب الطوارئ القابل للطباعة');
  assert.ok(fs.existsSync(kit.markdownFilePath), 'يجب توليد ملخص كتيب الطوارئ');
  passedChecks.push('اختبار توليد وثيقة وكتيب الطوارئ العائلي الجاهز للطباعة (Emergency Kit) بنجاح.');

  // 4. اختبار إنشاء وفحص النسخة الاحتياطية المشفرة الشاملة (AES-256-GCM)
  const backup = createEncryptedSystemBackup(testEmergencyKey);
  assert.ok(fs.existsSync(backup.backupFilePath), 'يجب إنشاء ملف النسخة الاحتياطية المشفرة');
  assert.ok(backup.filesIncluded >= 5, 'يجب أن تشمل النسخة الاحتياطية ملفات Obsidian والخزنة');

  const verifiedSnapshot = verifyAndReadEncryptedBackup(backup.backupFilePath, testEmergencyKey);
  assert.equal(verifiedSnapshot.filesCount, backup.filesIncluded);
  passedChecks.push(
    `اختبار إنشاء وفك تشفير النسخة الاحتياطية الشاملة (${backup.filesIncluded} ملف مشفر بـ AES-256-GCM) بنجاح.`
  );

  return passedChecks;
}
