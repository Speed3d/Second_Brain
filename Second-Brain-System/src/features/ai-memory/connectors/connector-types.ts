/**
 * ============================================================================
 * الملف: src/features/ai-memory/connectors/connector-types.ts
 * القسم: Features -> AI Memory -> Connectors (الأنواع المشتركة لموصلات المحادثات)
 * Hint بالعربي: واجهة موحّدة لكل مصدر محادثات (Claude Code، Antigravity، وأي مصدر مستقبلي)،
 *               حتى يُضاف موصل جديد بملف واحد دون تعديل ساحب المحادثات.
 * ============================================================================
 */

/**
 * Hint بالعربي: مرجع جلسة محادثة على القرص (دون قراءة محتواها).
 */
export interface TranscriptSessionRef {
  connectorId: string;
  sessionId: string;
  filePath: string;
  modifiedMs: number;
  sizeBytes: number;
}

/**
 * Hint بالعربي: رسالة واحدة مستخرجة من المحادثة.
 */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

/**
 * Hint بالعربي: محادثة كاملة بعد القراءة والتنظيف.
 */
export interface TranscriptSession {
  ref: TranscriptSessionRef;
  title?: string;
  cwd?: string;
  startedAt?: string;
  messages: TranscriptMessage[];
}

/**
 * Hint بالعربي: عقد الموصل: معرّفه، اسمه، هل مصدره موجود، سرد الجلسات، وقراءة جلسة واحدة.
 */
export interface TranscriptConnector {
  id: string;
  labelAr: string;
  assistantLabel: string;
  isAvailable(): boolean;
  listSessions(): TranscriptSessionRef[];
  readSession(ref: TranscriptSessionRef): TranscriptSession;
}

/** حدود القراءة حتى لا تتضخم الأرشفة */
export const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGES_PER_SESSION = 2000;
export const MAX_MESSAGE_CHARS = 20000;

/**
 * Hint بالعربي: دالة تنظيف نص الرسالة: إزالة وسوم التذكيرات والأوامر الداخلية، وقصّ النص الطويل جداً.
 */
export function cleanTranscriptText(raw: string): string {
  const cleaned = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-(?:stdout|stderr|caveat)>/g, '')
    .replace(/<\/?command-(?:name|message|args)>/g, '')
    .trim();
  return cleaned.length > MAX_MESSAGE_CHARS ? `${cleaned.slice(0, MAX_MESSAGE_CHARS)}\n… (تم اختصار الرسالة)` : cleaned;
}
