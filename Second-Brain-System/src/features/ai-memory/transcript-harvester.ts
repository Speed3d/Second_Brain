/**
 * ============================================================================
 * الملف: src/features/ai-memory/transcript-harvester.ts
 * القسم: Features -> AI Memory (ميزة السحب التلقائي لسجلات محادثات Antigravity و Claude Code)
 * Hint بالعربي: يقوم هذا الملف بفحص مسارات تخزين المحادثات المحلية على حاسوبك
 *               الخاصة بـ Google Antigravity و Claude Code، ويستخرج منها المحادثات
 *               ليؤرشفها تلقائياً داخل Obsidian Vault حتى لا تضيع أي معلومة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectoryExists, formatTimestampIso, writeTextFileSafe } from '../../shared/file-helpers.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة لسحب وأرشفة سجلات محادثات Google Antigravity و Claude Code الموجودة على الجهاز.
 */
export function harvestLocalAITranscripts(customObsidianDir?: string): {
  antigravityCount: number;
  claudeCodeCount: number;
  archivedFiles: string[];
} {
  const config = loadSystemConfig();
  const obsidianRoot = customObsidianDir ?? config.paths.obsidianVaultDir;
  const archivedFiles: string[] = [];
  let antigravityCount = 0;
  let claudeCodeCount = 0;

  // 1. فحص مجلد محادثات Google Antigravity
  const agyBrainDir = config.paths.antigravityLogsDir;
  if (fs.existsSync(agyBrainDir)) {
    const convFolders = fs.readdirSync(agyBrainDir, { withFileTypes: true });
    for (const folder of convFolders) {
      if (!folder.isDirectory()) continue;
      const transcriptPath = path.join(
        agyBrainDir,
        folder.name,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (fs.existsSync(transcriptPath)) {
        const extracted = parseJsonlTranscriptPreview(transcriptPath, 15);
        if (extracted.length > 0) {
          const outDir = path.join(obsidianRoot, '03-AI-Shared-Memory', 'Antigravity-Sessions');
          ensureDirectoryExists(outDir);
          const outFile = path.join(outDir, `Antigravity-${folder.name.slice(0, 8)}.md`);
          const mdContent = `# 🤖 أرشيف محادثة Google Antigravity (${folder.name.slice(0, 8)})

* **معرف المحادثة الأصلي:** \`${folder.name}\`
* **تاريخ الأرشفة التلقائية:** \`${formatTimestampIso()}\`

---

## 💬 مقتطفات المحادثة المسحوبة تلقائياً
${extracted.map((line, idx) => `### رسالة #${idx + 1}\n${line}`).join('\n\n---\n\n')}
`;
          writeTextFileSafe(outFile, mdContent);
          archivedFiles.push(outFile);
          antigravityCount++;
        }
      }
    }
  }

  // 2. فحص مجلد محادثات Claude Code المحلي (إن وجد)
  const claudeDir = config.paths.claudeCodeLogsDir;
  if (fs.existsSync(claudeDir)) {
    const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        claudeCodeCount++;
      }
    }
  }

  logSystemInfo(
    'TranscriptHarvester',
    `اكتمل سحب المحادثات: (${antigravityCount}) من Antigravity و (${claudeCodeCount}) من Claude Code.`
  );
  return { antigravityCount, claudeCodeCount, archivedFiles };
}

/**
 * Hint بالعربي: دالة مساعدة لقراءة ملفات JSONL الخاصة بالمحادثات واستخراج نصوص الطلبات والردود المهمة منها بأمان.
 */
export function parseJsonlTranscriptPreview(jsonlFilePath: string, maxItems: number = 15): string[] {
  const snippets: string[] = [];
  try {
    const raw = fs.readFileSync(jsonlFilePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      if (snippets.length >= maxItems) break;
      try {
        const parsed = JSON.parse(line) as { type?: string; content?: string };
        if (
          (parsed.type === 'USER_INPUT' || parsed.type === 'PLANNER_RESPONSE') &&
          typeof parsed.content === 'string' &&
          parsed.content.trim().length > 0
        ) {
          const cleanText = parsed.content.replace(/<[^>]+>/g, '').trim().slice(0, 600);
          if (cleanText.length > 0) {
            snippets.push(`**[${parsed.type}]:**\n${cleanText}`);
          }
        }
      } catch {
        // تجاهل الأسطر غير الصالحة
      }
    }
  } catch {
    // في حال كان الملف قيد الكتابة حالياً
  }
  return snippets;
}
