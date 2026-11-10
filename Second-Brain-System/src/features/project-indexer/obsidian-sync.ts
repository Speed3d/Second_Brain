/**
 * ============================================================================
 * الملف: src/features/project-indexer/obsidian-sync.ts
 * القسم: Features -> Project Indexer (ميزة مزامنة وتحديث ملفات Obsidian تلقائياً)
 * Hint بالعربي: يقوم هذا الملف بتحويل نتائج فحص المشروع إلى 6 وثائق Markdown
 *               مرتبة ومترابطة داخل مجلد المشروع في Obsidian-Vault، بما فيها
 *               دليل التشغيل التقني ودليل الإدارة المبسط للزوجة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectScanReport, WatchedProjectConfig } from '../../shared/types.ts';
import { ensureDirectoryExists, writeTextFileSafe } from '../../shared/file-helpers.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة لتوليد وتحديث جميع ملفات المشروع الـ 6 داخل Obsidian-Vault تلقائياً.
 */
export function syncProjectToObsidianVault(
  projectConfig: WatchedProjectConfig,
  scanReport: ProjectScanReport,
  customObsidianDir?: string
): string {
  const config = loadSystemConfig();
  const obsidianRoot = customObsidianDir ?? config.paths.obsidianVaultDir;
  const projectFolder = path.join(obsidianRoot, '02-Projects', projectConfig.name);
  ensureDirectoryExists(projectFolder);
  ensureDirectoryExists(path.join(projectFolder, 'AI-Conversations'));

  // 1. ملف نظرة عامة (01-Overview.md)
  const overviewMd = `# 🚀 نظرة عامة على المشروع: ${projectConfig.name}

> **معرّف المشروع:** \`${projectConfig.id}\`  
> **المسار على الحاسوب:** \`${projectConfig.path}\`  
> **آخر فحص تلقائي:** \`${scanReport.scannedAt}\`

---

## 📌 وصف المشروع والهدف منه
${projectConfig.descriptionAr}

## 🛠️ التقنيات واللغات المكتشفة تلقائياً
${scanReport.detectedStack.map((s) => `* **${s}**`).join('\n')}

## 📂 أهم الملفات الهندسية في المشروع
${scanReport.importantFiles.length > 0 ? scanReport.importantFiles.map((f) => `* \`${f}\``).join('\n') : '* ملفات المشروع القياسية'}

---

## 🔗 روابط وثائق هذا المشروع
* [[02-Projects/${projectConfig.name}/02-Run-And-Update|⚙️ طريقة التشغيل والبناء والتحديث]]
* [[02-Projects/${projectConfig.name}/03-Critical-Files|🔐 الملفات الحساسة المؤمنة في الخزنة]]
* [[02-Projects/${projectConfig.name}/04-Infra-And-Billing|💰 الفواتير والاستضافة والدخل]]
* [[02-Projects/${projectConfig.name}/05-Auto-Changelog|🕒 سجل التحديثات التلقائي]]
* [[02-Projects/${projectConfig.name}/06-Wife-Guide|❤️ دليل المشروع المبسط لزوجتي]]
`;
  writeTextFileSafe(path.join(projectFolder, '01-Overview.md'), overviewMd);

  // 2. ملف طريقة التشغيل والتحديث (02-Run-And-Update.md)
  const runAndUpdateMd = `# ⚙️ طريقة التشغيل والتحديث: ${projectConfig.name}

## 1️⃣ أوامر تشغيل المشروع (Run Commands)
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.runCommands.join('\n')}
\`\`\`

## 2️⃣ أوامر البناء والفحص (Build & Test Commands)
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.buildCommands.length > 0 ? scanReport.buildCommands.join('\n') : '# لا توجد أوامر بناء منفصلة'}
\`\`\`

## 3️⃣ خطوات تحديث المشروع (Update Procedure)
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.updateCommands.join('\n')}
\`\`\`
`;
  writeTextFileSafe(path.join(projectFolder, '02-Run-And-Update.md'), runAndUpdateMd);

  // 3. ملف الملفات الحساسة التي لا تعوض (03-Critical-Files.md)
  const critRows =
    scanReport.criticalFilesFound.length > 0
      ? scanReport.criticalFilesFound
          .map(
            (c) =>
              `| \`${c.relativePath}\` | ${c.reasonAr} | \`${c.vaultSecretId ?? 'جاهز للتأمين في الخزنة'}\` |`
          )
          .join('\n')
      : '| لا توجد ملفات سرية مكشوفة حالياً | تم الفحص بنجاح | — |';

  const criticalFilesMd = `# 🔐 الملفات الحساسة التي لا تُعوض: ${projectConfig.name}

> [!CAUTION]
> **تحذير أمني صارم:**  
> الملفات المذكورة في هذا الجدول هي أهم ملفات المشروع ولا يتم رفعها على GitHub. قام نظام العقل الثاني بأخذ نسخة مشفرة منها بـ \`AES-256\` داخل الخزنة السرية لاسترجاعها عند الحاجة.

| مسار الملف داخل المشروع | لماذا هذا الملف خطير ولا يعوض؟ | معرف النسخة المشفرة في الخزنة |
| :--- | :--- | :--- |
${critRows}
`;
  writeTextFileSafe(path.join(projectFolder, '03-Critical-Files.md'), criticalFilesMd);

  // 4. ملف البنية التحتية والفواتير (04-Infra-And-Billing.md)
  const billingMd = `# 💰 الاستضافة والفواتير والدخل: ${projectConfig.name}

* **الدخل والعائد المالي للمشروع:** ${projectConfig.monthlyIncome}
* **الالتزامات والفواتير الدورية:** ${projectConfig.billingNotes}
* **ملاحظة:** بيانات الدخول لحسابات الاستضافة والدومينات محفوظة بأمان داخل **خزنة العقل الثاني المشفرة**.
`;
  writeTextFileSafe(path.join(projectFolder, '04-Infra-And-Billing.md'), billingMd);

  // 5. ملف سجل التغييرات التلقائي (05-Auto-Changelog.md)
  const changelogPath = path.join(projectFolder, '05-Auto-Changelog.md');
  const existingChangelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf-8') : `# 🕒 سجل التحديثات التلقائي: ${projectConfig.name}\n\n`;
  const newEntry = `* **[${scanReport.scannedAt}]** فحص وتحديث تلقائي للمشروع — التقنيات: (${scanReport.detectedStack.join(', ')}) — عدد الملفات الحساسة المؤمنة: (${scanReport.criticalFilesFound.length}).\n`;
  writeTextFileSafe(changelogPath, existingChangelog + newEntry);

  // 6. ملف دليل الزوجة المبسط (06-Wife-Guide.md)
  const wifeGuideMd = `# ❤️ دليل المشروع المبسط لزوجتي الغالية: ${projectConfig.name}

## 1. ما هو هذا المشروع بكلمات بسيطة؟
${projectConfig.wifeSummaryAr}

## 2. هل يدر هذا المشروع دخلاً؟ وما هي فواتيره؟
* **الدخل:** ${projectConfig.monthlyIncome}
* **الفواتير المطلوبة حتى لا يتوقف:** ${projectConfig.billingNotes}

## 3. ماذا تفعلين إذا احتاج هذا المشروع إلى تحديث أو إصلاح؟
1. لا تعطي أي مبرمج كلمة المرور الرئيسية للإيميل أو حسابات المتاجر.
2. هذا المشروع يحتوي على **(${scanReport.criticalFilesFound.length}) ملفات حساسة** مؤمنة داخل خزنة برنامج العقل الثاني.
3. يمكنكِ فتح **وضع العائلة (Wife Mode)** في برنامج العقل الثاني وسؤال المساعد الذكي: *"كيف أتعامل مع مشروع ${projectConfig.name}؟"* وسيشرح لكِ كل خطوة بالتفصيل.
`;
  writeTextFileSafe(path.join(projectFolder, '06-Wife-Guide.md'), wifeGuideMd);

  logSystemInfo('ObsidianSync', `تم توليد وتحديث ملفات Obsidian الستة للمشروع: ${projectConfig.name}`);
  return projectFolder;
}
