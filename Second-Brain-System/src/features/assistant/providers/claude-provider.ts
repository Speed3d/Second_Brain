/**
 * ============================================================================
 * الملف: src/features/assistant/providers/claude-provider.ts
 * القسم: Features -> Assistant -> Providers (مزوّد Claude)
 * Hint بالعربي: يتصل بواجهة Claude Messages API عبر HTTP مباشرة (fetch المدمج، بلا حزم خارجية)
 *               ويبثّ الرد تدريجياً. يستخدم إصدار الواجهة 2026-10-21، ومستوى الجهد (effort)
 *               بدل إعدادات التفكير القديمة، ويفعّل "النموذج البديل عند الرفض" للنماذج التي تدعمه.
 * ============================================================================
 */

import type { AIProvider, ProviderChatRequest, ProviderChatResult } from './provider-types.ts';
import { describeHttpStatusAr, ProviderError, withTimeout } from './provider-types.ts';
import { readSseStream } from './stream-parsers.ts';

export const CLAUDE_API_VERSION = '2026-10-21';
export const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** النماذج التي تقبل fallbacks: "default" (حسب المرجع الرسمي) */
const MODELS_WITH_SERVER_FALLBACK = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Hint بالعربي: إعدادات إنشاء مزوّد Claude.
 */
export interface ClaudeProviderOptions {
  apiKey: string | undefined;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * Hint بالعربي: دالة بناء جسم طلب Claude (مفصولة للاختبار): بثّ، تعليمات النظام، الرسائل، الجهد، والبديل عند الرفض.
 */
export function buildClaudeRequestBody(options: ClaudeProviderOptions, request: ProviderChatRequest): {
  body: Record<string, unknown>;
  betas: string[];
} {
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: request.maxOutputTokens ?? 16000,
    stream: true,
    system: request.system,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const betas: string[] = [];
  if (options.effort && /^claude-(opus|sonnet|fable|haiku|mythos)-5/.test(options.model)) {
    body.output_config = { effort: options.effort };
  }
  if (MODELS_WITH_SERVER_FALLBACK.includes(options.model)) {
    body.fallbacks = 'default';
    betas.push(FALLBACK_BETA);
  }
  return { body, betas };
}

/**
 * Hint بالعربي: دالة إنشاء مزوّد Claude.
 */
export function createClaudeProvider(options: ClaudeProviderOptions): AIProvider {
  const baseUrl = (options.baseUrl ?? CLAUDE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    id: 'claude',
    labelAr: `Claude (${options.model})`,
    isConfigured: () => Boolean(options.apiKey),
    async checkAvailability() {
      return options.apiKey ? { ok: true } : { ok: false, reasonAr: 'لا يوجد مفتاح Claude API محفوظ' };
    },
    async chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult> {
      if (!options.apiKey) throw new ProviderError('claude', 'لا يوجد مفتاح Claude API محفوظ');
      const { body, betas } = buildClaudeRequestBody(options, request);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': CLAUDE_API_VERSION,
      };
      if (betas.length) headers['anthropic-beta'] = betas.join(',');

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: withTimeout(request.signal, options.timeoutMs),
        });
      } catch (err) {
        throw new ProviderError('claude', `تعذر الاتصال بـ Claude: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
      }

      if (!response.ok || !response.body) {
        let detail = '';
        try {
          const json = (await response.json()) as { error?: { message?: string } };
          detail = json.error?.message ?? '';
        } catch {
          // لا يوجد جسم JSON
        }
        throw new ProviderError('claude', `Claude: ${describeHttpStatusAr(response.status)}${detail ? ` — ${detail}` : ''}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let text = '';
      let model = options.model;
      let stopReason: string | undefined;
      let streamError: string | undefined;
      await readSseStream(response.body, (eventName, data) => {
        let payload: Record<string, any>;
        try {
          payload = JSON.parse(data) as Record<string, any>;
        } catch {
          return;
        }
        const type = payload.type ?? eventName;
        if (type === 'message_start' && payload.message?.model) {
          model = String(payload.message.model);
        } else if (type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
          const piece = String(payload.delta.text ?? '');
          text += piece;
          if (piece) onDelta?.(piece);
        } else if (type === 'message_delta' && payload.delta?.stop_reason) {
          stopReason = String(payload.delta.stop_reason);
        } else if (type === 'error') {
          streamError = String(payload.error?.message ?? 'خطأ أثناء البثّ');
        }
      });

      if (streamError) throw new ProviderError('claude', `Claude: ${streamError}`, { retryable: true });
      if (stopReason === 'refusal') throw new ProviderError('claude', 'Claude رفض الإجابة عن هذا الطلب.');
      if (!text.trim()) throw new ProviderError('claude', 'Claude أعاد رداً فارغاً.');
      return { text, model, stopReason };
    },
  };
}
