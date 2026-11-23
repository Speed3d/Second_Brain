/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/knowledge-routes.ts
 * القسم: Dashboard App -> Routes (المعرفة: الحالة وقائمة المراجعة والنسخة المحلية، الإصدار 4.0.1)
 * Hint بالعربي: كلها للقائد فقط (جلسة بكلمة المرور أو البصمة)، لأن المعرفة سياقه ومفتاحها من مفتاح بياناته.
 *               - GET  /api/knowledge/status        الأعداد، وحالة النسخة المحلية لـ MCP.
 *               - GET  /api/knowledge/review        الاقتراحات المنتظرة (الأحدث أولاً).
 *               - POST /api/knowledge/review/decide  { id, decision: approve | reject }
 *               - POST /api/knowledge/device-key     { enabled }  تفعيل النسخة المحلية أو تعطيلها على هذا الجهاز.
 * ============================================================================
 */

import * as fs from 'node:fs';
import { isKnowledgeDeviceKeyEnabled, decideReviewItem, readDeviceKnowledgeKey, setKnowledgeDeviceKeyEnabled } from '../../knowledge/knowledge-access.ts';
import { deriveKnowledgeKey, readKnowledgeGraph, resolveKnowledgeDir } from '../../knowledge/knowledge-store.ts';
import { EDGE_TYPE_LABELS_AR, NODE_TYPE_LABELS_AR, REVIEW_ID } from '../../knowledge/knowledge-types.ts';
import { syncTick } from '../../sync/sync-service.ts';
import { AR_COUNT, countAr } from '../../../shared/arabic-count.ts';
import { HttpError, readString, sendJson, type RouteContext, type RouteDefinition } from '../http-utils.ts';

function kkOf(session: RouteContext['session']): Buffer {
  return deriveKnowledgeKey(session!.vault.dataKey);
}

/**
 * Hint بالعربي: دالة إرجاع مسارات المعرفة.
 */
export function getKnowledgeRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/knowledge/status',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        const kk = kkOf(session);
        const g = readKnowledgeGraph(kk);
        const device = readDeviceKnowledgeKey();
        sendJson(res, 200, {
          nodes: g.nodes.size,
          edges: g.edges.size,
          pendingReview: [...g.reviews.values()].filter((r) => r.status === 'pending').length,
          unreadable: g.unreadable,
          // الصياغة العربية للأعداد من الخادم (countAr)، فلا تُكرَّر قواعدها في الواجهة
          summaryAr: `🧠 في المعرفة: ${countAr(g.nodes.size, AR_COUNT.node)} و${countAr(g.edges.size, AR_COUNT.edge)}${g.unreadable ? `، و ⚠️ ${countAr(g.unreadable, AR_COUNT.file)} لا يُقرأ` : ''}.`,
          deviceKey: { enabled: isKnowledgeDeviceKeyEnabled(), present: Boolean(device && device.equals(kk)), dirExists: fs.existsSync(resolveKnowledgeDir()) },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/knowledge/review',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        const g = readKnowledgeGraph(kkOf(session));
        const items = [...g.reviews.values()]
          .filter((r) => r.status === 'pending')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200)
          .map((r) => ({
            id: r.id,
            reasonAr: r.reasonAr,
            createdAt: r.createdAt,
            node: { id: r.proposal.node.id, type: r.proposal.node.type, typeAr: NODE_TYPE_LABELS_AR[r.proposal.node.type], title: r.proposal.node.title, body: r.proposal.node.body, projectId: r.proposal.node.projectId, source: r.proposal.node.source },
            links: r.proposal.edges.map((e) => {
              const otherId = e.from === r.proposal.node.id ? e.to : e.from;
              return { relationAr: EDGE_TYPE_LABELS_AR[e.type], title: g.nodes.get(otherId)?.title ?? otherId };
            }),
          }));
        sendJson(res, 200, { items });
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/review/decide',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const id = readString(body, 'id', 200);
        if (!REVIEW_ID.test(id)) throw new HttpError(400, 'معرّف الاقتراح غير صالح.');
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        if (!decision) throw new HttpError(400, 'القرار يجب أن يكون اعتماداً أو رفضاً.');
        let item;
        try {
          item = decideReviewItem(kkOf(session), id, decision);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        syncTick(session!.vault); // يصل القرار إلى الجهاز الآخر
        sendJson(res, 200, { ok: true, status: item.status, messageAr: decision === 'approve' ? '✅ اعتُمد ودخل المعرفة.' : '❌ رُفض، ولن يُقترح ثانية.' });
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/device-key',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'الحقل enabled يجب أن يكون true أو false.');
        setKnowledgeDeviceKeyEnabled(body.enabled, body.enabled ? kkOf(session) : null);
        sendJson(res, 200, {
          ok: true,
          enabled: body.enabled,
          messageAr: body.enabled
            ? '🔑 أدوات الذكاء على هذا الجهاز تصل إلى المعرفة والخزنة مقفلة.'
            : '🔒 حُذفت النسخة المحلية، ولن تُكتب ثانية حتى تعيد التفعيل. أدوات الذكاء على هذا الجهاز لا تصل إلى المعرفة الآن.',
        });
      },
    },
  ];
}
