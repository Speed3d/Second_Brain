/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/assistant-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المساعد الذكي)
 * Hint بالعربي: - سؤال المساعد برد كامل (/api/assistant) أو برد متدفق SSE (/api/assistant/stream).
 *               - حالة المزوّدين (مهيّأ / متاح) لعرضها في الواجهة.
 *               - حفظ مفاتيح Claude و Gemini داخل الخزنة المشفرة (للقائد فقط).
 *               - اختبار الاتصال بمزوّد واحد برسالة قصيرة ثابتة (/api/assistant/test).
 *               - حفظ كل سؤال وجوابه في محادثة مشفّرة بمفتاح الخزنة (عندما تكون الخزنة مفتوحة).
 * ============================================================================
 */

import { loadSystemConfig } from '../../../core/config-manager.ts';
import { logSystemInfo } from '../../../core/logger.ts';
import type { AIProviderId } from '../../../shared/types.ts';
import { askSecondBrainAssistant } from '../../assistant/assistant-engine.ts';
import { testProviderConnection, TESTABLE_PROVIDERS } from '../../assistant/provider-tester.ts';
import { buildProviders, PROVIDER_KEY_SECRET_IDS, resolveProviderKeys } from '../../assistant/providers/provider-registry.ts';
import { appendConversationTurn } from '../../conversations/conversation-store.ts';
import { appendFamilyLog } from '../../family-emergency/family-portal.ts';
import { redactSecrets } from '../../../shared/secret-redaction.ts';
import { checkWriteAccess } from '../../sync/sync-context.ts';
import { deleteVaultSecret, upsertVaultSecret } from '../../vault/vault-manager.ts';
import { HttpError, readString, sendJson, type RouteContext, type RouteDefinition } from '../http-utils.ts';
import { isActiveVaultSession } from '../session-manager.ts';

/**
 * Hint بالعربي: دالة قراءة السؤال والوضع وسجل المحادثة من جسم الطلب والتحقق منها.
 */
export function readAssistantInput(body: Record<string, unknown>): {
  question: string;
  mode: 'commander' | 'wife_emergency';
  history: unknown;
  conversationId?: string;
} {
  const question = readString(body, 'question', 8000).trim();
  if (!question) throw new HttpError(400, 'يرجى كتابة السؤال.');
  const conversationId = typeof body.conversationId === 'string' && /^[a-z0-9-]{8,64}$/.test(body.conversationId) ? body.conversationId : undefined;
  return { question, mode: body.mode === 'wife_emergency' ? 'wife_emergency' : 'commander', history: body.history, conversationId };
}

/**
 * Hint بالعربي: دالة حفظ السؤال وجوابه في المحادثة المشفّرة إن كانت الخزنة مفتوحة.
 *               تُرجع معرّف المحادثة، أو null إن لم يمكن الحفظ (الخزنة مقفلة أو خطأ في الكتابة).
 */
export function saveAssistantTurn(
  session: RouteContext['session'],
  input: ReturnType<typeof readAssistantInput>,
  reply: { answerAr: string; providerUsed: AIProviderId; model: string }
): string | null {
  if (!session) return null;
  // 3.9.8 (ISS-051): الجلسة قُرئت قبل انتظار المزوّد؛ إن قُفلت أو استُبدلت أثناءه فلا يُكتب بها شيء
  if (!isActiveVaultSession(session)) return null;
  // 3.1.0: سجل خطوات الطوارئ: سؤال العائلة للمساعد (أول 120 حرفاً، بعد تنقية الأسرار)
  if (session.vault.unlockedBy !== 'commander') {
    const excerpt = redactSecrets(input.question).text.replace(/\s+/g, ' ').slice(0, 120);
    appendFamilyLog(session.vault, { action: 'assistant_question', detailAr: excerpt + (input.question.length > 120 ? '…' : '') });
  }
  // وضع القراءة (المرحلة ج): المحادثات مشتركة بين الأجهزة، فلا تُحفظ إلا على حامل صلاحية الكتابة
  if (!checkWriteAccess().allowed) return null;
  try {
    return appendConversationTurn(session.vault, {
      conversationId: input.conversationId,
      mode: input.mode === 'wife_emergency' ? 'family' : 'commander',
      question: input.question,
      answer: reply.answerAr,
      providerUsed: reply.providerUsed,
      model: reply.model,
    });
  } catch (err) {
    logSystemInfo('Conversations', `تعذر حفظ المحادثة: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Hint بالعربي: وضع القائد يحتاج جلسة قائد (ISS-053)؛ جلسة العائلة تسأل بوضع العائلة وحده.
 *               يُفحص قبل بدء البث، فيصل الرفض رداً JSON عادياً.
 */
function assertAssistantModeAllowed(session: RouteContext['session'], mode: 'commander' | 'wife_emergency'): void {
  if (mode === 'commander' && session?.vault.unlockedBy !== 'commander') {
    throw new HttpError(403, 'وضع القائد يحتاج فتح الخزنة بكلمة المرور الرئيسية. في جلسة العائلة استعملي وضع العائلة.');
  }
}

/**
 * Hint بالعربي: دالة سبب عدم حفظ المحادثة (لعرضه تحت الرد): الخزنة مقفلة، أو الجهاز في وضع القراءة.
 */
export function unsavedReasonAr(session: RouteContext['session'], conversationId: string | null): string | null {
  if (conversationId) return null;
  if (!session || !isActiveVaultSession(session)) return 'لم تُحفظ هذه المحادثة لأن الخزنة مقفلة. افتح الخزنة ليُحفظ ما بعدها.';
  const access = checkWriteAccess();
  return access.allowed ? 'تعذر حفظ المحادثة.' : `لم تُحفظ هذه المحادثة: ${access.reasonAr}`;
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
      // 3.9.10 (ISS-053): المساعد يرسل سياق القائد إلى مزوّد ويستهلك حصته، فيحتاج جلسة
      requiresSession: true,
      handler: async ({ res, body, session }) => {
        const input = readAssistantInput(body);
        assertAssistantModeAllowed(session, input.mode);
        const reply = await askSecondBrainAssistant(input.question, input.mode, { history: input.history, vault: session?.vault });
        const conversationId = saveAssistantTurn(session, input, reply);
        sendJson(res, 200, { ...reply, conversationId, saved: Boolean(conversationId), saveBlockedAr: unsavedReasonAr(session, conversationId) });
      },
    },
    {
      method: 'POST',
      path: '/api/assistant/stream',
      requiresSession: true,
      handler: async (ctx) => {
        const input = readAssistantInput(ctx.body);
        assertAssistantModeAllowed(ctx.session, input.mode);
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
          const conversationId = saveAssistantTurn(ctx.session, input, reply);
          writeSseEvent(ctx, 'done', { providerUsed: reply.providerUsed, model: reply.model, attempts: reply.attempts, conversationId, saved: Boolean(conversationId), saveBlockedAr: unsavedReasonAr(ctx.session, conversationId) });
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
