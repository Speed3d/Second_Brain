/**
 * ============================================================================
 * الملف: src/features/ai-memory/connectors/antigravity-connector.ts
 * القسم: Features -> AI Memory -> Connectors (موصل Google Antigravity)
 * Hint بالعربي: يقرأ محادثات Antigravity من brain/<محادثة>/.system_generated/logs/transcript.jsonl
 *               ويستخرج طلبات القائد (USER_INPUT) وردود المساعد (PLANNER_RESPONSE) كاملة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanTranscriptText,
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSION_FILE_BYTES,
  type TranscriptConnector,
  type TranscriptSession,
  type TranscriptSessionRef,
} from './connector-types.ts';

/**
 * Hint بالعربي: دالة تحليل ملف JSONL لمحادثة Antigravity إلى محادثة منظمة (مفصولة للاختبار).
 */
export function parseAntigravityJsonl(raw: string, ref: TranscriptSessionRef): TranscriptSession {
  const session: TranscriptSession = { ref, messages: [] };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || session.messages.length >= MAX_MESSAGES_PER_SESSION) continue;
    let o: { type?: string; content?: unknown; timestamp?: string; created_at?: string };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.content !== 'string') continue;
    const role = o.type === 'USER_INPUT' ? 'user' : o.type === 'PLANNER_RESPONSE' ? 'assistant' : null;
    if (!role) continue;
    const text = cleanTranscriptText(o.content.replace(/<[^>]+>/g, ''));
    if (!text) continue;
    const timestamp = o.timestamp ?? o.created_at;
    if (!session.startedAt && timestamp) session.startedAt = timestamp;
    session.messages.push({ role, text, timestamp });
  }
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (firstUser) session.title = firstUser.text.split('\n')[0].slice(0, 80);
  return session;
}

/**
 * Hint بالعربي: دالة إنشاء موصل Antigravity لمجلد السجلات المحدد.
 */
export function createAntigravityConnector(brainDir: string): TranscriptConnector {
  return {
    id: 'antigravity',
    labelAr: 'Google Antigravity',
    assistantLabel: 'Antigravity',
    isAvailable: () => fs.existsSync(brainDir),
    listSessions(): TranscriptSessionRef[] {
      if (!fs.existsSync(brainDir)) return [];
      const refs: TranscriptSessionRef[] = [];
      for (const dir of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const filePath = path.join(brainDir, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_SESSION_FILE_BYTES) continue;
        refs.push({ connectorId: 'antigravity', sessionId: dir.name, filePath, modifiedMs: stat.mtimeMs, sizeBytes: stat.size });
      }
      return refs;
    },
    readSession(ref: TranscriptSessionRef): TranscriptSession {
      return parseAntigravityJsonl(fs.readFileSync(ref.filePath, 'utf-8'), ref);
    },
  };
}
