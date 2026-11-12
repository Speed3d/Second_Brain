/**
 * ============================================================================
 * الملف: src/features/ai-memory/shared-memory-service.ts
 * القسم: Features -> AI Memory (ميزة الذاكرة المشتركة بين كل أدوات الذكاء الاصطناعي)
 * Hint بالعربي: يوفر هذا الملف ذاكرة موحدة تجمع ما يدور في محادثاتك مع
 *               Google Antigravity (Gemini) و Claude Code ومساعد العقل الثاني،
 *               بحيث يعرف كل ذكاء اصطناعي تاريخ مشاريعك وقراراتك السابقة فوراً.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SharedAIMemoryEntry } from '../../shared/types.ts';
import {
  ensureDirectoryExists,
  formatTimestampIso,
  readJsonFileSafe,
  writeJsonFileSafe,
  writeTextFileSafe,
} from '../../shared/file-helpers.ts';
import { writeFileAtomic } from '../../shared/file-helpers.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة لحفظ ملخص محادثة أو قرار برمجي جديد في الذاكرة المشتركة
 * ونسخه تلقائياً إلى ملفات Obsidian ليظهر تحت المشروع وفي سجل الذاكرة العام.
 */
export function recordSharedAIMemory(
  entry: Omit<SharedAIMemoryEntry, 'id' | 'createdAt'>,
  customObsidianDir?: string
): SharedAIMemoryEntry {
  const config = loadSystemConfig();
  const obsidianRoot = customObsidianDir ?? config.paths.obsidianVaultDir;
  const memoryStoreFile = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'ai-memory-store.json');

  // تنقية أي سر قد يرد في الملخص أو القرارات قبل الحفظ
  const fullEntry: SharedAIMemoryEntry = {
    ...entry,
    title: redactSecrets(entry.title).text,
    summaryAr: redactSecrets(entry.summaryAr).text,
    keyDecisionsAr: entry.keyDecisionsAr.map((d) => redactSecrets(d).text),
    id: `MEM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createdAt: formatTimestampIso(),
  };

  const allEntries = readJsonFileSafe<SharedAIMemoryEntry[]>(memoryStoreFile, []);
  allEntries.unshift(fullEntry);
  writeFileAtomic(memoryStoreFile, JSON.stringify(allEntries, null, 2), 2);

  // كتابة ملف Markdown مستقل للمحادثة داخل Obsidian
  const safeTitle = fullEntry.title.replace(/[\\/:*?"<>|\r\n]/g, '-').slice(0, 80);
  const targetSubfolder =
    fullEntry.sourceAI === 'claude-code'
      ? 'Claude-Code-Sessions'
      : fullEntry.sourceAI === 'antigravity-gemini'
        ? 'Antigravity-Sessions'
        : 'Second-Brain-Sessions';
  const sessionFolder = path.join(obsidianRoot, '03-AI-Shared-Memory', targetSubfolder);
  ensureDirectoryExists(sessionFolder);

  const sessionMd = `# 🧠 سجل ذاكرة ذكاء اصطناعي: ${fullEntry.title}

* **معرف السجل:** \`${fullEntry.id}\`
* **الأداة المصدر:** \`${fullEntry.sourceAI}\`
* **المشروع المرتبط:** \`${fullEntry.projectId}\`
* **التاريخ والوقت:** \`${fullEntry.createdAt}\`

---

## 📋 ملخص المحادثة وما تم إنجازه
${fullEntry.summaryAr}

## ✅ القرارات والقواعد المعتمدة
${fullEntry.keyDecisionsAr.map((d) => `* ${d}`).join('\n')}
`;

  writeTextFileSafe(path.join(sessionFolder, `${fullEntry.id}-${safeTitle}.md`), sessionMd);

  // إضافة سطر في "سجل الذاكرة الحي" (ملف شخصي منفصل عن الفهرس العام ومستبعد من Git)
  const streamPath = path.join(obsidianRoot, '03-AI-Shared-Memory', 'Memory-Stream.md');
  const currentStream = fs.existsSync(streamPath)
    ? fs.readFileSync(streamPath, 'utf-8')
    : '# 📝 سجل الذاكرة المشتركة الحي\n\n> يُضاف هنا تلقائياً كل قرار أو ملخص تحفظه أدوات الذكاء الاصطناعي. هذا الملف شخصي ولا يُرفع إلى GitHub.\n';
  const bullet = `\n* **[${fullEntry.createdAt}] (${fullEntry.sourceAI} -> ${fullEntry.projectId}):** **${fullEntry.title}** — ${fullEntry.summaryAr.replace(/\s+/g, ' ').slice(0, 400)}`;
  writeTextFileSafe(streamPath, currentStream + bullet);

  logSystemInfo('SharedAIMemory', `تم حفظ سجل ذاكرة مشترك جديد (${fullEntry.id}) من (${fullEntry.sourceAI}).`);
  return fullEntry;
}

/**
 * Hint بالعربي: دالة لاسترجاع السياق الكامل والذاكرة المشتركة (لبناء خلفية شاملة لأي ذكاء اصطناعي يسأل عنك أو عن مشروعك).
 */
export function querySharedAIMemory(filterProjectId?: string): SharedAIMemoryEntry[] {
  const config = loadSystemConfig();
  const memoryStoreFile = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'ai-memory-store.json');
  const allEntries = readJsonFileSafe<SharedAIMemoryEntry[]>(memoryStoreFile, []);

  if (!filterProjectId) {
    return allEntries;
  }
  return allEntries.filter((e) => e.projectId.toLowerCase() === filterProjectId.toLowerCase());
}
