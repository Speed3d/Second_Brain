/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/conversation-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المحادثات المحفوظة)
 * Hint بالعربي: سرد المحادثات المحفوظة، وفتح محادثة، وحذف محادثة أو كل محادثات وضع معيّن.
 *               كلها تتطلب خزنة مفتوحة (المحتوى مشفّر بمفتاحها). القائد يرى محادثاته ومحادثات العائلة،
 *               وجلسة الطوارئ ترى محادثات العائلة فقط.
 * ============================================================================
 */

import {
  deleteAllConversations,
  deleteConversation,
  getConversation,
  listConversations,
  type ConversationMode,
} from '../../conversations/conversation-store.ts';
import { HttpError, sendJson, type RouteDefinition } from '../http-utils.ts';

const CONVERSATION_PATH = /^\/api\/conversations\/([a-z0-9-]{8,64})$/;
const CONVERSATION_DELETE_PATH = /^\/api\/conversations\/([a-z0-9-]{8,64})\/delete$/;

/**
 * Hint بالعربي: دالة قراءة الوضع (commander أو family) من النص.
 */
function readMode(value: unknown, required: boolean): ConversationMode | undefined {
  if (value === 'commander' || value === 'family') return value;
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'الوضع مطلوب: commander أو family.');
    return undefined;
  }
  throw new HttpError(400, 'الوضع يجب أن يكون commander أو family.');
}

/**
 * Hint بالعربي: دالة إرجاع مسارات المحادثات المحفوظة.
 */
export function getConversationRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/conversations',
      requiresSession: true,
      handler: ({ res, query, session }) => {
        sendJson(res, 200, { conversations: listConversations(session!.vault, readMode(query.get('mode'), false)) });
      },
    },
    {
      method: 'GET',
      path: CONVERSATION_PATH,
      requiresSession: true,
      handler: ({ res, params, session }) => {
        const conv = getConversation(session!.vault, params[0]);
        if (!conv) throw new HttpError(404, 'المحادثة غير موجودة.');
        sendJson(res, 200, conv);
      },
    },
    {
      method: 'POST',
      path: CONVERSATION_DELETE_PATH,
      requiresSession: true,
      handler: ({ res, params, session }) => {
        if (!deleteConversation(session!.vault, params[0])) throw new HttpError(404, 'المحادثة غير موجودة.');
        sendJson(res, 200, { ok: true, messageAr: '🗑️ حُذفت المحادثة نهائياً.' });
      },
    },
    {
      method: 'POST',
      path: '/api/conversations/delete-all',
      requiresSession: true,
      handler: ({ res, body, session }) => {
        const count = deleteAllConversations(session!.vault, readMode(body.mode, true)!);
        sendJson(res, 200, { ok: true, deleted: count, messageAr: `🗑️ حُذفت ${count} محادثة نهائياً.` });
      },
    },
  ];
}
