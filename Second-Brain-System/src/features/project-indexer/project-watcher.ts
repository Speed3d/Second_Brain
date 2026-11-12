/**
 * ============================================================================
 * الملف: src/features/project-indexer/project-watcher.ts
 * القسم: Features -> Project Indexer (المراقب الدوري للمشاريع)
 * Hint بالعربي: يعيد فحص كل المشاريع على فترات (15 دقيقة افتراضياً) ويحدّث Obsidian، ويسحب المحادثات
 *               الجديدة تزايدياً. إذا كانت الخزنة مفتوحة وقت الفحص تُؤمَّن الملفات الحساسة المتغيرة فيها.
 *               المراقب لا يمدّد جلسة الخزنة (لا يمنع القفل التلقائي).
 * ============================================================================
 */

import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';
import { harvestLocalAITranscripts } from '../ai-memory/transcript-harvester.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { countSecuredFiles, syncProjectWithChanges } from './obsidian-sync.ts';
import { scanAndAnalyzeProject } from './project-scanner.ts';

/**
 * Hint بالعربي: ملخص فحص مشروع واحد.
 */
export interface ProjectRescanSummary {
  id: string;
  name: string;
  critical: number;
  secured: number;
  trackedByGit: string[];
  changes: string[];
  error?: string;
}

/**
 * Hint بالعربي: دالة إعادة فحص كل المشاريع وتحديث وثائقها (وتأمين ملفاتها إن مُرّرت خزنة مفتوحة).
 *               خطأ في مشروع واحد لا يوقف فحص البقية.
 */
export function rescanAllProjects(vault?: UnlockedVault | null): ProjectRescanSummary[] {
  const config = loadSystemConfig();
  return config.watchedProjects.map((project) => {
    try {
      const report = scanAndAnalyzeProject(project, vault ?? undefined);
      const { changes } = syncProjectWithChanges(project, report);
      return {
        id: project.id,
        name: project.name,
        critical: report.criticalFilesFound.length,
        secured: countSecuredFiles(report),
        trackedByGit: report.criticalFilesTrackedByGit ?? [],
        changes,
      };
    } catch (err) {
      logSystemError('ProjectWatcher', `تعذر فحص المشروع ${project.name}`, err);
      return { id: project.id, name: project.name, critical: 0, secured: 0, trackedByGit: [], changes: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Hint بالعربي: دالة تشغيل المراقب الدوري. المدخلات: دالة تُرجع الخزنة المفتوحة حالياً (أو null).
 *               المخرجات: runNow لتشغيل دورة فوراً، و stop لإيقاف المراقب.
 */
export function startProjectWatcher(getVault: () => UnlockedVault | null): { runNow: () => void; stop: () => void; intervalMinutes: number } {
  const config = loadSystemConfig();
  const watcher = config.watcher ?? { enabled: true, intervalMinutes: 15, harvestTranscripts: true };
  let running = false;

  const runNow = (): void => {
    if (running) return;
    running = true;
    try {
      const summary = rescanAllProjects(getVault());
      const changed = summary.filter((s) => s.changes.length).length;
      let harvestNote = '';
      if (watcher.harvestTranscripts) {
        const h = harvestLocalAITranscripts();
        harvestNote = `، محادثات مؤرشفة: ${h.claudeCodeCount + h.antigravityCount}`;
      }
      logSystemInfo('ProjectWatcher', `دورة مراقبة: ${summary.length} مشروع، تغيّر منها ${changed}${harvestNote}.`);
    } catch (err) {
      logSystemError('ProjectWatcher', 'فشلت دورة المراقبة', err);
    } finally {
      running = false;
    }
  };

  if (!watcher.enabled) return { runNow, stop: () => {}, intervalMinutes: 0 };
  const intervalMs = Math.max(1, watcher.intervalMinutes) * 60 * 1000;
  const firstRun = setTimeout(runNow, Math.min(60 * 1000, intervalMs));
  const timer = setInterval(runNow, intervalMs);
  firstRun.unref();
  timer.unref();
  return {
    runNow,
    stop: () => {
      clearTimeout(firstRun);
      clearInterval(timer);
    },
    intervalMinutes: watcher.intervalMinutes,
  };
}
