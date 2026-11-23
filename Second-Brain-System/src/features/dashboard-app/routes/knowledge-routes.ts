/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/knowledge-routes.ts
 * القسم: Dashboard App -> Routes (المعرفة: الحالة وقائمة المراجعة والنسخة المحلية، الإصدار 4.0.1)
 * Hint بالعربي: كلها للقائد فقط (جلسة بكلمة المرور أو البصمة)، لأن المعرفة سياقه ومفتاحها من مفتاح بياناته.
 *               - GET  /api/knowledge/status        الأعداد، وحالة النسخة المحلية لـ MCP.
 *               - GET  /api/knowledge/review        الاقتراحات المنتظرة (الأحدث أولاً).
 *               - POST /api/knowledge/review/decide  { id, decision: approve | reject }
 *               - POST /api/knowledge/device-key     { enabled }  تفعيل النسخة المحلية أو تعطيلها على هذا الجهاز.
 *               4.0.2، الاستخراج بالذكاء (بزر يدوي، والمزوّد يُختار ويُغيَّر في أي وقت):
 *               - GET  /api/knowledge/extract           المزوّد المختار والخيارات، وعدد المحادثات الجديدة، وحالة المهمة.
 *               - POST /api/knowledge/extract/provider  { choice: auto | claude-cli | claude | gemini | ollama }
 *               - POST /api/knowledge/extract/start     { limit? }  مهمة في الخلفية، تتوقف إن قُفلت الخزنة.
 *               - POST /api/knowledge/extract/cancel
 * ============================================================================
 */

import * as fs from 'node:fs';
import { isKnowledgeDeviceKeyEnabled, decideReviewItem, readDeviceKnowledgeKey, setKnowledgeDeviceKeyEnabled } from '../../knowledge/knowledge-access.ts';
import { deriveKnowledgeKey, readKnowledgeGraph, resolveKnowledgeDir } from '../../knowledge/knowledge-store.ts';
import { EDGE_TYPE_LABELS_AR, NODE_TYPE_LABELS_AR, REVIEW_ID } from '../../knowledge/knowledge-types.ts';
import { syncTick } from '../../sync/sync-service.ts';
import { AR_COUNT, countAr } from '../../../shared/arabic-count.ts';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import { isActiveVaultSession } from '../session-manager.ts';
import {
  cancelExtractionJob,
  getExtractionJob,
  getExtractionProviderChoice,
  listExtractionSources,
  providerChat,
  resolveExtractionProviders,
  setExtractionProviderChoice,
  startExtractionJob,
} from '../../knowledge/extraction-service.ts';

/** أسماء المزوّدين بالعربية (كما في الواجهة) */
const PROVIDER_LABELS_AR: Record<string, string> = { 'claude-cli': 'Claude (اشتراكك)', claude: 'Claude API', gemini: 'Gemini API', ollama: 'Ollama' };
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
    // ===================== 4.0.2: الاستخراج بالذكاء =====================
    {
      method: 'GET',
      path: '/api/knowledge/extract',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        const vault = session!.vault;
        const config = loadSystemConfig();
        const sources = listExtractionSources(kkOf(session), { vault, config });
        const choice = getExtractionProviderChoice();
        const order = resolveExtractionProviders('auto', vault, config).map((p) => PROVIDER_LABELS_AR[p.id] ?? p.id);
        const providers = (['auto', 'claude-cli', 'claude', 'gemini', 'ollama'] as const).map((id) => ({
          id,
          labelAr: id === 'auto' ? `حسب ترتيب المساعد (${order.join(' ← ') || 'لا مزوّد'})` : PROVIDER_LABELS_AR[id],
          configured: id === 'auto' ? order.length > 0 : resolveExtractionProviders(id, vault, config)[0].isConfigured(),
        }));
        const pending = sources.filter((s) => s.status !== 'done');
        sendJson(res, 200, {
          choice,
          providers,
          counts: { new: sources.filter((s) => s.status === 'new').length, changed: sources.filter((s) => s.status === 'changed').length, done: sources.filter((s) => s.status === 'done').length },
          pendingAr: countAr(pending.length, AR_COUNT.conversation),
          pending: pending.slice(0, 30).map((s) => ({ title: s.title, projectId: s.projectId, kind: s.kind, status: s.status })),
          job: getExtractionJob(),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/extract/provider',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        let choice;
        try {
          choice = setExtractionProviderChoice(readString(body, 'choice', 40));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        sendJson(res, 200, { ok: true, choice, messageAr: `🔁 مزوّد الاستخراج على هذا الجهاز: ${choice === 'auto' ? 'حسب ترتيب المساعد' : PROVIDER_LABELS_AR[choice]}.` });
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/extract/start',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        const kk = kkOf(session);
        const config = loadSystemConfig();
        const sources = listExtractionSources(kk, { vault, config });
        const limit = Number.isInteger(body.limit) ? Number(body.limit) : 50;
        // مزوّد غير مهيّأ يُرفض قبل البدء، لا بعد أن يفشل على كل محادثة
        const choice = getExtractionProviderChoice();
        const providers = resolveExtractionProviders(choice, vault, config).filter((p) => p.isConfigured());
        if (!providers.length) {
          throw new HttpError(400, choice === 'auto' ? 'لا يوجد مزوّد مهيّأ في ترتيب المساعد. اختر مزوّداً من القائمة، أو أضف مفتاحاً في الإعدادات.' : `المزوّد «${PROVIDER_LABELS_AR[choice]}» غير مهيّأ على هذا الجهاز. اختر غيره من القائمة.`);
        }
        let started;
        try {
          started = startExtractionJob({
            kk,
            vault,
            sources,
            config,
            limit,
            chat: providerChat(providers),
            // ISS-051: لا يكمل الاستخراج بجلسة قُفلت أو استُبدلت
            isActive: () => isActiveVaultSession(session),
          });
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
        started.finished.then(() => {
          if (isActiveVaultSession(session)) syncTick(vault); // الاقتراحات تصل إلى الجهاز الآخر
        }).catch(() => undefined);
        sendJson(res, 200, { ok: true, job: started.state, messageAr: started.state.total ? `🧠 بدأ الاستخراج من ${countAr(started.state.total, AR_COUNT.conversation)}.` : 'لا محادثات جديدة للاستخراج منها.' });
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/extract/cancel',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        sendJson(res, 200, { ok: true, cancelled: cancelExtractionJob(), messageAr: '⏹️ يتوقف الاستخراج بعد المحادثة الحالية.' });
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
