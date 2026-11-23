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
 *               4.1.0، لوحة «🧠 المعرفة» وسجل القرارات (التصفية: ?project=<معرّف أو none>&type=<نوع>):
 *               - GET  /api/knowledge/graph       العُقد والعلاقات للمخطط، وقوائم المشاريع والأنواع.
 *               - GET  /api/knowledge/node?id=    عقدة بنصها وعلاقاتها.
 *               - GET  /api/knowledge/timeline    الخط الزمني (سجل الحياة الرقمية) بالأحدث.
 *               - GET  /api/knowledge/decisions?project=  سجل قرارات مشروع.
 * ============================================================================
 */

import * as fs from 'node:fs';
import { isKnowledgeDeviceKeyEnabled, decideReviewItem, readDeviceKnowledgeKey, setKnowledgeDeviceKeyEnabled } from '../../knowledge/knowledge-access.ts';
import { deriveKnowledgeKey, readKnowledgeGraph, resolveKnowledgeDir } from '../../knowledge/knowledge-store.ts';
import { EDGE_TYPE_LABELS_AR, NODE_ID, NODE_TYPE_LABELS_AR, REVIEW_ID } from '../../knowledge/knowledge-types.ts';
import { decisionLogView, graphView, nodeDetail, readKnowledgeFilter, timelineView } from '../../knowledge/knowledge-view.ts';
import { syncTick } from '../../sync/sync-service.ts';
import { refreshKnowledgeExport } from '../../knowledge/obsidian-export.ts';
import { AR_COUNT, countAr } from '../../../shared/arabic-count.ts';
import { loadSystemConfig, registerWatchedProject } from '../../../core/config-manager.ts';
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
    // ===================== 4.1.0: لوحة المعرفة وسجل القرارات =====================
    {
      method: 'GET',
      path: '/api/knowledge/graph',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, query, session }) => {
        const view = graphView(readKnowledgeGraph(kkOf(session)), readKnowledgeFilter(query));
        const names = new Map(loadSystemConfig().watchedProjects.map((p) => [p.id.toLowerCase(), p.name]));
        sendJson(res, 200, {
          ...view,
          projects: view.projects.map((id) => ({ id, name: names.get(id.toLowerCase()) ?? id })),
          summaryAr:
            `${countAr(view.nodes.length, AR_COUNT.node)} و${countAr(view.edges.length, AR_COUNT.edge)}` +
            (view.nodes.length < view.totalNodes ? ` من أصل ${countAr(view.totalNodes, AR_COUNT.node)}` : '') +
            (view.omitted ? ` (والأقدم ${countAr(view.omitted, AR_COUNT.node)} لا تُرسم؛ ضيّق التصفية)` : ''),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/knowledge/node',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, query, session }) => {
        const id = query.get('id') ?? '';
        if (!NODE_ID.test(id)) throw new HttpError(400, 'معرّف العقدة غير صالح.');
        const detail = nodeDetail(readKnowledgeGraph(kkOf(session)), id);
        if (!detail) throw new HttpError(404, 'العقدة غير موجودة (ربما حُذفت أو لم تصل بالمزامنة بعد).');
        sendJson(res, 200, { node: detail });
      },
    },
    {
      method: 'GET',
      path: '/api/knowledge/timeline',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, query, session }) => {
        const limit = Number.parseInt(query.get('limit') ?? '', 10);
        const view = timelineView(readKnowledgeGraph(kkOf(session)), readKnowledgeFilter(query), Number.isFinite(limit) ? limit : 300);
        sendJson(res, 200, { ...view, summaryAr: view.items.length < view.total ? `آخر ${countAr(view.items.length, AR_COUNT.node)} من ${view.total}` : countAr(view.total, AR_COUNT.node) });
      },
    },
    {
      method: 'GET',
      path: '/api/knowledge/decisions',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, query, session }) => {
        const projectId = (query.get('project') ?? '').trim();
        if (!projectId || projectId.length > 200) throw new HttpError(400, 'حدّد المشروع.');
        const items = decisionLogView(readKnowledgeGraph(kkOf(session)), projectId);
        sendJson(res, 200, { items, summaryAr: items.length ? countAr(items.length, AR_COUNT.decision) : 'لا قرارات في المعرفة لهذا المشروع بعد.' });
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
        refreshKnowledgeExport(kkOf(session)); // 4.0.3
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
          // عقد «المحادثة» الجديدة تُصدَّر (4.0.3)، والاقتراحات تصل إلى الجهاز الآخر
          refreshKnowledgeExport(kk);
          if (isActiveVaultSession(session)) syncTick(vault);
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
    // ===================== 4.0.3: التصدير إلى Obsidian (لكل مشروع، معطّل افتراضياً) =====================
    {
      method: 'POST',
      path: '/api/knowledge/export',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const projectId = readString(body, 'projectId', 200);
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'الحقل enabled يجب أن يكون true أو false.');
        const project = loadSystemConfig().watchedProjects.find((p) => p.id === projectId);
        if (!project) throw new HttpError(404, 'المشروع غير موجود.');
        const { knowledgeExport: _old, ...rest } = project;
        registerWatchedProject(body.enabled ? { ...rest, knowledgeExport: true } : rest);
        const result = refreshKnowledgeExport(kkOf(session));
        syncTick(session!.vault); // الخيار يصل إلى الجهاز الآخر مع المشروع
        sendJson(res, 200, {
          ok: true,
          enabled: body.enabled,
          messageAr: body.enabled
            ? `📤 صُدّرت معرفة «${project.name}» إلى Obsidian (05-Knowledge): ${countAr((result?.written ?? 0) + (result?.unchanged ?? 0), AR_COUNT.note)}.`
            : `🗑️ أُوقف التصدير، وحُذفت من Obsidian ${countAr(result?.removed ?? 0, AR_COUNT.note)} مُصدَّرة لـ «${project.name}».`,
        });
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
