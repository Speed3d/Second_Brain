/**
 * ============================================================================
 * الملف: src/features/assistant/providers/ollama-provider.ts
 * القسم: Features -> Assistant -> Providers (مزوّد Ollama المحلي)
 * Hint بالعربي: يتصل بخادم Ollama على هذا الجهاز (بدون إنترنت) ويبثّ الرد سطراً بسطر (NDJSON).
 *               قبل الاستخدام يتحقق أن Ollama يعمل وأن النموذج المطلوب مثبّت.
 * ============================================================================
 */

import type { AIProvider, ProviderChatRequest, ProviderChatResult } from './provider-types.ts';
import { describeHttpStatusAr, ProviderError, withTimeout } from './provider-types.ts';
import { readNdjsonStream } from './stream-parsers.ts';

/**
 * Hint بالعربي: إعدادات إنشاء مزوّد Ollama.
 */
export interface OllamaProviderOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
}

/**
 * Hint بالعربي: دالة إنشاء مزوّد Ollama المحلي.
 */
export function createOllamaProvider(options: OllamaProviderOptions): AIProvider {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  return {
    id: 'ollama',
    labelAr: `Ollama محلي (${options.model})`,
    isConfigured: () => Boolean(endpoint && options.model),
    async checkAvailability(signal?: AbortSignal) {
      try {
        const res = await fetch(`${endpoint}/api/tags`, { signal: withTimeout(signal, 1500) });
        if (!res.ok) return { ok: false, reasonAr: `Ollama: ${describeHttpStatusAr(res.status)}` };
        const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
        const names = (json.models ?? []).map((m) => String(m.name ?? m.model ?? ''));
        const found = names.some((n) => n === options.model || n.startsWith(`${options.model}:`));
        return found ? { ok: true } : { ok: false, reasonAr: `النموذج ${options.model} غير مثبّت في Ollama` };
      } catch {
        return { ok: false, reasonAr: 'Ollama لا يعمل على هذا الجهاز' };
      }
    },
    async chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult> {
      let response: Response;
      try {
        response = await fetch(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.model,
            stream: true,
            messages: [{ role: 'system', content: request.system }, ...request.messages],
          }),
          signal: withTimeout(request.signal, options.timeoutMs),
        });
      } catch (err) {
        throw new ProviderError('ollama', `تعذر الاتصال بـ Ollama: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
      }
      if (!response.ok || !response.body) {
        throw new ProviderError('ollama', `Ollama: ${describeHttpStatusAr(response.status)}`, { status: response.status });
      }

      let text = '';
      let streamError: string | undefined;
      await readNdjsonStream(response.body, (obj) => {
        if (typeof obj.error === 'string') streamError = obj.error;
        const piece = (obj.message as { content?: string } | undefined)?.content;
        if (typeof piece === 'string' && piece) {
          text += piece;
          onDelta?.(piece);
        }
      });
      if (streamError) throw new ProviderError('ollama', `Ollama: ${streamError}`);
      if (!text.trim()) throw new ProviderError('ollama', 'Ollama أعاد رداً فارغاً.');
      return { text, model: options.model };
    },
  };
}
