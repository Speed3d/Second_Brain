/**
 * ============================================================================
 * الملف: src/features/ai-memory/connectors/claude-code-connector.ts
 * القسم: Features -> AI Memory -> Connectors (موصل Claude Code)
 * Hint بالعربي: يقرأ محادثات Claude Code من ~/.claude/projects/<مجلد>/<جلسة>.jsonl ويستخرج:
 *               رسائل القائد الحقيقية (يتجاهل نتائج الأدوات، والرسائل الآلية، وإشعارات المهام)،
 *               وردود Claude النصية (يتجاهل التفكير الداخلي واستدعاءات الأدوات)، وعنوان الجلسة ومجلد العمل.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanTranscriptText,
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSION_FILE_BYTES,
  type TranscriptConnector,
  type TranscriptMessage,
  type TranscriptSession,
  type TranscriptSessionRef,
} from './connector-types.ts';

/**
 * Hint بالعربي: دالة استخراج النص من محتوى رسالة Claude Code (نص مباشر أو كتل text فقط).
 */
export function extractClaudeCodeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String((b as { text?: string }).text ?? ''))
    .join('\n');
}

/**
 * Hint بالعربي: دالة تحديد ما إذا كانت رسالة "user" مكتوبة من القائد فعلاً (وليست آلية).
 */
export function isHumanUserLine(o: Record<string, any>): boolean {
  if (o.isMeta || o.isSidechain) return false;
  if (o.promptSource === 'system') return false;
  const originKind = o.origin?.kind;
  if (originKind && originKind !== 'human') return false;
  if (o.turnOrigin && o.turnOrigin !== 'human') return false;
  const content = o.message?.content;
  if (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === 'tool_result')) return false;
  return true;
}

/**
 * Hint بالعربي: دالة تحليل محتوى ملف JSONL لجلسة Claude Code إلى محادثة منظمة (مفصولة للاختبار).
 */
export function parseClaudeCodeJsonl(raw: string, ref: TranscriptSessionRef): TranscriptSession {
  const session: TranscriptSession = { ref, messages: [] };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line) as Record<string, any>;
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') session.title = o.customTitle;
    if (o.type === 'summary' && typeof o.summary === 'string' && !session.title) session.title = o.summary;
    if (!session.cwd && typeof o.cwd === 'string') session.cwd = o.cwd;
    if (!session.startedAt && typeof o.timestamp === 'string') session.startedAt = o.timestamp;
    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) continue;

    let message: TranscriptMessage | null = null;
    if (o.type === 'user' && isHumanUserLine(o)) {
      message = { role: 'user', text: cleanTranscriptText(extractClaudeCodeText(o.message?.content)), timestamp: o.timestamp };
    } else if (o.type === 'assistant' && !o.isSidechain && !o.isApiErrorMessage) {
      message = { role: 'assistant', text: cleanTranscriptText(extractClaudeCodeText(o.message?.content)), timestamp: o.timestamp };
    }
    if (message && message.text) {
      const last = session.messages[session.messages.length - 1];
      // ردود Claude المتتالية في نفس الدور تُدمج في رسالة واحدة
      if (last && last.role === 'assistant' && message.role === 'assistant') last.text += `\n\n${message.text}`;
      else session.messages.push(message);
    }
  }
  return session;
}

/**
 * Hint بالعربي: دالة إنشاء موصل Claude Code لمجلد السجلات المحدد.
 */
export function createClaudeCodeConnector(logsDir: string): TranscriptConnector {
  return {
    id: 'claude-code',
    labelAr: 'Claude Code',
    assistantLabel: 'Claude',
    isAvailable: () => fs.existsSync(logsDir),
    listSessions(): TranscriptSessionRef[] {
      if (!fs.existsSync(logsDir)) return [];
      const refs: TranscriptSessionRef[] = [];
      for (const dir of fs.readdirSync(logsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(logsDir, dir.name);
        for (const file of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
          const filePath = path.join(projectDir, file.name);
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_SESSION_FILE_BYTES) continue;
          refs.push({ connectorId: 'claude-code', sessionId: file.name.replace(/\.jsonl$/, ''), filePath, modifiedMs: stat.mtimeMs, sizeBytes: stat.size });
        }
      }
      return refs;
    },
    readSession(ref: TranscriptSessionRef): TranscriptSession {
      return parseClaudeCodeJsonl(fs.readFileSync(ref.filePath, 'utf-8'), ref);
    },
  };
}
