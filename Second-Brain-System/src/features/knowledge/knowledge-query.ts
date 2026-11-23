/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-query.ts
 * القسم: Features -> Knowledge (الاستعلامات، الإصدار 4.0.0)
 * Hint بالعربي: استعلامات على المعرفة في الذاكرة (بلا قراءة قرص): البحث، والجيران، والمسار بين عقدتين،
 *               وسجل القرارات لكل مشروع، والخط الزمني. كلها دوال نقية على KnowledgeGraph، فتُختبر بلا ملفات.
 * ============================================================================
 */

import type { KnowledgeGraph } from './knowledge-store.ts';
import type { KnowledgeEdge, KnowledgeEdgeType, KnowledgeNode, KnowledgeNodeType } from './knowledge-types.ts';

/** توحيد النص العربي للبحث: بلا تشكيل ولا تطويل، والهمزات والتاء المربوطة والألف المقصورة موحّدة */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** نتيجة بحث */
export interface SearchHit {
  node: KnowledgeNode;
  score: number;
}

/**
 * Hint بالعربي: دالة البحث. أسلوب التقييم نفسه في MCP (عدد الكلمات المطابقة) محسّناً:
 *               - العنوان وزنه 3، والمشروع 2، والنص 1، والتطابق يتجاهل التشكيل والهمزات.
 *               - العقدة «المُستبدَلة» أو «القديمة» تُخفض نصف النقاط، فالساري يظهر أولاً.
 *               - التصفية بالنوع أو المشروع أو الحالة اختيارية.
 */
export function searchKnowledge(
  graph: KnowledgeGraph,
  query: string,
  options: { types?: KnowledgeNodeType[]; projectId?: string; includeSuperseded?: boolean; limit?: number } = {}
): SearchHit[] {
  const terms = normalizeForSearch(query).split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const project = options.projectId?.toLowerCase();
  const hits: SearchHit[] = [];
  for (const node of graph.nodes.values()) {
    if (options.types?.length && !options.types.includes(node.type)) continue;
    if (project && (node.projectId ?? '').toLowerCase() !== project) continue;
    if (!options.includeSuperseded && node.status === 'superseded') continue;
    const title = normalizeForSearch(node.title);
    const body = normalizeForSearch(node.body);
    const proj = normalizeForSearch(node.projectId ?? '');
    let score = 0;
    for (const t of terms) score += (title.includes(t) ? 3 : 0) + (proj.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
    if (!score) continue;
    if (node.status !== 'active') score /= 2;
    hits.push({ node, score });
  }
  hits.sort((a, b) => b.score - a.score || b.node.createdAt.localeCompare(a.node.createdAt));
  return hits.slice(0, Math.max(1, Math.min(options.limit ?? 20, 200)));
}

/** جار واحد */
export interface Neighbor {
  edge: KnowledgeEdge;
  node: KnowledgeNode;
  /** out = العلاقة من العقدة إلى الجار، in = من الجار إلى العقدة */
  direction: 'out' | 'in';
}

/**
 * Hint بالعربي: دالة الجيران: كل علاقة تمسّ العقدة، مع العقدة الأخرى. الطرف الغائب (لم يصل بالمزامنة بعد) يُتجاهل.
 */
export function neighborsOf(graph: KnowledgeGraph, id: string, edgeTypes?: KnowledgeEdgeType[]): Neighbor[] {
  const out: Neighbor[] = [];
  for (const edge of graph.edges.values()) {
    if (edgeTypes?.length && !edgeTypes.includes(edge.type)) continue;
    const otherId = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    if (!otherId) continue;
    const node = graph.nodes.get(otherId);
    if (node) out.push({ edge, node, direction: edge.from === id ? 'out' : 'in' });
  }
  return out.sort((a, b) => b.node.createdAt.localeCompare(a.node.createdAt));
}

/**
 * Hint بالعربي: دالة أقصر مسار بين عقدتين (بحث بالعرض، والعلاقات بلا اتجاه). المخرجات: معرّفات العُقد
 *               من الأولى إلى الأخيرة، أو null إن لم يوجد مسار خلال maxDepth.
 */
export function findPath(graph: KnowledgeGraph, fromId: string, toId: string, maxDepth = 6): string[] | null {
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) return null;
  if (fromId === toId) return [fromId];
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a)!.push(b);
  };
  for (const e of graph.edges.values()) {
    if (!graph.nodes.has(e.from) || !graph.nodes.has(e.to)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const previous = new Map<string, string>([[fromId, '']]);
  let frontier = [fromId];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const n of (adjacency.get(current) ?? []).sort()) {
        if (previous.has(n)) continue;
        previous.set(n, current);
        if (n === toId) {
          const pathIds = [toId];
          let step = current;
          while (step) {
            pathIds.unshift(step);
            step = previous.get(step) ?? '';
          }
          return pathIds;
        }
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

/** بند في سجل القرارات */
export interface DecisionLogEntry {
  decision: KnowledgeNode;
  /** المحادثة التي اتُّخذ فيها (علاقة decided_in) */
  decidedIn: KnowledgeNode[];
  /** القرارات التي استبدلها هذا القرار */
  supersedes: KnowledgeNode[];
  /** القرار الذي استبدله (إن كان مُستبدَلاً) */
  supersededBy: KnowledgeNode[];
  /** ما أثّر عليه أو منع تنفيذه */
  affects: KnowledgeNode[];
}

/**
 * Hint بالعربي: دالة سجل القرارات لمشروع (أو لكل المشاريع إن لم يُحدَّد): الأحدث أولاً، ولكل قرار سياقه.
 *               المُستبدَل يبقى في السجل (التاريخ لا يُحذف) ويظهر بحالته.
 */
export function decisionLog(graph: KnowledgeGraph, projectId?: string): DecisionLogEntry[] {
  const project = projectId?.toLowerCase();
  const out: DecisionLogEntry[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== 'decision') continue;
    if (project && (node.projectId ?? '').toLowerCase() !== project) continue;
    const near = neighborsOf(graph, node.id);
    out.push({
      decision: node,
      decidedIn: near.filter((n) => n.edge.type === 'decided_in' && n.direction === 'out').map((n) => n.node),
      supersedes: near.filter((n) => n.edge.type === 'supersedes' && n.direction === 'out').map((n) => n.node),
      supersededBy: near.filter((n) => n.edge.type === 'supersedes' && n.direction === 'in').map((n) => n.node),
      affects: near.filter((n) => (n.edge.type === 'affected' || n.edge.type === 'blocked') && n.direction === 'out').map((n) => n.node),
    });
  }
  return out.sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt));
}

/** كلمات السؤال الشائعة التي لا تفيد البحث («لماذا اخترنا…») */
const QUESTION_STOPWORDS = new Set(
  ['لماذا', 'ماذا', 'كيف', 'متى', 'اين', 'هل', 'ما', 'من', 'في', 'على', 'عن', 'الى', 'مع', 'او', 'ثم', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'اخترنا', 'قررنا', 'اعتمدنا', 'استخدمنا', 'نستخدم', 'لم', 'لا', 'كان', 'كانت', 'هو', 'هي', 'نحن', 'انا', 'why', 'what', 'how', 'did', 'we', 'the', 'a', 'is', 'to', 'of'].map(normalizeForSearch)
);

/**
 * Hint بالعربي: دالة سياق المعرفة للمساعد (4.0.4): العُقد المتعلقة بالسؤال، ولكل قرار المحادثة التي اتُّخذ فيها،
 *               وما استبدله وما استُبدل به، بمعرّفاتها وتواريخها. المُستبدَل يُذكر (للتاريخ) بحالته.
 *               المخرجات: نص للحقن داخل وسم البيانات غير الموثوقة، أو '' إن لم يطابق شيء.
 */
export function buildKnowledgeContextForAssistant(graph: KnowledgeGraph, question: string, limit = 8): { text: string; nodeIds: string[] } {
  const query = normalizeForSearch(question)
    .split(/[\s،,.?؟!:;()«»"']+/)
    .filter((t) => t.length >= 2 && !QUESTION_STOPWORDS.has(t))
    .join(' ');
  if (!query) return { text: '', nodeIds: [] };
  const hits = searchKnowledge(graph, query, { includeSuperseded: true, limit });
  if (!hits.length) return { text: '', nodeIds: [] };
  const lines: string[] = [];
  for (const { node } of hits) {
    const near = neighborsOf(graph, node.id);
    const titles = (pred: (n: Neighbor) => boolean) => near.filter(pred).map((n) => `«${n.node.title}» (${n.node.id}، ${n.node.createdAt.slice(0, 10)})`);
    const decidedIn = titles((n) => n.edge.type === 'decided_in' && n.direction === 'out');
    const supersedes = titles((n) => n.edge.type === 'supersedes' && n.direction === 'out');
    const supersededBy = titles((n) => n.edge.type === 'supersedes' && n.direction === 'in');
    const status = node.status === 'superseded' ? 'مُستبدَل' : node.status === 'outdated' ? 'قديم' : 'ساري';
    lines.push(
      [
        `- [${node.id}] ${node.type} · ${status} · ${node.createdAt.slice(0, 10)}${node.projectId ? ` · مشروع: ${node.projectId}` : ''}`,
        `  العنوان: ${node.title}`,
        node.body.trim() && node.body.trim() !== node.title.trim() ? `  التفاصيل: ${node.body.slice(0, 600)}` : '',
        decidedIn.length ? `  اتُّخذ في محادثة: ${decidedIn.join('، ')}` : '',
        supersedes.length ? `  استبدل القرار: ${supersedes.join('، ')}` : '',
        supersededBy.length ? `  استُبدل بـ: ${supersededBy.join('، ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return { text: lines.join('\n'), nodeIds: hits.map((h) => h.node.id) };
}

/**
 * Hint بالعربي: دالة الخط الزمني (سجل الحياة الرقمية): العُقد مرتّبة بالأحدث، مع تصفية اختيارية بالفترة والمشروع والنوع.
 */
export function timeline(
  graph: KnowledgeGraph,
  options: { from?: string; to?: string; projectId?: string; types?: KnowledgeNodeType[]; limit?: number } = {}
): KnowledgeNode[] {
  const project = options.projectId?.toLowerCase();
  return [...graph.nodes.values()]
    .filter((n) => (!options.from || n.createdAt >= options.from) && (!options.to || n.createdAt <= options.to))
    .filter((n) => !project || (n.projectId ?? '').toLowerCase() === project)
    .filter((n) => !options.types?.length || options.types.includes(n.type))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Math.min(options.limit ?? 500, 5000)));
}
