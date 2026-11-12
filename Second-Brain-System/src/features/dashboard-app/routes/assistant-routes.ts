/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/assistant-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المساعد الذكي)
 * Hint بالعربي: - سؤال المساعد برد كامل (/api/assistant) أو برد متدفق SSE (/api/assistant/stream).
 *               - حالة المزوّدين (مهيّأ / متاح) لعرضها في الواجهة.
 *               - حفظ مفاتيح Claude و Gemini داخل الخزنة المشفرة (للقائد فقط).
 *               - اختبار الاتصال بمزوّد واحد برسالة قصيرة ثابتة (/api/assistant/test).
 * ============================================================================
 */

import { loadSystemConfig } from '../../../core/config-manager.ts';
import { askSecondBrainAssistant } from '../../assistant/assistant-engine.ts';
import { testProviderConnection, TESTABLE_PROVIDERS } from '../../assistant/provider-tester.ts';
import { buildProviders, PROVIDER_KEY_SECRET_IDS, resolveProviderKeys } from '../../assistant/providers/provider-registry.ts';
import { deleteVaultSecret, upsertVaultSecret } from '../../vault/vault-manager.ts';
import { HttpError, readString, sendJson, type RouteContext, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة قراءة السؤال والوضع وسجل المحادثة من جسم الطلب والتحقق منها.
 */
export function readAssistantInput(body: Record<string, unknown>): {
  question: string;
  mode: 'commander' | 'wife_emergency';
  history: unknown;
} {
  const question = readString(body, 'question', 8000).trim();
  if (!question) throw new HttpError(400, 'يرجى كتابة السؤال.');
  return { question, mode: body.mode === 'wife_emergency' ? 'wife_emergency' : 'commander', history: body.history };
}

/**
 * Hint بالعربي: دالة كتابة حدث SSE واحد إلى المتصفح.
 */
export function writeSseEvent(ctx: RouteContext, eventName: string, data: unknown): void {
  if (!ctx.res.writableEnded) ctx.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات المساعد الذكي.
 */
export function getAssistantRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/assistant',
      handler: async ({ res, body, session }) => {
        const input = readAssistantInput(body);
        const reply = await askSecondBrainAssistant(input.question, input.mode, { history: input.history, vault: session?.vault });
        sendJson(res, 200, reply);
      },
    },
    {
      method: 'POST',
      path: '/api/assistant/stream',
      handler: async (ctx) => {
        const input = readAssistantInput(ctx.body);
        const controller = new AbortController();
        ctx.res.on('close', () => {
          if (!ctx.res.writableFinished) controller.abort();
        });
        ctx.res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        try {
          const reply = await askSecondBrainAssistant(input.question, input.mode, {
            history: input.history,
            vault: ctx.session?.vault,
            signal: controller.signal,
            onDelta: (text) => writeSseEvent(ctx, 'delta', { text }),
            onReset: () => writeSseEvent(ctx, 'reset', {}),
          });
          writeSseEvent(ctx, 'done', { providerUsed: reply.providerUsed, model: reply.model, attempts: reply.attempts });
        } catch (err) {
          writeSseEvent(ctx, 'error', { error: err instanceof Error ? err.message : 'حدث خطأ غير متوقع' });
        }
        ctx.res.end();
      },
    },
    {
      method: 'GET',
      path: '/api/assistant/providers',
      handler: async ({ res, session }) => {
        const config = loadSystemConfig();
        const providers = buildProviders(config, resolveProviderKeys(session?.vault), {
          assistantNameAr: config.assistantNameAr,
          familyTitle: config.familyMemberTitle,
          projects: [],
          projectReports: [],
          memoryCount: 0,
        });
        const list = await Promise.all(
          providers.map(async (p) => {
            const configured = p.isConfigured();
            const availability = configured ? await p.checkAvailability() : { ok: false, reasonAr: 'غير مهيّأ' };
            return { id: p.id, labelAr: p.labelAr, configured, available: availability.ok, reasonAr: availability.reasonAr ?? null };
          })
        );
        sendJson(res, 200, { vaultUnlocked: Boolean(session), providers: list });
      },
    },
    {
      method: 'POST',
      path: '/api/assistant/test',
      commanderOnly: true,
      handler: async ({ res, body, session }) => {
        const providerId = String(body.provider ?? '');
        if (!TESTABLE_PROVIDERS.includes(providerId as never)) throw new HttpError(400, 'المزوّد يجب أن يكون claude-cli أو claude أو gemini أو ollama.');
        sendJson(res, 200, await testProviderConnection(providerId as (typeof TESTABLE_PROVIDERS)[number], session?.vault));
      },
    },
    {
      method: 'POST',
      path: '/api/assistant/keys',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const provider = body.provider === 'gemini' ? 'gemini' : body.provider === 'claude' ? 'claude' : null;
        if (!provider) throw new HttpError(400, 'المزوّد يجب أن يكون claude أو gemini.');
        const apiKey = readString(body, 'apiKey', 500).trim();
        const secretId = PROVIDER_KEY_SECRET_IDS[provider];
        if (!apiKey) {
          deleteVaultSecret(session!.vault, secretId);
          sendJson(res, 200, { ok: true, messageAr: `تم حذف مفتاح ${provider} من الخزنة.` });
          return;
        }
        upsertVaultSecret(session!.vault, {
          id: secretId,
          category: 'api_key',
          title: provider === 'claude' ? 'مفتاح Claude API (للمساعد الذكي)' : 'مفتاح Gemini API (للمساعد الذكي)',
          secretValue: apiKey,
          notesForCommanderAr: 'يستخدمه المساعد الذكي داخل البرنامج فقط، ولا يُقرأ إلا والخزنة مفتوحة.',
          notesForWifeAr: 'مفتاح تقني يشغّل المساعد الذكي. لا تشاركيه مع أحد.',
        });
        sendJson(res, 200, { ok: true, messageAr: `🔒 تم حفظ مفتاح ${provider} مشفراً داخل الخزنة.` });
      },
    },
  ];
}
