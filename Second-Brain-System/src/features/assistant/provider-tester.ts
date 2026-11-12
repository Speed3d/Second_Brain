/**
 * ============================================================================
 * الملف: src/features/assistant/provider-tester.ts
 * القسم: Features -> Assistant (اختبار الاتصال بمزوّد ذكاء واحد)
 * Hint بالعربي: يرسل سؤالاً قصيراً جداً لمزوّد واحد (Claude عبر الاشتراك، Claude API، Gemini API، Ollama) ويُرجع النتيجة
 *               وسبب الفشل بالعربية وزمن الاستجابة، حتى يتأكد القائد من أن الربط يعمل.
 *               لا يُرسل أي معلومات شخصية أو سياق: فقط رسالة اختبار ثابتة، بحد أقصى صغير للرد (تكلفة شبه معدومة).
 * ============================================================================
 */

import type { AIProviderId } from '../../shared/types.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { resetClaudeCliStatusCache } from './providers/claude-cli-provider.ts';
import { buildProviderById, resolveProviderKeys } from './providers/provider-registry.ts';

/** المزوّدون القابلون للاختبار (المعرفة المحلية تعمل دائماً ولا تحتاج اختباراً) */
export const TESTABLE_PROVIDERS: AIProviderId[] = ['claude-cli', 'claude', 'gemini', 'ollama'];

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
  if (providerId === 'claude-cli') {
    if (/غير مثبّت/.test(reason)) return 'ثبّت Claude Code (أو افتح تطبيق Claude لسطح المكتب مرة واحدة)، ثم سجّل الدخول بالأمر: claude auth login';
    if (/auth login|تسجيل الدخول/.test(reason)) return 'افتح PowerShell أو Terminal وشغّل: claude auth login ثم سجّل الدخول بحساب Claude Pro.';
    if (/حد استخدام/.test(reason)) return 'انتظر حتى تتجدد حصة الاشتراك؛ سيجيب Ollama أو المعرفة المحلية حتى ذلك الحين.';
    if (/نموذج/.test(reason)) return 'غيّر نموذج Claude عبر الاشتراك في الإعدادات إلى sonnet أو opus.';
    return 'تأكد أن Claude Code يعمل من الطرفية بالأمر: claude -p "مرحبا"، ثم أعد الاختبار.';
  }
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
  const ai = config.aiConfig;
  const model = providerId === 'claude-cli' ? ai.claudeCliModel || 'sonnet' : providerId === 'claude' ? ai.claudeModel : providerId === 'gemini' ? ai.geminiModel : ai.ollamaModel;
  const started = Date.now();
  const fail = (reasonAr: string): ProviderTestResult => ({
    providerId,
    ok: false,
    model,
    latencyMs: Date.now() - started,
    reasonAr,
    hintAr: suggestFixAr(providerId, reasonAr),
  });

  if (providerId === 'claude-cli') resetClaudeCliStatusCache();
  if (!provider.isConfigured()) {
    if (providerId === 'claude-cli') return fail('Claude Code غير مثبّت على هذا الجهاز.');
    return fail(vault ? 'لا يوجد مفتاح محفوظ لهذا المزوّد (غير مهيّأ).' : 'غير مهيّأ: الخزنة مقفلة، والمفاتيح محفوظة داخلها.');
  }
  try {
    if (providerId === 'ollama' || providerId === 'claude-cli') {
      const availability = await provider.checkAvailability();
      if (!availability.ok) return fail(availability.reasonAr ?? 'المزوّد غير متاح.');
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
