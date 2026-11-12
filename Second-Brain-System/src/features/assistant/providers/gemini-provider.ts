/**
 * ============================================================================
 * الملف: src/features/assistant/providers/gemini-provider.ts
 * القسم: Features -> Assistant -> Providers (مزوّد Gemini)
 * Hint بالعربي: يتصل بواجهة Gemini (streamGenerateContent?alt=sse) عبر HTTP مباشرة ويبثّ الرد.
 *               المفتاح يُرسل في الرأس x-goog-api-key (وليس في الرابط حتى لا يظهر في السجلات).
 * ============================================================================
 */

import type { AIProvider, ProviderChatRequest, ProviderChatResult } from './provider-types.ts';
import { describeHttpStatusAr, ProviderError, withTimeout } from './provider-types.ts';
import { readSseStream } from './stream-parsers.ts';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Hint بالعربي: إعدادات إنشاء مزوّد Gemini.
 */
export interface GeminiProviderOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * Hint بالعربي: دالة بناء جسم طلب Gemini: تعليمات النظام، والرسائل بأدوار user/model.
 */
export function buildGeminiRequestBody(request: ProviderChatRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: request.maxOutputTokens ?? 8192 },
  };
}

/**
 * Hint بالعربي: دالة إنشاء مزوّد Gemini.
 */
export function createGeminiProvider(options: GeminiProviderOptions): AIProvider {
  const baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    id: 'gemini',
    labelAr: `Gemini (${options.model})`,
    isConfigured: () => Boolean(options.apiKey),
    async checkAvailability() {
      return options.apiKey ? { ok: true } : { ok: false, reasonAr: 'لا يوجد مفتاح Gemini API محفوظ' };
    },
    async chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult> {
      if (!options.apiKey) throw new ProviderError('gemini', 'لا يوجد مفتاح Gemini API محفوظ');
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
          body: JSON.stringify(buildGeminiRequestBody(request)),
          signal: withTimeout(request.signal, options.timeoutMs),
        });
      } catch (err) {
        throw new ProviderError('gemini', `تعذر الاتصال بـ Gemini: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
      }

      if (!response.ok || !response.body) {
        let detail = '';
        try {
          const json = (await response.json()) as { error?: { message?: string } } | Array<{ error?: { message?: string } }>;
          detail = (Array.isArray(json) ? json[0]?.error?.message : json.error?.message) ?? '';
        } catch {
          // لا يوجد جسم JSON
        }
        throw new ProviderError('gemini', `Gemini: ${describeHttpStatusAr(response.status)}${detail ? ` — ${detail}` : ''}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let text = '';
      let blocked: string | undefined;
      let finishReason: string | undefined;
      await readSseStream(response.body, (_eventName, data) => {
        let payload: Record<string, any>;
        try {
          payload = JSON.parse(data) as Record<string, any>;
        } catch {
          return;
        }
        if (payload.promptFeedback?.blockReason) blocked = String(payload.promptFeedback.blockReason);
        const candidate = payload.candidates?.[0];
        if (candidate?.finishReason) finishReason = String(candidate.finishReason);
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === 'string' && !part.thought) {
            text += part.text;
            if (part.text) onDelta?.(part.text);
          }
        }
      });

      if (blocked) throw new ProviderError('gemini', `Gemini حجب الطلب (${blocked}).`);
      if (!text.trim()) throw new ProviderError('gemini', `Gemini أعاد رداً فارغاً${finishReason ? ` (${finishReason})` : ''}.`);
      return { text, model: options.model, stopReason: finishReason };
    },
  };
}
