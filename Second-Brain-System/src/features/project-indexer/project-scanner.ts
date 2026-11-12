/**
 * ============================================================================
 * الملف: src/features/project-indexer/project-scanner.ts
 * القسم: Features -> Project Indexer (ميزة التشريح والفحص التلقائي للمشاريع)
 * Hint بالعربي: يقوم هذا الملف بعمل "أشعة X-Ray" لأي مشروع برمجي، ليكتشف تلقائياً
 *               التقنيات المستخدمة، أوامر التشغيل والتحديث، أهم الملفات الهندسية،
 *               والملفات السرية الحرجة لتأمينها وتوثيقها.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectScanReport, WatchedProjectConfig } from '../../shared/types.ts';
import { formatTimestampIso, readJsonFileSafe } from '../../shared/file-helpers.ts';
import { huntCriticalProjectFiles } from './secret-file-hunter.ts';
import { inspectGitRepository } from './git-inspector.ts';
import { backupCriticalFileToVault, MAX_CRITICAL_FILE_BYTES, type UnlockedVault } from '../vault/vault-manager.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة لفحص مشروع كامل واستخراج تقرير شامل عن طريقة تشغيله وتحديثه وملفاته المهمة.
 *               إذا مُرِّرت خزنة مفتوحة، تُشفَّر الملفات الحساسة فعلاً داخلها (مع نسخ تاريخية عند التغيّر)،
 *               وإلا تبقى في حالة "مكتشَف" فقط ولا يُدّعى أنها مؤمَّنة.
 */
export function scanAndAnalyzeProject(projectConfig: WatchedProjectConfig, unlockedVault?: UnlockedVault): ProjectScanReport {
  const projectPath = projectConfig.path;
  const detectedStack: string[] = [];
  const runCommands: string[] = [];
  const buildCommands: string[] = [];
  const updateCommands: string[] = [];
  const importantFiles: string[] = [];

  if (fs.existsSync(projectPath)) {
    // 1. فحص مشاريع Node.js / TypeScript / React / Next.js
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      detectedStack.push('Node.js / JavaScript');
      importantFiles.push('package.json');
      const pkg = readJsonFileSafe<{ scripts?: Record<string, string>; dependencies?: Record<string, string> }>(
        pkgJsonPath,
        {}
      );
      if (pkg.scripts) {
        if (pkg.scripts.start) runCommands.push(`npm run start  # (${pkg.scripts.start})`);
        if (pkg.scripts.dev) runCommands.push(`npm run dev    # (${pkg.scripts.dev})`);
        if (pkg.scripts.build) buildCommands.push(`npm run build  # (${pkg.scripts.build})`);
        if (pkg.scripts.test) buildCommands.push(`npm test       # (${pkg.scripts.test})`);
      }
      updateCommands.push('npm install');
    }

    // 2. فحص إعدادات TypeScript
    if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
      detectedStack.push('TypeScript');
      importantFiles.push('tsconfig.json');
    }

    // 3. فحص مشاريع Flutter / Dart
    if (fs.existsSync(path.join(projectPath, 'pubspec.yaml'))) {
      detectedStack.push('Flutter / Dart');
      importantFiles.push('pubspec.yaml');
      runCommands.push('flutter run');
      buildCommands.push('flutter build apk --release');
      updateCommands.push('flutter pub get');
    }

    // 4. فحص مشاريع Python
    if (
      fs.existsSync(path.join(projectPath, 'requirements.txt')) ||
      fs.existsSync(path.join(projectPath, 'pyproject.toml'))
    ) {
      detectedStack.push('Python');
      importantFiles.push('requirements.txt');
      runCommands.push('python main.py');
      updateCommands.push('pip install -r requirements.txt');
    }

    // 5. فحص ملفات التوثيق والحوكمة
    for (const candidate of ['README.md', 'CONSTITUTION-AND-RULES.md', '00-Master-Implementation-Plan.md', 'Dockerfile']) {
      if (fs.existsSync(path.join(projectPath, candidate))) {
        importantFiles.push(candidate);
      }
    }
  }

  if (detectedStack.length === 0) {
    detectedStack.push('General Software Project');
  }
  if (runCommands.length === 0) {
    runCommands.push('راجع ملف 02-Run-And-Update.md لتعليمات التشغيل الخاصة');
  }

  // 6. صيد الملفات السرية الحرجة التي لا تعوض
  const criticalFilesFound = huntCriticalProjectFiles(projectPath);

  // 7. التأمين الفعلي داخل الخزنة إذا كانت مفتوحة
  for (const critFile of criticalFilesFound) {
    if (critFile.sizeBytes > MAX_CRITICAL_FILE_BYTES) {
      critFile.securedState = 'too_large';
      continue;
    }
    if (!unlockedVault) continue;
    try {
      const { secretId, changed } = backupCriticalFileToVault(
        unlockedVault,
        projectConfig.id,
        critFile.absolutePath,
        critFile.reasonAr
      );
      critFile.vaultSecretId = secretId;
      critFile.securedState = changed ? 'secured' : 'unchanged';
    } catch (err) {
      logSystemError('ProjectScanner', `تعذر تأمين الملف الحساس: ${critFile.relativePath}`, err);
    }
  }

  // 8. حالة Git (الفرع، آخر commit، التغييرات، والملفات الحساسة المرفوعة على Git)
  const git = inspectGitRepository(projectPath, criticalFilesFound.map((c) => c.relativePath));
  if (git.isRepo) updateCommands.unshift('git pull');

  const report: ProjectScanReport = {
    gitBranch: git.branch,
    lastCommitMessage: git.lastCommitMessage,
    lastCommitHash: git.lastCommitHash,
    lastCommitDate: git.lastCommitDate,
    uncommittedChanges: git.uncommittedChanges,
    criticalFilesTrackedByGit: git.trackedCriticalFiles,
    projectId: projectConfig.id,
    projectName: projectConfig.name,
    projectPath,
    detectedStack,
    runCommands,
    buildCommands,
    updateCommands,
    criticalFilesFound,
    importantFiles,
    scannedAt: formatTimestampIso(),
  };

  logSystemInfo('ProjectScanner', `اكتمل تشريح المشروع (${projectConfig.name}) — تم اكتشاف ${criticalFilesFound.length} ملف حساس.`);
  return report;
}
