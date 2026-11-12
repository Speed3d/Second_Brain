/**
 * ============================================================================
 * الملف: src/features/assistant/provider-tester.ts
 * القسم: Features -> Assistant (اختبار الاتصال بمزوّد ذكاء واحد)
 * Hint بالعربي: يرسل سؤالاً قصيراً جداً لمزوّد واحد (Claude أو Gemini أو Ollama) ويُرجع النتيجة
 *               وسبب الفشل بالعربية وزمن الاستجابة، حتى يتأكد القائد من أن الربط يعمل.
 *               لا يُرسل أي معلومات شخصية أو سياق: فقط رسالة اختبار ثابتة، بحد أقصى صغير للرد (تكلفة شبه معدومة).
 * ============================================================================
 */

import type { AIProviderId } from '../../shared/types.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { buildProviderById, resolveProviderKeys } from './providers/provider-registry.ts';

/** المزوّدون القابلون للاختبار (المعرفة المحلية تعمل دائماً ولا تحتاج اختباراً) */
export const TESTABLE_PROVIDERS: AIProviderId[] = ['claude', 'gemini', 'ollama'];

/**
 * Hint بالعربي: نتيجة اختبار الاتصال بمزوّد.
 */
export interface ProviderTestResult {
  providerId: AIProviderId;
  ok: boolean;
  model: string;
  latencyMs: number;
  replyPreview?: string;
  reasonAr?: string;
  hintAr?: string;
}

/**
 * Hint بالعربي: دالة اقتراح الخطوة التالية حسب المزوّد وسبب الفشل.
 */
export function suggestFixAr(providerId: AIProviderId, reason: string): string {
  if (providerId === 'ollama') {
    if (/غير مثب|not found|pull/i.test(reason)) return 'ثبّت النموذج بالأمر: ollama pull <اسم النموذج>، أو غيّر اسم النموذج في الإعدادات.';
    return 'تأكد أن Ollama يعمل على هذا الجهاز (افتح برنامج Ollama أو شغّل: ollama serve) وأن العنوان في الإعدادات صحيح.';
  }
  if (/مفتاح|401|403|غير مهيّأ/.test(reason)) return 'أضف المفتاح أو صحّحه من: الخزنة ← مفاتيح الذكاء الاصطناعي، وتأكد أن الخزنة مفتوحة.';
  if (/حد الاستخدام|429|رصيد|credit|billing/i.test(reason)) return 'تحقق من الرصيد أو حدود الاستخدام في حساب المزوّد.';
  if (/النموذج|400|404/.test(reason)) return 'تحقق من اسم النموذج في الإعدادات.';
  return 'تحقق من اتصال الإنترنت ثم أعد المحاولة.';
}

/**
 * Hint بالعربي: دالة اختبار الاتصال بمزوّد واحد. لا ترمي أخطاء؛ تُرجع النتيجة دائماً.
 */
export async function testProviderConnection(providerId: AIProviderId, vault?: UnlockedVault | null): Promise<ProviderTestResult> {
  const config = loadSystemConfig();
  const provider = buildProviderById(providerId, config, resolveProviderKeys(vault), {
    assistantNameAr: config.assistantNameAr,
    familyTitle: config.familyMemberTitle,
    projects: [],
    projectReports: [],
    memoryCount: 0,
  });
  const model = providerId === 'claude' ? config.aiConfig.claudeModel : providerId === 'gemini' ? config.aiConfig.geminiModel : config.aiConfig.ollamaModel;
  const started = Date.now();
  const fail = (reasonAr: string): ProviderTestResult => ({
    providerId,
    ok: false,
    model,
    latencyMs: Date.now() - started,
    reasonAr,
    hintAr: suggestFixAr(providerId, reasonAr),
  });

  if (!provider.isConfigured()) {
    return fail(vault ? 'لا يوجد مفتاح محفوظ لهذا المزوّد (غير مهيّأ).' : 'غير مهيّأ: الخزنة مقفلة، والمفاتيح محفوظة داخلها.');
  }
  try {
    if (providerId === 'ollama') {
      const availability = await provider.checkAvailability();
      if (!availability.ok) return fail(availability.reasonAr ?? 'Ollama غير متاح.');
    }
    const result = await provider.chat({
      system: 'هذا اختبار اتصال. أجب بكلمة واحدة فقط.',
      messages: [{ role: 'user', content: 'قل: جاهز' }],
      question: 'اختبار اتصال',
      mode: 'commander',
      maxOutputTokens: 64,
      signal: AbortSignal.timeout(60000),
    });
    return { providerId, ok: true, model: result.model || model, latencyMs: Date.now() - started, replyPreview: result.text.trim().slice(0, 120) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
