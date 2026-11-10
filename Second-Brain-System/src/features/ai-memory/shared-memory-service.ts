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

  const fullEntry: SharedAIMemoryEntry = {
    ...entry,
    id: `MEM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createdAt: formatTimestampIso(),
  };

  const allEntries = readJsonFileSafe<SharedAIMemoryEntry[]>(memoryStoreFile, []);
  allEntries.unshift(fullEntry);
  writeJsonFileSafe(memoryStoreFile, allEntries);

  // كتابة ملف Markdown مستقل للمحادثة داخل Obsidian
  const safeTitle = fullEntry.title.replace(/[\\/:*?"<>|]/g, '-');
  const targetSubfolder =
    fullEntry.sourceAI === 'claude-code' ? 'Claude-Code-Sessions' : 'Antigravity-Sessions';
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

  // إضافة سطر في الفهرس الرئيسي للذاكرة المشتركة داخل Obsidian
  const memoryIndexPath = path.join(obsidianRoot, '03-AI-Shared-Memory', 'Memory-Index.md');
  if (fs.existsSync(memoryIndexPath)) {
    const currentIndex = fs.readFileSync(memoryIndexPath, 'utf-8');
    const bullet = `\n* **[${fullEntry.createdAt}] (${fullEntry.sourceAI} -> ${fullEntry.projectId}):** **${fullEntry.title}** — ${fullEntry.summaryAr}`;
    writeTextFileSafe(memoryIndexPath, currentIndex + bullet);
  }

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
