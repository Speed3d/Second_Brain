/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-view.ts
 * القسم: Features -> Knowledge (ما تعرضه الواجهة من المعرفة، الإصدار 4.1.0)
 * Hint بالعربي: دوال نقية تحوّل الرسم المفكوك إلى ما تحتاجه لوحة «🧠 المعرفة» وصفحة المشروع:
 *               - graphView: العُقد والعلاقات بعد التصفية بالمشروع والنوع (بلا النص الكامل، فالمخطط خفيف).
 *               - nodeDetail: عقدة واحدة بنصها وكل علاقاتها.
 *               - timelineView: الخط الزمني (سجل الحياة الرقمية) بالأحدث.
 *               - decisionLogView: سجل قرارات مشروع: متى، وماذا، ولماذا، ومن أين، وما استبدله وما استُبدل به.
 *               كلها للقائد وحده (المسارات commanderOnly)، والتسميات العربية من هنا لا من الواجهة.
 * ============================================================================
 */

import type { KnowledgeGraph } from './knowledge-store.ts';
import { decisionLog, neighborsOf, timeline } from './knowledge-query.ts';
import {
  EDGE_TYPE_LABELS_AR,
  NODE_TYPE_LABELS_AR,
  NODE_TYPES,
  type KnowledgeEdgeType,
  type KnowledgeNode,
  type KnowledgeNodeType,
} from './knowledge-types.ts';

/** حالات العقدة وثقتها ومصدرها بالعربية */
export const NODE_STATUS_LABELS_AR: Record<KnowledgeNode['status'], string> = { active: 'سارٍ', outdated: 'قديم', superseded: 'مُستبدَل' };
export const CONFIDENCE_LABELS_AR: Record<KnowledgeNode['confidence'], string> = { confirmed: 'مؤكَّد', likely: 'مرجَّح', uncertain: 'غير مؤكَّد' };
export const SOURCE_LABELS_AR: Record<KnowledgeNode['source'], string> = {
  'claude-code': 'Claude Code',
  'antigravity-gemini': 'Antigravity',
  'second-brain-assistant': 'مساعد Second Brain',
  manual: 'يدوياً',
};

/** العلاقة مقروءة من الطرف الآخر (العقدة هي «إلى»): «قرار اتُّخذ فيها» بدل «اتُّخذ في محادثة» */
export const EDGE_INVERSE_LABELS_AR: Record<KnowledgeEdgeType, string> = {
  related_to: 'مرتبط بـ',
  decided_in: 'اتُّخذ فيها',
  affected: 'تأثّر به',
  blocked: 'منعه',
  supersedes: 'استُبدل بـ',
  applied_in: 'طُبّق فيه',
};

/** أقصى عدد عُقد يُرسل إلى المخطط في المرة الواحدة (الأحدث أولاً)، والباقي يُذكر عدده */
export const GRAPH_NODE_LIMIT = 1500;

/** تصفية مشتركة: المشروع (بلا حساسية للحالة، و «none» للعامة) والنوع */
export interface KnowledgeFilter {
  projectId?: string;
  type?: KnowledgeNodeType;
}

/**
 * Hint بالعربي: دالة قراءة التصفية من معاملات الطلب. النوع غير المعروف يُتجاهل، والمشروع يُقصّ.
 */
export function readKnowledgeFilter(query: URLSearchParams): KnowledgeFilter {
  const project = (query.get('project') ?? '').trim().slice(0, 200);
  const type = query.get('type') ?? '';
  return {
    ...(project ? { projectId: project } : {}),
    ...((NODE_TYPES as readonly string[]).includes(type) ? { type: type as KnowledgeNodeType } : {}),
  };
}

function matches(node: KnowledgeNode, filter: KnowledgeFilter): boolean {
  if (filter.type && node.type !== filter.type) return false;
  if (filter.projectId) {
    if (filter.projectId === 'none') return !node.projectId;
    if ((node.projectId ?? '').toLowerCase() !== filter.projectId.toLowerCase()) return false;
  }
  return true;
}

/** عقدة مختصرة للمخطط والقوائم */
export interface NodeSummary {
  id: string;
  type: KnowledgeNodeType;
  typeAr: string;
  title: string;
  projectId: string | null;
  status: KnowledgeNode['status'];
  statusAr: string;
  createdAt: string;
}

function summarize(node: KnowledgeNode): NodeSummary {
  return {
    id: node.id,
    type: node.type,
    typeAr: NODE_TYPE_LABELS_AR[node.type],
    title: node.title,
    projectId: node.projectId,
    status: node.status,
    statusAr: NODE_STATUS_LABELS_AR[node.status],
    createdAt: node.createdAt,
  };
}

/** ما يرسمه المخطط */
export interface GraphView {
  nodes: NodeSummary[];
  edges: { id: string; type: string; typeAr: string; from: string; to: string }[];
  /** عُقد طابقت التصفية ولم تُرسل لتجاوز الحد */
  omitted: number;
  /** المشاريع الموجودة في المعرفة كلها (للقائمة)، والأنواع بأعدادها */
  projects: string[];
  types: { id: KnowledgeNodeType; labelAr: string; count: number }[];
  totalNodes: number;
}

/**
 * Hint بالعربي: دالة المخطط: العُقد المطابقة (الأحدث أولاً حتى الحد)، والعلاقات التي طرفاها كلاهما فيها.
 *               القوائم (المشاريع والأنواع) من المعرفة كلها، لا من المصفّى، حتى يبقى التبديل ممكناً.
 */
export function graphView(graph: KnowledgeGraph, filter: KnowledgeFilter = {}, limit = GRAPH_NODE_LIMIT): GraphView {
  const all = [...graph.nodes.values()];
  const matched = all.filter((n) => matches(n, filter)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const kept = matched.slice(0, Math.max(1, limit));
  const ids = new Set(kept.map((n) => n.id));
  const edges = [...graph.edges.values()]
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ id: e.id, type: e.type, typeAr: EDGE_TYPE_LABELS_AR[e.type], from: e.from, to: e.to }));
  const projects = [...new Set(all.map((n) => n.projectId).filter((p): p is string => Boolean(p)))].sort((a, b) => a.localeCompare(b));
  const counts = new Map<KnowledgeNodeType, number>();
  for (const n of all) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const types = NODE_TYPES.filter((t) => counts.has(t)).map((t) => ({ id: t, labelAr: NODE_TYPE_LABELS_AR[t], count: counts.get(t)! }));
  return { nodes: kept.map(summarize), edges, omitted: matched.length - kept.length, projects, types, totalNodes: all.length };
}

/** تفاصيل عقدة واحدة */
export interface NodeDetail extends NodeSummary {
  body: string;
  confidenceAr: string;
  sourceAr: string;
  updatedAt: string;
  links: { relationAr: string; direction: 'out' | 'in'; node: NodeSummary }[];
}

/**
 * Hint بالعربي: دالة تفاصيل عقدة بنصها وكل علاقاتها (الأحدث أولاً). المخرجات: null إن لم توجد.
 */
export function nodeDetail(graph: KnowledgeGraph, id: string): NodeDetail | null {
  const node = graph.nodes.get(id);
  if (!node) return null;
  return {
    ...summarize(node),
    body: node.body,
    confidenceAr: CONFIDENCE_LABELS_AR[node.confidence],
    sourceAr: SOURCE_LABELS_AR[node.source],
    updatedAt: node.updatedAt,
    links: neighborsOf(graph, id).map((n) => ({ relationAr: n.direction === 'out' ? EDGE_TYPE_LABELS_AR[n.edge.type] : EDGE_INVERSE_LABELS_AR[n.edge.type], direction: n.direction, node: summarize(n.node) })),
  };
}

/**
 * Hint بالعربي: دالة الخط الزمني للواجهة (الأحدث أولاً)، بعدد العلاقات لكل عقدة.
 */
export function timelineView(graph: KnowledgeGraph, filter: KnowledgeFilter = {}, limit = 300): { items: (NodeSummary & { links: number })[]; total: number } {
  const degree = new Map<string, number>();
  for (const e of graph.edges.values()) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const all = timeline(graph, { limit: 5000 }).filter((n) => matches(n, filter));
  return { items: all.slice(0, Math.max(1, Math.min(limit, 1000))).map((n) => ({ ...summarize(n), links: degree.get(n.id) ?? 0 })), total: all.length };
}

/** بند في سجل القرارات كما تعرضه صفحة المشروع */
export interface DecisionLogItem extends NodeSummary {
  body: string;
  sourceAr: string;
  confidenceAr: string;
  decidedIn: NodeSummary[];
  supersedes: NodeSummary[];
  supersededBy: NodeSummary[];
  affects: NodeSummary[];
}

/**
 * Hint بالعربي: دالة سجل قرارات مشروع للواجهة (الأحدث أولاً، والمُستبدَل يبقى بحالته).
 */
export function decisionLogView(graph: KnowledgeGraph, projectId: string): DecisionLogItem[] {
  return decisionLog(graph, projectId).map((e) => ({
    ...summarize(e.decision),
    body: e.decision.body,
    sourceAr: SOURCE_LABELS_AR[e.decision.source],
    confidenceAr: CONFIDENCE_LABELS_AR[e.decision.confidence],
    decidedIn: e.decidedIn.map(summarize),
    supersedes: e.supersedes.map(summarize),
    supersededBy: e.supersededBy.map(summarize),
    affects: e.affects.map(summarize),
  }));
}
