/**
 * ============================================================================
 * الملف: src/features/ai-memory/transcript-harvester.ts
 * القسم: Features -> AI Memory (ساحب المحادثات التزايدي)
 * Hint بالعربي: يمر على موصلات المحادثات المفعّلة (Claude Code و Antigravity) ويؤرشف كل جلسة في Obsidian:
 *               - تزايدي: يتذكّر حالة كل جلسة (الحجم ووقت التعديل) ولا يعيد كتابة ما لم يتغيّر.
 *               - آمن: يحذف الأسرار من كل رسالة قبل الكتابة.
 *               - منظم: الجلسة المرتبطة بمشروع مراقب تُحفظ في 02-Projects/<المشروع>/AI-Conversations،
 *                 والباقي في 03-AI-Shared-Memory/<المصدر>-Sessions.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SystemBrandingConfig, WatchedProjectConfig } from '../../shared/types.ts';
import { formatTimestampIso, readJsonFileSafe, writeFileAtomic, writeTextFileSafe } from '../../shared/file-helpers.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';
import { createAntigravityConnector } from './connectors/antigravity-connector.ts';
import { createClaudeCodeConnector } from './connectors/claude-code-connector.ts';
import type { TranscriptConnector, TranscriptSession } from './connectors/connector-types.ts';

/**
 * Hint بالعربي: حالة الأرشفة المحفوظة لكل جلسة (لمعرفة ما تغيّر منذ آخر سحب).
 */
export interface HarvestState {
  version: 1;
  sessions: Record<string, { modifiedMs: number; sizeBytes: number; outFile: string; archivedAt: string }>;
}

/**
 * Hint بالعربي: نتيجة السحب.
 */
export interface HarvestResult {
  antigravityCount: number;
  claudeCodeCount: number;
  archivedFiles: string[];
  skippedUnchanged: number;
  redactions: number;
  errors: number;
}

/**
 * Hint بالعربي: دالة تحديد مسار ملف حالة الأرشفة.
 */
export function getHarvestStatePath(config: SystemBrandingConfig): string {
  return path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'harvest-state.json');
}

/**
 * Hint بالعربي: دالة بناء قائمة الموصلات المفعّلة حسب الإعدادات.
 */
export function buildEnabledConnectors(config: SystemBrandingConfig): TranscriptConnector[] {
  const list: TranscriptConnector[] = [];
  if (config.connectors?.claudeCode?.enabled !== false) list.push(createClaudeCodeConnector(config.paths.claudeCodeLogsDir));
  if (config.connectors?.antigravity?.enabled !== false) list.push(createAntigravityConnector(config.paths.antigravityLogsDir));
  return list;
}

/**
 * Hint بالعربي: دالة إيجاد المشروع المراقب الذي تنتمي إليه الجلسة: من مجلد العمل (cwd) أولاً،
 *               ثم من ذكر مسار المشروع داخل نص المحادثة. يُختار المسار الأطول تطابقاً.
 */
export function matchSessionToProject(session: TranscriptSession, projects: WatchedProjectConfig[]): WatchedProjectConfig | undefined {
  const norm = (p: string): string => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const sorted = [...projects].sort((a, b) => b.path.length - a.path.length);
  if (session.cwd) {
    const cwd = norm(session.cwd);
    const byCwd = sorted.find((p) => cwd === norm(p.path) || cwd.startsWith(norm(p.path) + path.sep));
    if (byCwd) return byCwd;
    // الجلسة تعمل من مجلد أب يحتوي مشروعاً مراقباً واحداً فقط (وليس جذر قرص) ← تُنسب إليه
    const isDriveRoot = path.parse(path.resolve(session.cwd)).root.toLowerCase().replace(/[\\/]+$/, '') === cwd;
    const inside = sorted.filter((p) => norm(p.path).startsWith(cwd + path.sep));
    if (!isDriveRoot && inside.length === 1) return inside[0];
  }
  const text = session.messages.slice(0, 50).map((m) => m.text).join('\n').toLowerCase();
  return sorted.find((p) => p.path.length > 3 && text.includes(p.path.toLowerCase()));
}

/**
 * Hint بالعربي: دالة تحديد مسار ملف الأرشيف للجلسة داخل Obsidian.
 */
export function resolveArchivePath(
  config: SystemBrandingConfig,
  connector: TranscriptConnector,
  session: TranscriptSession,
  project?: WatchedProjectConfig
): string {
  const id8 = session.ref.sessionId.slice(0, 8);
  const date = (session.startedAt ?? new Date(session.ref.modifiedMs).toISOString()).slice(0, 10);
  const fileName = connector.id === 'antigravity' ? `Antigravity-${id8}.md` : `Claude-Code-${date}-${id8}.md`;
  if (project) return path.join(config.paths.obsidianVaultDir, '02-Projects', project.name, 'AI-Conversations', fileName);
  const folder = connector.id === 'antigravity' ? 'Antigravity-Sessions' : 'Claude-Code-Sessions';
  return path.join(config.paths.obsidianVaultDir, '03-AI-Shared-Memory', folder, fileName);
}

/**
 * Hint بالعربي: دالة تحويل الجلسة إلى Markdown بعد حذف الأسرار. المخرجات: النص وعدد الأسرار المحذوفة.
 */
export function renderSessionMarkdown(
  connector: TranscriptConnector,
  session: TranscriptSession,
  project?: WatchedProjectConfig
): { markdown: string; redactions: number } {
  let redactions = 0;
  const body = session.messages
    .map((m) => {
      const clean = redactSecrets(m.text);
      redactions += clean.redactions;
      const who = m.role === 'user' ? '👤 القائد' : `🤖 ${connector.assistantLabel}`;
      const time = m.timestamp ? ` — ${m.timestamp.replace('T', ' ').slice(0, 16)}` : '';
      return `### ${who}${time}\n\n${clean.text}`;
    })
    .join('\n\n---\n\n');
  const title = redactSecrets(session.title?.trim() || `محادثة ${connector.labelAr}`).text.replace(/\s+/g, ' ');
  const header = [
    `# 💬 ${title}`,
    '',
    `> **المصدر:** ${connector.labelAr} | **المعرّف:** \`${session.ref.sessionId}\``,
    `> **البداية:** \`${session.startedAt ?? 'غير معروفة'}\` | **عدد الرسائل:** ${session.messages.length}`,
    session.cwd ? `> **مجلد العمل:** \`${session.cwd}\`` : null,
    project ? `> **المشروع:** [[02-Projects/${project.name}/01-Overview|${project.name}]]` : null,
    `> **آخر أرشفة:** \`${formatTimestampIso()}\`${redactions ? ` | **أسرار حُذفت تلقائياً:** ${redactions}` : ''}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { markdown: `${header}\n\n---\n\n${body}\n`, redactions };
}

/**
 * Hint بالعربي: دالة سحب وأرشفة المحادثات من كل الموصلات المفعّلة (تزايدياً).
 *               مع force = true تُعاد أرشفة كل الجلسات حتى غير المتغيرة.
 */
export function harvestLocalAITranscripts(options: { force?: boolean } = {}): HarvestResult {
  const config = loadSystemConfig();
  const statePath = getHarvestStatePath(config);
  const state = readJsonFileSafe<HarvestState>(statePath, { version: 1, sessions: {} });
  const obsidianRoot = path.resolve(config.paths.obsidianVaultDir);
  const result: HarvestResult = { antigravityCount: 0, claudeCodeCount: 0, archivedFiles: [], skippedUnchanged: 0, redactions: 0, errors: 0 };

  for (const connector of buildEnabledConnectors(config)) {
    if (!connector.isAvailable()) continue;
    for (const ref of connector.listSessions()) {
      const key = `${connector.id}:${ref.sessionId}`;
      const previous = state.sessions[key];
      if (!options.force && previous && previous.modifiedMs === ref.modifiedMs && previous.sizeBytes === ref.sizeBytes) {
        result.skippedUnchanged++;
        continue;
      }
      try {
        const session = connector.readSession(ref);
        if (!session.messages.length) continue;
        const project = matchSessionToProject(session, config.watchedProjects);
        const outFile = resolveArchivePath(config, connector, session, project);
        const { markdown, redactions } = renderSessionMarkdown(connector, session, project);
        writeTextFileSafe(outFile, markdown);

        // إذا انتقلت الجلسة لمكان جديد (مثلاً بعد إضافة مشروعها) نحذف أرشيفها القديم الذي أنشأناه نحن
        if (previous?.outFile && path.resolve(previous.outFile) !== path.resolve(outFile)) {
          const old = path.resolve(previous.outFile);
          if (old.startsWith(obsidianRoot + path.sep) && fs.existsSync(old)) fs.unlinkSync(old);
        }

        state.sessions[key] = { modifiedMs: ref.modifiedMs, sizeBytes: ref.sizeBytes, outFile, archivedAt: formatTimestampIso() };
        result.archivedFiles.push(outFile);
        result.redactions += redactions;
        if (connector.id === 'antigravity') result.antigravityCount++;
        else result.claudeCodeCount++;
      } catch (err) {
        result.errors++;
        logSystemError('TranscriptHarvester', `تعذر أرشفة الجلسة ${key}`, err);
      }
    }
  }

  writeFileAtomic(statePath, JSON.stringify(state, null, 2));
  logSystemInfo(
    'TranscriptHarvester',
    `اكتمل السحب: Antigravity (${result.antigravityCount})، Claude Code (${result.claudeCodeCount})، دون تغيير (${result.skippedUnchanged})، أسرار محذوفة (${result.redactions}).`
  );
  return result;
}
