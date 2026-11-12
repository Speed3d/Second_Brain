/**
 * ============================================================================
 * الملف: src/features/project-indexer/git-inspector.ts
 * القسم: Features -> Project Indexer (فاحص Git للمشاريع)
 * Hint بالعربي: يقرأ حالة Git لأي مشروع دون تعديل أي شيء: الفرع، آخر commit، عدد التغييرات غير المحفوظة،
 *               والأهم: هل توجد ملفات حساسة (.env، keystore...) مرفوعة فعلاً على Git (خطر تسريب).
 *               يستخدم أمر git الموجود على الجهاز؛ إن لم يكن مثبتاً يعيد "ليس مستودع Git" بهدوء.
 * ============================================================================
 */

import { execFileSync } from 'node:child_process';

/**
 * Hint بالعربي: نتيجة فحص Git للمشروع.
 */
export interface GitInspection {
  isRepo: boolean;
  branch?: string;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  uncommittedChanges?: number;
  trackedCriticalFiles: string[];
}

/**
 * Hint بالعربي: دالة تشغيل أمر git للقراءة فقط مع مهلة قصيرة. المخرجات: النص أو null عند الفشل.
 */
export function runGitReadOnly(projectPath: string, args: string[], timeoutMs: number = 5000): string | null {
  try {
    return execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: دالة فحص حالة Git للمشروع، مع التحقق من الملفات الحساسة المرفوعة (بالمسارات النسبية المعطاة).
 */
export function inspectGitRepository(projectPath: string, criticalRelativePaths: string[] = []): GitInspection {
  const inside = runGitReadOnly(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return { isRepo: false, trackedCriticalFiles: [] };

  const branch = runGitReadOnly(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const log = runGitReadOnly(projectPath, ['log', '-1', '--format=%H%x1f%s%x1f%cI']);
  const [hash, message, date] = log ? log.trim().split('\x1f') : [];
  const status = runGitReadOnly(projectPath, ['status', '--porcelain']);
  const uncommittedChanges = status === null ? undefined : status.split(/\r?\n/).filter((l) => l.trim()).length;

  let trackedCriticalFiles: string[] = [];
  if (criticalRelativePaths.length) {
    const tracked = runGitReadOnly(projectPath, ['ls-files', '--', ...criticalRelativePaths.map((p) => p.replace(/\\/g, '/'))]);
    trackedCriticalFiles = tracked ? tracked.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  }

  return {
    isRepo: true,
    branch: branch && branch !== 'HEAD' ? branch : branch === 'HEAD' ? '(detached)' : undefined,
    lastCommitHash: hash || undefined,
    lastCommitMessage: message || undefined,
    lastCommitDate: date || undefined,
    uncommittedChanges,
    trackedCriticalFiles,
  };
}
