/**
 * ============================================================================
 * الملف: tests/02-project-indexer.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر هذا الملف ميزة التشريح التلقائي للمشاريع (Project Scanner)،
 *               وصائد الملفات الحساسة (Secret File Hunter)، وتوليد الوثائق الـ 6
 *               تلقائياً داخل مجلد Obsidian-Vault.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, registerWatchedProject } from '../src/core/config-manager.ts';
import { syncProjectToObsidianVault } from '../src/features/project-indexer/obsidian-sync.ts';
import { scanAndAnalyzeProject } from '../src/features/project-indexer/project-scanner.ts';
import { ensureTestVault } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات فحص المشاريع وصيد الملفات الحساسة ومزامنة Obsidian.
 */
export async function runProjectIndexerTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const mainProject = config.watchedProjects[0];

  // 1. اختبار تسجيل وتحديث المشروع المراقب
  registerWatchedProject(mainProject);
  passedChecks.push('اختبار تسجيل المشروع في قائمة المراقبة التلقائية بنجاح.');

  // 2. بدون خزنة مفتوحة: الملفات "مكتشفة" فقط ولا يُدّعى أنها مؤمَّنة
  const detectedOnly = scanAndAnalyzeProject(mainProject);
  assert.ok(detectedOnly.criticalFilesFound.every((f) => f.securedState === 'detected' && !f.vaultSecretId));

  // 3. مع خزنة مفتوحة: التشريح واكتشاف التقنيات وتأمين الملفات الحساسة فعلاً
  const { vault } = ensureTestVault();
  const scanReport = scanAndAnalyzeProject(mainProject, vault);
  assert.ok(scanReport.detectedStack.includes('TypeScript'), 'يجب أن يكتشف تقنية TypeScript في المشروع');
  assert.ok(scanReport.runCommands.length > 0, 'يجب أن يستخرج أوامر التشغيل من package.json');
  assert.ok(
    scanReport.criticalFilesFound.some((f) => f.relativePath === '.env'),
    'يجب أن يصطاد ملف الأسرار الحساس (.env) في المشروع التجريبي'
  );
  assert.ok(
    scanReport.criticalFilesFound.every((f) => typeof f.vaultSecretId === 'string' && f.securedState === 'secured'),
    'يجب أن يُشفَّر كل ملف حساس مكتشف داخل الخزنة'
  );
  assert.ok(
    scanAndAnalyzeProject(mainProject, vault).criticalFilesFound.every((f) => f.securedState === 'unchanged'),
    'إعادة الفحص دون تغيير لا تُنشئ نسخة جديدة'
  );
  passedChecks.push(
    `اختبار تشريح المشروع (${scanReport.projectName}): بدون خزنة "مكتشف فقط"، ومع الخزنة تأمين (${scanReport.criticalFilesFound.length}) ملف فعلياً دون تكرار عند إعادة الفحص.`
  );

  // 4. اختبار توليد وتحديث الملفات الـ 6 داخل Obsidian-Vault
  const obsidianProjectDir = syncProjectToObsidianVault(mainProject, scanReport);
  const expectedFiles = [
    '01-Overview.md',
    '02-Run-And-Update.md',
    '03-Critical-Files.md',
    '04-Infra-And-Billing.md',
    '05-Auto-Changelog.md',
    '06-Wife-Guide.md',
  ];
  for (const fileName of expectedFiles) {
    assert.ok(
      fs.existsSync(path.join(obsidianProjectDir, fileName)),
      `يجب أن يكون الملف ${fileName} موجوداً داخل Obsidian-Vault`
    );
  }
  passedChecks.push('اختبار توليد وثائق المشروع الـ 6 (بما فيها دليل التشغيل ودليل الزوجة) داخل Obsidian-Vault بنجاح.');

  return passedChecks;
}
