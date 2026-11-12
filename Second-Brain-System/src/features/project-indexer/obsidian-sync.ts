/**
 * ============================================================================
 * الملف: src/features/project-indexer/obsidian-sync.ts
 * القسم: Features -> Project Indexer (ميزة مزامنة وتحديث ملفات Obsidian تلقائياً)
 * Hint بالعربي: يحوّل نتائج فحص المشروع إلى 6 وثائق Markdown داخل Obsidian-Vault، مع:
 *               - حماية تعديلاتك اليدوية: يُستبدل فقط القسم الآلي بين العلامتين، ويبقى قسم "ملاحظاتي اليدوية".
 *               - سجل تغييرات لا يُكتب فيه إلا عند تغيّر حقيقي (commit جديد، ملف حساس جديد/محذوف، تقنيات...).
 *               - قسم Git وتحذير واضح إذا كان ملف حساس مرفوعاً على Git.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriticalFileEntry, ProjectScanReport, WatchedProjectConfig } from '../../shared/types.ts';
import { ensureDirectoryExists, readJsonFileSafe, writeFileAtomic, writeTextFileSafe } from '../../shared/file-helpers.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

export const AUTO_START = '<!-- second-brain:auto:start -->';
export const AUTO_END = '<!-- second-brain:auto:end -->';
const MANUAL_SECTION = '## ✍️ ملاحظاتي اليدوية\n\n> اكتب هنا ما تشاء؛ هذا القسم لا يُستبدل أبداً عند التحديث التلقائي.\n';

/**
 * Hint بالعربي: حالة آخر فحص لكل مشروع (لمعرفة ما تغيّر وكتابة سجل التغييرات عند الحاجة فقط).
 */
export interface ProjectScanSnapshot {
  fingerprint: string;
  stack: string[];
  commitHash?: string;
  criticalFiles: string[];
  securedCount: number;
  trackedByGit: string[];
}

/**
 * Hint بالعربي: دالة كتابة ملف يديره البرنامج مع الحفاظ على التعديلات اليدوية:
 *               - ملف بعلامات: يُستبدل ما بين العلامتين فقط.
 *               - ملف قديم ولّده البرنامج (يبدأ بنفس العنوان): يُستبدل بالكامل ويُضاف قسم الملاحظات.
 *               - ملف آخر بلا علامات: يوضع القسم الآلي أولاً ويُحفظ محتواه القديم كملاحظات يدوية.
 */
export function writeAutoManagedFile(filePath: string, autoContent: string, legacyHeader: string): void {
  const block = `${AUTO_START}\n${autoContent.trim()}\n${AUTO_END}`;
  if (!fs.existsSync(filePath)) {
    writeTextFileSafe(filePath, `${block}\n\n${MANUAL_SECTION}`);
    return;
  }
  const existing = fs.readFileSync(filePath, 'utf-8');
  const start = existing.indexOf(AUTO_START);
  const end = existing.indexOf(AUTO_END);
  let updated: string;
  if (start >= 0 && end > start) {
    updated = existing.slice(0, start) + block + existing.slice(end + AUTO_END.length);
  } else if (existing.trimStart().startsWith(legacyHeader)) {
    updated = `${block}\n\n${MANUAL_SECTION}`;
  } else {
    updated = `${block}\n\n${MANUAL_SECTION}\n${existing.trim()}\n`;
  }
  if (updated !== existing) writeTextFileSafe(filePath, updated);
}

/**
 * Hint بالعربي: دالة وصف حالة تأمين الملف الحساس بالعربية لجدول Obsidian.
 */
export function describeSecuredState(state: CriticalFileEntry['securedState'], vaultSecretId?: string): string {
  if ((state === 'secured' || state === 'unchanged') && vaultSecretId) return `🔐 مؤمَّن (\`${vaultSecretId}\`)`;
  if (state === 'too_large') return '⚠️ أكبر من الحد المسموح للتأمين';
  return '👁️ مكتشَف فقط (افتح الخزنة ثم أعد الفحص لتأمينه)';
}

/**
 * Hint بالعربي: دالة حساب عدد الملفات الحساسة المؤمَّنة فعلاً داخل الخزنة في تقرير الفحص.
 */
export function countSecuredFiles(report: ProjectScanReport): number {
  return report.criticalFilesFound.filter((c) => c.securedState === 'secured' || c.securedState === 'unchanged').length;
}

/**
 * Hint بالعربي: دالة بناء لقطة مختصرة من تقرير الفحص مع بصمة تمثّل كل ما يهم تتبّع تغيّره.
 */
export function buildScanSnapshot(report: ProjectScanReport): ProjectScanSnapshot {
  const snapshot = {
    stack: [...report.detectedStack].sort(),
    commitHash: report.lastCommitHash,
    criticalFiles: report.criticalFilesFound.map((c) => c.relativePath.replace(/\\/g, '/')).sort(),
    securedCount: countSecuredFiles(report),
    trackedByGit: [...(report.criticalFilesTrackedByGit ?? [])].sort(),
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  return { fingerprint, ...snapshot };
}

/**
 * Hint بالعربي: دالة مقارنة لقطتين وإرجاع وصف عربي لكل تغيير (قائمة فارغة = لا تغيير).
 */
export function describeScanChanges(previous: ProjectScanSnapshot | undefined, current: ProjectScanSnapshot, report: ProjectScanReport): string[] {
  if (!previous) return [`أول فحص للمشروع — التقنيات: (${current.stack.join(', ')})، الملفات الحساسة: (${current.criticalFiles.length})، المؤمَّن منها: (${current.securedCount}).`];
  if (previous.fingerprint === current.fingerprint) return [];
  const changes: string[] = [];
  if (previous.stack.join('|') !== current.stack.join('|')) changes.push(`تغيّرت التقنيات المكتشفة إلى: (${current.stack.join(', ')}).`);
  if (current.commitHash && previous.commitHash !== current.commitHash) {
    changes.push(`commit جديد \`${current.commitHash.slice(0, 7)}\`${report.lastCommitMessage ? `: ${report.lastCommitMessage}` : ''}${report.gitBranch ? ` (فرع ${report.gitBranch})` : ''}.`);
  }
  const added = current.criticalFiles.filter((f) => !previous.criticalFiles.includes(f));
  const removed = previous.criticalFiles.filter((f) => !current.criticalFiles.includes(f));
  if (added.length) changes.push(`ملفات حساسة جديدة: ${added.map((f) => `\`${f}\``).join('، ')}.`);
  if (removed.length) changes.push(`ملفات حساسة لم تعد موجودة: ${removed.map((f) => `\`${f}\``).join('، ')}.`);
  if (previous.securedCount !== current.securedCount) changes.push(`عدد الملفات المؤمَّنة في الخزنة أصبح: (${current.securedCount}).`);
  const newlyTracked = current.trackedByGit.filter((f) => !previous.trackedByGit.includes(f));
  if (newlyTracked.length) changes.push(`⚠️ ملفات حساسة أصبحت مرفوعة على Git: ${newlyTracked.map((f) => `\`${f}\``).join('، ')}.`);
  return changes.length ? changes : ['تحديث في بيانات الفحص.'];
}

/**
 * Hint بالعربي: دالة تحديث سجل تغييرات المشروع فقط عند وجود تغيير حقيقي منذ آخر فحص.
 *               المخرجات: قائمة التغييرات المكتوبة (فارغة إذا لم يُكتب شيء).
 */
export function updateProjectChangelog(projectConfig: WatchedProjectConfig, report: ProjectScanReport, projectFolder: string): string[] {
  const config = loadSystemConfig();
  const statePath = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'project-scan-state.json');
  const state = readJsonFileSafe<Record<string, ProjectScanSnapshot>>(statePath, {});
  const current = buildScanSnapshot(report);
  const changes = describeScanChanges(state[projectConfig.id], current, report);
  if (!changes.length) return [];

  const changelogPath = path.join(projectFolder, '05-Auto-Changelog.md');
  const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf-8') : `# 🕒 سجل التحديثات التلقائي: ${projectConfig.name}\n\n`;
  const entry = `* **[${report.scannedAt.replace('T', ' ').slice(0, 16)}]**\n${changes.map((c) => `  * ${c}`).join('\n')}\n`;
  writeTextFileSafe(changelogPath, existing.replace(/\s*$/, '\n') + entry);
  state[projectConfig.id] = current;
  writeFileAtomic(statePath, JSON.stringify(state, null, 2));
  return changes;
}

/**
 * Hint بالعربي: دالة توليد وتحديث جميع ملفات المشروع الستة داخل Obsidian-Vault. المخرجات: مجلد المشروع.
 */
export function syncProjectToObsidianVault(
  projectConfig: WatchedProjectConfig,
  scanReport: ProjectScanReport,
  customObsidianDir?: string
): string {
  return syncProjectWithChanges(projectConfig, scanReport, customObsidianDir).projectFolder;
}

/**
 * Hint بالعربي: دالة المزامنة الكاملة التي تُرجع أيضاً التغييرات المكتوبة في سجل التحديثات.
 */
export function syncProjectWithChanges(
  projectConfig: WatchedProjectConfig,
  scanReport: ProjectScanReport,
  customObsidianDir?: string
): { projectFolder: string; changes: string[] } {
  const config = loadSystemConfig();
  const obsidianRoot = customObsidianDir ?? config.paths.obsidianVaultDir;
  const projectFolder = path.join(obsidianRoot, '02-Projects', projectConfig.name);
  ensureDirectoryExists(projectFolder);
  ensureDirectoryExists(path.join(projectFolder, 'AI-Conversations'));
  const tracked = scanReport.criticalFilesTrackedByGit ?? [];

  // 1. نظرة عامة
  const gitSection = scanReport.gitBranch
    ? `## 🌿 حالة Git
* **الفرع:** \`${scanReport.gitBranch}\`
* **آخر commit:** ${scanReport.lastCommitHash ? `\`${scanReport.lastCommitHash.slice(0, 7)}\` — ${scanReport.lastCommitMessage ?? ''} (${scanReport.lastCommitDate?.slice(0, 10) ?? ''})` : 'لا يوجد'}
* **تغييرات غير محفوظة:** ${scanReport.uncommittedChanges ?? 0}
${tracked.length ? `\n> [!WARNING]\n> **ملفات حساسة مرفوعة على Git:** ${tracked.map((f) => `\`${f}\``).join('، ')}. احذفها من المستودع وأضفها إلى \`.gitignore\`، وغيّر أي سر كان بداخلها.\n` : ''}`
    : '## 🌿 حالة Git\n* المشروع ليس مستودع Git (أو أن Git غير مثبت).';

  writeAutoManagedFile(
    path.join(projectFolder, '01-Overview.md'),
    `# 🚀 نظرة عامة على المشروع: ${projectConfig.name}

> **معرّف المشروع:** \`${projectConfig.id}\`
> **المسار على الحاسوب:** \`${projectConfig.path}\`
> **آخر فحص تلقائي:** \`${scanReport.scannedAt}\`

## 📌 وصف المشروع والهدف منه
${projectConfig.descriptionAr}

## 🛠️ التقنيات المكتشفة تلقائياً
${scanReport.detectedStack.map((s) => `* **${s}**`).join('\n')}

## 📂 أهم الملفات الهندسية
${scanReport.importantFiles.length > 0 ? scanReport.importantFiles.map((f) => `* \`${f}\``).join('\n') : '* ملفات المشروع القياسية'}

${gitSection}

## 🔗 روابط وثائق هذا المشروع
* [[02-Projects/${projectConfig.name}/02-Run-And-Update|⚙️ طريقة التشغيل والبناء والتحديث]]
* [[02-Projects/${projectConfig.name}/03-Critical-Files|🔐 الملفات الحساسة]]
* [[02-Projects/${projectConfig.name}/04-Infra-And-Billing|💰 الفواتير والاستضافة والدخل]]
* [[02-Projects/${projectConfig.name}/05-Auto-Changelog|🕒 سجل التحديثات]]
* [[02-Projects/${projectConfig.name}/06-Wife-Guide|❤️ دليل المشروع المبسط للعائلة]]`,
    '# 🚀 نظرة عامة على المشروع'
  );

  // 2. التشغيل والتحديث
  writeAutoManagedFile(
    path.join(projectFolder, '02-Run-And-Update.md'),
    `# ⚙️ طريقة التشغيل والتحديث: ${projectConfig.name}

## 1️⃣ أوامر تشغيل المشروع
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.runCommands.join('\n')}
\`\`\`

## 2️⃣ أوامر البناء والفحص
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.buildCommands.length > 0 ? scanReport.buildCommands.join('\n') : '# لا توجد أوامر بناء منفصلة'}
\`\`\`

## 3️⃣ خطوات تحديث المشروع
\`\`\`powershell
cd "${projectConfig.path}"
${scanReport.updateCommands.length > 0 ? scanReport.updateCommands.join('\n') : '# لا توجد خطوات تحديث تلقائية'}
\`\`\``,
    '# ⚙️ طريقة التشغيل والتحديث'
  );

  // 3. الملفات الحساسة
  const critRows =
    scanReport.criticalFilesFound.length > 0
      ? scanReport.criticalFilesFound
          .map((c) => {
            const isTracked = tracked.includes(c.relativePath.replace(/\\/g, '/'));
            return `| \`${c.relativePath}\` | ${c.reasonAr} | ${describeSecuredState(c.securedState, c.vaultSecretId)}${isTracked ? ' ⚠️ مرفوع على Git!' : ''} |`;
          })
          .join('\n')
      : '| لا توجد ملفات سرية مكشوفة حالياً | تم الفحص بنجاح | — |';
  writeAutoManagedFile(
    path.join(projectFolder, '03-Critical-Files.md'),
    `# 🔐 الملفات الحساسة التي لا تُعوض: ${projectConfig.name}

> [!CAUTION]
> هذه أهم ملفات المشروع ويجب ألا تُرفع على GitHub. تُشفَّر نسخة منها داخل الخزنة عند إعادة الفحص والخزنة مفتوحة؛ الملف المكتوب بجانبه "مكتشَف فقط" لم يُؤمَّن بعد.

| مسار الملف داخل المشروع | لماذا هذا الملف خطير ولا يعوض؟ | حالة التأمين |
| :--- | :--- | :--- |
${critRows}`,
    '# 🔐 الملفات الحساسة التي لا تُعوض'
  );

  // 4. البنية التحتية والفواتير
  writeAutoManagedFile(
    path.join(projectFolder, '04-Infra-And-Billing.md'),
    `# 💰 الاستضافة والفواتير والدخل: ${projectConfig.name}

* **الدخل والعائد المالي للمشروع:** ${projectConfig.monthlyIncome}
* **الالتزامات والفواتير الدورية:** ${projectConfig.billingNotes}
* **ملاحظة:** بيانات الدخول لحسابات الاستضافة والدومينات محفوظة داخل **خزنة العقل الثاني المشفرة**.`,
    '# 💰 الاستضافة والفواتير والدخل'
  );

  // 5. سجل التغييرات (فقط عند تغيير حقيقي)
  const changes = updateProjectChangelog(projectConfig, scanReport, projectFolder);

  // 6. دليل العائلة
  writeAutoManagedFile(
    path.join(projectFolder, '06-Wife-Guide.md'),
    `# ❤️ دليل المشروع المبسط: ${projectConfig.name}

## 1. ما هو هذا المشروع بكلمات بسيطة؟
${projectConfig.wifeSummaryAr}

## 2. هل يدر هذا المشروع دخلاً؟ وما هي فواتيره؟
* **الدخل:** ${projectConfig.monthlyIncome}
* **الفواتير المطلوبة حتى لا يتوقف:** ${projectConfig.billingNotes}

## 3. ماذا تفعلين إذا احتاج هذا المشروع إلى تحديث أو إصلاح؟
1. لا تعطي أي مبرمج كلمة المرور الرئيسية للإيميل أو حسابات المتاجر.
2. هذا المشروع يحتوي على **(${scanReport.criticalFilesFound.length}) ملفات حساسة**، منها **(${countSecuredFiles(scanReport)})** محفوظة بأمان داخل خزنة برنامج العقل الثاني.
3. افتحي **وضع العائلة** في البرنامج واسألي المساعد: *"كيف أتعامل مع مشروع ${projectConfig.name}؟"*`,
    '# ❤️ دليل المشروع المبسط'
  );

  logSystemInfo('ObsidianSync', `تم تحديث ملفات Obsidian للمشروع: ${projectConfig.name}${changes.length ? ` (${changes.length} تغيير)` : ''}`);
  return { projectFolder, changes };
}
