/**
 * ============================================================================
 * الملف: src/features/assistant/providers/provider-registry.ts
 * القسم: Features -> Assistant -> Providers (سجلّ المزوّدين وترتيب التراجع)
 * Hint بالعربي: يحدد ترتيب تجربة المزوّدين من الإعدادات، ويجلب مفاتيح API من الخزنة المفتوحة
 *               (أو من متغيرات البيئة)، ثم يجرّب المزوّدين واحداً تلو الآخر حتى ينجح أحدهم.
 *               المزوّد المحلي يكون دائماً آخر خط دفاع، فلا يبقى السؤال بلا إجابة.
 * ============================================================================
 */

import type { AIProviderId, SystemBrandingConfig } from '../../../shared/types.ts';
import type { UnlockedVault } from '../../vault/vault-manager.ts';
import { createClaudeCliProvider, locateClaudeCli } from './claude-cli-provider.ts';
import { createClaudeProvider } from './claude-provider.ts';
import { createGeminiProvider } from './gemini-provider.ts';
import { createLocalKnowledgeProvider, type LocalKnowledgeContext } from './local-knowledge-provider.ts';
import { createOllamaProvider } from './ollama-provider.ts';
import { ProviderError, type AIProvider, type ProviderChatRequest } from './provider-types.ts';

/** معرّفات أسرار مفاتيح API داخل الخزنة */
export const PROVIDER_KEY_SECRET_IDS = { claude: 'API-KEY-CLAUDE', gemini: 'API-KEY-GEMINI' } as const;

/**
 * Hint بالعربي: مفاتيح API المتاحة للمزوّدين السحابيين.
 */
export interface ProviderKeys {
  claude?: string;
  gemini?: string;
}

/**
 * Hint بالعربي: دالة تحديد ترتيب المزوّدين: من providerOrder إن وُجد، وإلا من الوضع (هجين/سحابي/محلي).
 *               الافتراضي بلا فواتير إضافية: Claude عبر الاشتراك ثم Ollama. مزوّدو API (Claude و Gemini)
 *               لا يُضافون إلا عند تفعيل الخيار المتقدم apiKeysEnabled. المحلي يُضاف آخراً دائماً ولا يتكرر أي مزوّد.
 */
export function resolveProviderOrder(ai: SystemBrandingConfig['aiConfig']): AIProviderId[] {
  let order: AIProviderId[];
  if (ai.providerOrder && ai.providerOrder.length) {
    order = [...ai.providerOrder];
  } else {
    const primary: AIProviderId = ai.cloudProvider;
    const secondary: AIProviderId = primary === 'claude' ? 'gemini' : 'claude';
    const api: AIProviderId[] = ai.apiKeysEnabled ? [primary, secondary] : [];
    if (ai.defaultMode === 'local') order = ['ollama'];
    else if (ai.defaultMode === 'cloud') order = ['claude-cli', ...api];
    else order = ['claude-cli', ...api, 'ollama'];
  }
  const unique = order.filter((id, idx) => order.indexOf(id) === idx && id !== 'local');
  return [...unique, 'local'];
}

/**
 * Hint بالعربي: دالة جلب مفاتيح API: من الخزنة المفتوحة أولاً، ثم من متغيرات البيئة.
 *               مفاتيح الخزنة لا تُقرأ إلا والخزنة مفتوحة.
 */
export function resolveProviderKeys(vault?: UnlockedVault | null, env: NodeJS.ProcessEnv = process.env): ProviderKeys {
  const fromVault = (id: string): string | undefined => vault?.secrets.find((s) => s.id === id)?.secretValue || undefined;
  return {
    claude: fromVault(PROVIDER_KEY_SECRET_IDS.claude) ?? env.ANTHROPIC_API_KEY ?? undefined,
    gemini: fromVault(PROVIDER_KEY_SECRET_IDS.gemini) ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? undefined,
  };
}

/**
 * Hint بالعربي: دالة إنشاء قائمة المزوّدين مرتبة حسب الإعدادات.
 */
export function buildProviders(config: SystemBrandingConfig, keys: ProviderKeys, localContext: LocalKnowledgeContext): AIProvider[] {
  return resolveProviderOrder(config.aiConfig).map((id) => buildProviderById(id, config, keys, localContext));
}

/**
 * Hint بالعربي: دالة إنشاء مزوّد واحد بمعرّفه (بغض النظر عن ترتيب المزوّدين)، مثلاً لزر "اختبار الاتصال".
 */
export function buildProviderById(id: AIProviderId, config: SystemBrandingConfig, keys: ProviderKeys, localContext: LocalKnowledgeContext): AIProvider {
  const ai = config.aiConfig;
  const timeoutMs = ai.requestTimeoutMs ?? 120000;
  if (id === 'claude-cli') return createClaudeCliProvider({ launch: locateClaudeCli(ai.claudeCliPath), model: ai.claudeCliModel || 'sonnet', timeoutMs });
  if (id === 'claude') return createClaudeProvider({ apiKey: keys.claude, model: ai.claudeModel, effort: ai.claudeEffort, timeoutMs });
  if (id === 'gemini') return createGeminiProvider({ apiKey: keys.gemini, model: ai.geminiModel, timeoutMs });
  if (id === 'ollama') return createOllamaProvider({ endpoint: ai.ollamaEndpoint, model: ai.ollamaModel, timeoutMs });
  return createLocalKnowledgeProvider(localContext);
}

/**
 * Hint بالعربي: سجل محاولة مزوّد واحد (للعرض والتشخيص).
 */
export interface ProviderAttempt {
  providerId: AIProviderId;
  ok: boolean;
  skipped?: boolean;
  messageAr?: string;
}

/**
 * Hint بالعربي: دالة تجربة المزوّدين بالترتيب حتى ينجح أحدهم.
 *               - المزوّد غير المهيّأ (بلا مفتاح) أو غير المتاح (Ollama متوقف، Claude Code غير مسجّل الدخول) يُتخطى فوراً.
 *               - إذا فشل مزوّد بعد أن بدأ البثّ تُستدعى onReset لمسح النص الجزئي قبل تجربة التالي.
 */
export async function runProvidersWithFallback(
  providers: AIProvider[],
  request: ProviderChatRequest,
  handlers: { onDelta?: (text: string) => void; onReset?: () => void; onProviderStart?: (p: AIProvider) => void } = {}
): Promise<{ text: string; providerUsed: AIProviderId; model: string; attempts: ProviderAttempt[] }> {
  const attempts: ProviderAttempt[] = [];
  for (const provider of providers) {
    if (request.signal?.aborted) break;
    if (!provider.isConfigured()) {
      attempts.push({ providerId: provider.id, ok: false, skipped: true, messageAr: 'غير مهيّأ' });
      continue;
    }
    if (provider.id === 'ollama' || provider.id === 'claude-cli') {
      const availability = await provider.checkAvailability(request.signal);
      if (!availability.ok) {
        attempts.push({ providerId: provider.id, ok: false, skipped: true, messageAr: availability.reasonAr });
        continue;
      }
    }
    handlers.onProviderStart?.(provider);
    let emitted = false;
    try {
      const result = await provider.chat(request, (piece) => {
        emitted = true;
        handlers.onDelta?.(piece);
      });
      attempts.push({ providerId: provider.id, ok: true });
      return { text: result.text, providerUsed: provider.id, model: result.model, attempts };
    } catch (err) {
      const message = err instanceof ProviderError || err instanceof Error ? err.message : String(err);
      attempts.push({ providerId: provider.id, ok: false, messageAr: message });
      if (emitted) handlers.onReset?.();
    }
  }
  throw new ProviderError('local', `تعذر الحصول على إجابة من أي مزوّد: ${attempts.map((a) => `${a.providerId}: ${a.messageAr ?? ''}`).join(' | ')}`);
}
