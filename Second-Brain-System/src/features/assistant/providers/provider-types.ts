/**
 * ============================================================================
 * الملف: src/features/assistant/providers/provider-types.ts
 * القسم: Features -> Assistant -> Providers (الأنواع المشتركة لمزوّدي الذكاء الاصطناعي)
 * Hint بالعربي: واجهة موحّدة يلتزم بها كل مزوّد (Claude، Gemini، Ollama، المحلي)،
 *               حتى يمكن إضافة مزوّد جديد أو تغيير ترتيبهم دون تعديل بقية النظام.
 * ============================================================================
 */

import type { AIProviderId } from '../../../shared/types.ts';

/**
 * Hint بالعربي: رسالة واحدة في المحادثة (المستخدم أو المساعد).
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Hint بالعربي: طلب محادثة موحّد لكل المزوّدين.
 */
export interface ProviderChatRequest {
  system: string;
  messages: ChatTurn[];
  /** للمزوّد المحلي: السؤال الأصلي ووضع الواجهة */
  question: string;
  mode: 'commander' | 'wife_emergency';
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * Hint بالعربي: نتيجة المحادثة من المزوّد.
 */
export interface ProviderChatResult {
  text: string;
  model: string;
  stopReason?: string;
}

/**
 * Hint بالعربي: عقد المزوّد: معرّفه، هل هو جاهز، وتنفيذ المحادثة مع بثّ النص تدريجياً عبر onDelta.
 */
export interface AIProvider {
  id: AIProviderId;
  labelAr: string;
  isConfigured(): boolean;
  checkAvailability(signal?: AbortSignal): Promise<{ ok: boolean; reasonAr?: string }>;
  chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult>;
}

/**
 * Hint بالعربي: خطأ من مزوّد ذكاء اصطناعي يحمل رمز الحالة وسبباً مفهوماً بالعربية.
 */
export class ProviderError extends Error {
  providerId: AIProviderId;
  status?: number;
  retryable: boolean;
  constructor(providerId: AIProviderId, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.providerId = providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Hint بالعربي: دالة تحويل رمز حالة HTTP إلى وصف عربي واضح للمشكلة.
 */
export function describeHttpStatusAr(status: number): string {
  if (status === 400) return 'طلب غير صالح (تحقق من اسم النموذج في الإعدادات)';
  if (status === 401 || status === 403) return 'مفتاح API غير صحيح أو بلا صلاحية';
  if (status === 404) return 'النموذج أو العنوان غير موجود';
  if (status === 408) return 'انتهت مهلة الطلب';
  if (status === 413) return 'المحتوى أكبر من المسموح';
  if (status === 429) return 'تم تجاوز حد الاستخدام مؤقتاً';
  if (status === 529 || status === 503) return 'الخدمة مزدحمة حالياً';
  if (status >= 500) return 'خطأ في خادم المزوّد';
  return `رمز غير متوقع ${status}`;
}

/**
 * Hint بالعربي: دالة دمج إشارة الإلغاء القادمة من المستخدم مع مهلة زمنية قصوى للطلب.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
