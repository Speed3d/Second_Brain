/**
 * ============================================================================
 * الملف: src/features/project-indexer/project-details.ts
 * القسم: Features -> Project Indexer (تفاصيل المشروع لصفحة المشروع)
 * Hint بالعربي: يجمع كل ما يخص مشروعاً واحداً في مكان واحد لعرضه في صفحة المشروع:
 *               بياناته، تقرير الفحص، آخر أحداث سجل التغييرات، الذاكرة المشتركة، والمحادثات المؤرشفة؛
 *               ويبني سياقاً منقّى من الأسرار لتوليد ملخص "ما هذا المشروع وماذا يخدم".
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SharedAIMemoryEntry, WatchedProjectConfig } from '../../shared/types.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { querySharedAIMemory } from '../ai-memory/shared-memory-service.ts';
import { countSecuredFiles, describeSecuredState, getProjectFolderName } from './obsidian-sync.ts';
import { scanAndAnalyzeProject } from './project-scanner.ts';

/** أقصى عدد لأحداث سجل التغييرات المعروضة */
const MAX_CHANGELOG_ENTRIES = 15;

/**
 * Hint بالعربي: دالة جلب مشروع مسجّل بمعرّفه، أو null إن لم يوجد.
 */
export function findWatchedProject(projectId: string): WatchedProjectConfig | null {
  return loadSystemConfig().watchedProjects.find((p) => p.id === projectId) ?? null;
}

/**
 * Hint بالعربي: دالة تحديد مجلد وثائق المشروع داخل Obsidian.
 */
export function getProjectObsidianFolder(project: WatchedProjectConfig): string {
  return path.join(loadSystemConfig().paths.obsidianVaultDir, '02-Projects', getProjectFolderName(project));
}

/**
 * Hint بالعربي: دالة قراءة آخر أحداث سجل التغييرات (الأحدث أولاً) من 05-Auto-Changelog.md.
 */
export function readRecentChangelog(project: WatchedProjectConfig, limit: number = MAX_CHANGELOG_ENTRIES): string[] {
  const file = path.join(getProjectObsidianFolder(project), '05-Auto-Changelog.md');
  if (!fs.existsSync(file)) return [];
  const blocks = fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n(?=\* \*\*\[)/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith('* **['));
  return blocks
    .slice(-limit)
    .reverse()
    .map((b) => b.replace(/\*\*/g, '').replace(/^\* /, '').replace(/\n\s+\* /g, '\n• '));
}

/**
 * Hint بالعربي: دالة سرد محادثات الذكاء المؤرشفة للمشروع (الأحدث أولاً) مع عنوان كل محادثة.
 */
export function listProjectConversations(project: WatchedProjectConfig): Array<{ file: string; title: string; modifiedAt: string; sizeBytes: number }> {
  const dir = path.join(getProjectObsidianFolder(project), 'AI-Conversations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      const firstLine = fs.readFileSync(full, 'utf-8').split(/\r?\n/, 1)[0] ?? '';
      return { file: e.name, title: firstLine.replace(/^#+\s*/, '').trim() || e.name, modifiedAt: stat.mtime.toISOString(), sizeBytes: stat.size };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Hint بالعربي: دالة قراءة محادثة مؤرشفة واحدة؛ يُقبل فقط اسم ملف موجود فعلاً في قائمة محادثات المشروع
 *               (يمنع قراءة أي ملف آخر على الجهاز).
 */
export function readProjectConversation(project: WatchedProjectConfig, fileName: string): string | null {
  const known = listProjectConversations(project).find((c) => c.file === fileName);
  if (!known) return null;
  return fs.readFileSync(path.join(getProjectObsidianFolder(project), 'AI-Conversations', known.file), 'utf-8');
}

/**
 * Hint بالعربي: دالة جمع تفاصيل المشروع كاملة لصفحة المشروع.
 */
export function getProjectDetails(project: WatchedProjectConfig): Record<string, unknown> {
  const report = scanAndAnalyzeProject(project);
  const memories: SharedAIMemoryEntry[] = querySharedAIMemory(project.id).slice(0, 20);
  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      pathExists: fs.existsSync(project.path),
      descriptionAr: project.descriptionAr,
      wifeSummaryAr: project.wifeSummaryAr,
      monthlyIncome: project.monthlyIncome,
      billingNotes: project.billingNotes,
      summaryAr: project.summaryAr ?? '',
    },
    report: {
      stack: report.detectedStack,
      runCommands: report.runCommands,
      buildCommands: report.buildCommands,
      updateCommands: report.updateCommands,
      importantFiles: report.importantFiles,
      gitBranch: report.gitBranch ?? null,
      lastCommitHash: report.lastCommitHash ?? null,
      lastCommitMessage: report.lastCommitMessage ?? null,
      lastCommitDate: report.lastCommitDate ?? null,
      uncommittedChanges: report.uncommittedChanges ?? null,
      trackedByGit: report.criticalFilesTrackedByGit ?? [],
      criticalFiles: report.criticalFilesFound.map((c) => ({
        path: c.relativePath,
        reasonAr: c.reasonAr,
        stateAr: describeSecuredState(c.securedState, c.vaultSecretId).replace(/`/g, ''),
      })),
      securedCount: countSecuredFiles(report),
      scannedAt: report.scannedAt,
    },
    changelog: readRecentChangelog(project),
    memories: memories.map((m) => ({ id: m.id, sourceAI: m.sourceAI, title: m.title, summaryAr: m.summaryAr, decisions: m.keyDecisionsAr, createdAt: m.createdAt })),
    conversations: listProjectConversations(project),
  };
}

/**
 * Hint بالعربي: دالة بناء سياق المشروع (منقّى من الأسرار) لتوليد ملخص بالمساعد الذكي:
 *               بيانات المشروع، README، أوامر التشغيل، آخر التغييرات، والقرارات المحفوظة.
 */
export function buildProjectSummaryContext(project: WatchedProjectConfig): string {
  const details = getProjectDetails(project) as {
    report: { stack: string[]; runCommands: string[]; importantFiles: string[]; gitBranch: string | null; lastCommitMessage: string | null };
    changelog: string[];
    memories: Array<{ title: string; summaryAr: string }>;
  };
  let readme = '';
  for (const name of ['README.md', 'readme.md', 'README.txt']) {
    const file = path.join(project.path, name);
    if (fs.existsSync(file)) {
      readme = fs.readFileSync(file, 'utf-8').slice(0, 5000);
      break;
    }
  }
  const context = [
    `اسم المشروع: ${project.name}`,
    `الوصف التقني (من القائد): ${project.descriptionAr || '—'}`,
    `الشرح للعائلة: ${project.wifeSummaryAr || '—'}`,
    `الدخل: ${project.monthlyIncome} | الفواتير: ${project.billingNotes || '—'}`,
    `التقنيات: ${details.report.stack.join('، ')}`,
    `أوامر التشغيل: ${details.report.runCommands.join(' | ')}`,
    `الملفات المهمة: ${details.report.importantFiles.join('، ') || '—'}`,
    details.report.gitBranch ? `Git: الفرع ${details.report.gitBranch}، آخر تعديل: ${details.report.lastCommitMessage ?? '—'}` : '',
    details.changelog.length ? `آخر التغييرات:\n${details.changelog.slice(0, 5).join('\n')}` : '',
    details.memories.length ? `قرارات محفوظة:\n${details.memories.slice(0, 8).map((m) => `- ${m.title}: ${m.summaryAr}`).join('\n')}` : '',
    readme ? `محتوى README:\n${readme}` : 'لا يوجد ملف README.',
  ]
    .filter(Boolean)
    .join('\n');
  return redactSecrets(context).text;
}
