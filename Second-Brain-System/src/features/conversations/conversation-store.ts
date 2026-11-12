/**
 * ============================================================================
 * الملف: src/features/conversations/conversation-store.ts
 * القسم: Features -> Conversations (حفظ محادثات المساعد داخل البرنامج)
 * Hint بالعربي: يحفظ كل محادثة في ملف مستقل داخل data/conversations/، ومحتواها (العنوان والرسائل)
 *               مشفّر بمفتاح بيانات الخزنة (AES-256-GCM)، فلا يُقرأ إلا والخزنة مفتوحة.
 *               خارج التشفير فقط: المعرّف، والوضع (القائد/العائلة)، والتواريخ، وعدد الرسائل — لعرض القائمة بسرعة.
 *               الحذف نهائي (ملف واحد أو كل محادثات وضع معيّن)، وتشمل محادثات البرنامج أداة التصفير في وضع التطوير.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { ensureDirectoryExists, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { AIProviderId, SealedData } from '../../shared/types.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';

/** وضع المحادثة: غرفة القيادة أو وضع العائلة */
export type ConversationMode = 'commander' | 'family';

/** حدود الحماية: طول الرسالة، وعدد الرسائل في المحادثة الواحدة */
const MAX_MESSAGE_CHARS = 40000;
const MAX_MESSAGES = 400;
const ID_PATTERN = /^[a-z0-9-]{8,64}$/;

/**
 * Hint بالعربي: رسالة محفوظة في المحادثة.
 */
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  providerUsed?: AIProviderId;
  model?: string;
}

/**
 * Hint بالعربي: المحادثة كاملة بعد فك التشفير.
 */
export interface Conversation {
  id: string;
  mode: ConversationMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

/**
 * Hint بالعربي: ملخص المحادثة لعرض القائمة.
 */
export interface ConversationSummary {
  id: string;
  mode: ConversationMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** شكل الملف على القرص */
interface ConversationFile {
  version: 1;
  id: string;
  mode: ConversationMode;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  sealed: SealedData;
}

/**
 * Hint بالعربي: دالة مسار مجلد المحادثات (داخل data الخاص بالنظام، غير مرفوع إلى Git).
 */
export function resolveConversationsDir(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'conversations');
}

/**
 * Hint بالعربي: دالة التحقق من معرّف المحادثة (يمنع أي محاولة للخروج من المجلد).
 */
export function assertConversationId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error('معرّف المحادثة غير صالح.');
}

function fileFor(id: string): string {
  assertConversationId(id);
  return path.join(resolveConversationsDir(), `${id}.enc.json`);
}

function readFile(id: string): ConversationFile | null {
  const filePath = fileFor(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ConversationFile;
}

function decrypt(file: ConversationFile, vault: UnlockedVault): { title: string; messages: StoredMessage[] } {
  return JSON.parse(openWithKey(file.sealed, vault.dataKey).toString('utf8')) as { title: string; messages: StoredMessage[] };
}

function writeConversation(conv: Conversation, vault: UnlockedVault): void {
  ensureDirectoryExists(resolveConversationsDir());
  const file: ConversationFile = {
    version: 1,
    id: conv.id,
    mode: conv.mode,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    sealed: sealWithKey(JSON.stringify({ title: conv.title, messages: conv.messages }), vault.dataKey),
  };
  writeFileAtomic(fileFor(conv.id), JSON.stringify(file, null, 2));
}

/**
 * Hint بالعربي: دالة صنع عنوان قصير من أول سؤال.
 */
export function makeConversationTitle(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean || 'محادثة';
}

/**
 * Hint بالعربي: الأوضاع التي يحق للجلسة الوصول إليها: القائد يرى الكل، وجلسة الطوارئ ترى محادثات العائلة فقط.
 */
export function allowedModesFor(vault: UnlockedVault): ConversationMode[] {
  return vault.unlockedBy === 'commander' ? ['commander', 'family'] : ['family'];
}

/**
 * Hint بالعربي: دالة حفظ سؤال وجوابه: تُنشئ محادثة جديدة إن لم يُعطَ معرّف (أو لم يوجد)، وإلا تُضيف إليها.
 *               تُرجع معرّف المحادثة.
 */
export function appendConversationTurn(
  vault: UnlockedVault,
  input: {
    conversationId?: string;
    mode: ConversationMode;
    question: string;
    answer: string;
    providerUsed?: AIProviderId;
    model?: string;
  }
): string {
  if (!allowedModesFor(vault).includes(input.mode)) throw new Error('لا تملك هذه الجلسة صلاحية حفظ هذا النوع من المحادثات.');
  const now = new Date().toISOString();
  let conv: Conversation | null = null;
  if (input.conversationId && ID_PATTERN.test(input.conversationId)) {
    const existing = readFile(input.conversationId);
    if (existing && existing.mode === input.mode) {
      const plain = decrypt(existing, vault);
      conv = { id: existing.id, mode: existing.mode, createdAt: existing.createdAt, updatedAt: now, title: plain.title, messages: plain.messages };
    }
  }
  if (!conv) {
    conv = { id: crypto.randomUUID(), mode: input.mode, title: makeConversationTitle(input.question), createdAt: now, updatedAt: now, messages: [] };
  }
  conv.messages.push(
    { role: 'user', content: input.question.slice(0, MAX_MESSAGE_CHARS), at: now },
    { role: 'assistant', content: input.answer.slice(0, MAX_MESSAGE_CHARS), at: now, providerUsed: input.providerUsed, model: input.model }
  );
  if (conv.messages.length > MAX_MESSAGES) conv.messages = conv.messages.slice(-MAX_MESSAGES);
  writeConversation(conv, vault);
  return conv.id;
}

/**
 * Hint بالعربي: دالة سرد المحادثات المسموحة لهذه الجلسة (الأحدث أولاً)، مع فك تشفير العناوين فقط.
 */
export function listConversations(vault: UnlockedVault, mode?: ConversationMode): ConversationSummary[] {
  const dir = resolveConversationsDir();
  if (!fs.existsSync(dir)) return [];
  const allowed = allowedModesFor(vault).filter((m) => !mode || m === mode);
  const out: ConversationSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    const match = /^([a-z0-9-]{8,64})\.enc\.json$/.exec(name);
    if (!match) continue;
    try {
      const file = readFile(match[1]);
      if (!file || !allowed.includes(file.mode)) continue;
      out.push({
        id: file.id,
        mode: file.mode,
        title: decrypt(file, vault).title,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        messageCount: file.messageCount,
      });
    } catch {
      // ملف تالف أو مشفّر بخزنة أخرى: يُتجاهل في القائمة
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Hint بالعربي: دالة قراءة محادثة واحدة كاملة (ترجع null إن لم توجد أو لم يكن للجلسة حق الوصول).
 */
export function getConversation(vault: UnlockedVault, id: string): Conversation | null {
  const file = readFile(id);
  if (!file || !allowedModesFor(vault).includes(file.mode)) return null;
  const plain = decrypt(file, vault);
  return { id: file.id, mode: file.mode, createdAt: file.createdAt, updatedAt: file.updatedAt, title: plain.title, messages: plain.messages };
}

/**
 * Hint بالعربي: دالة حذف محادثة واحدة نهائياً. ترجع true إن حُذفت.
 */
export function deleteConversation(vault: UnlockedVault, id: string): boolean {
  const file = readFile(id);
  if (!file || !allowedModesFor(vault).includes(file.mode)) return false;
  fs.rmSync(fileFor(id), { force: true });
  return true;
}

/**
 * Hint بالعربي: دالة حذف كل محادثات وضع معيّن (المسموح للجلسة فقط). ترجع عدد المحذوف.
 */
export function deleteAllConversations(vault: UnlockedVault, mode: ConversationMode): number {
  if (!allowedModesFor(vault).includes(mode)) return 0;
  const dir = resolveConversationsDir();
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = /^([a-z0-9-]{8,64})\.enc\.json$/.exec(name);
    if (!match) continue;
    try {
      if (readFile(match[1])?.mode !== mode) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      count += 1;
    } catch {
      // ملف تالف: يُترك
    }
  }
  return count;
}
