/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-types.ts
 * القسم: Features -> Knowledge (أساس المعرفة المترابطة، المرحلة 3.1، الإصدار 4.0.0)
 * Hint بالعربي: كل معلومة عُقدة (قرار، حقيقة، مهمة، محادثة…)، والعُقد تربطها علاقات مسمّاة
 *               («اتُّخذ في محادثة»، «استبدل القرار»…). هذا الملف يعرّف الأنواع، ويتحقق من كل عقدة
 *               وعلاقة قبل الحفظ أو عند وصولها بالمزامنة، فلا يدخل التخزين شكل غير متوقع.
 *               القرارات في docs/11 (الموضوع 3)، والتصميم في docs/12 (3.1).
 * ============================================================================
 */

import * as crypto from 'node:crypto';

/** أنواع العُقد (الموضوع 3 في docs/11، ومعها «مهارة» و«مجال تعلّم» من الموضوع 7) */
export const NODE_TYPES = ['decision', 'fact', 'suggestion', 'task', 'goal', 'project', 'person', 'contract', 'invoice', 'conversation', 'skill', 'learning'] as const;
export type KnowledgeNodeType = (typeof NODE_TYPES)[number];

/** حالة العقدة: ساري، أو قديم، أو مُستبدَل (القديم لا يُحذف، يبقى في التاريخ) */
export const NODE_STATUSES = ['active', 'outdated', 'superseded'] as const;
export type KnowledgeNodeStatus = (typeof NODE_STATUSES)[number];

/** درجة الثقة: مؤكد، أو مرجّح، أو غير مؤكد */
export const CONFIDENCE_LEVELS = ['confirmed', 'likely', 'uncertain'] as const;
export type KnowledgeConfidence = (typeof CONFIDENCE_LEVELS)[number];

/** مصدر العقدة */
export const NODE_SOURCES = ['claude-code', 'antigravity-gemini', 'second-brain-assistant', 'manual'] as const;
export type KnowledgeSource = (typeof NODE_SOURCES)[number];

/** العلاقات المسمّاة */
export const EDGE_TYPES = ['related_to', 'decided_in', 'affected', 'blocked', 'supersedes', 'applied_in'] as const;
export type KnowledgeEdgeType = (typeof EDGE_TYPES)[number];

/** أسماء عربية للواجهة والمساعد */
export const NODE_TYPE_LABELS_AR: Record<KnowledgeNodeType, string> = {
  decision: 'قرار',
  fact: 'حقيقة',
  suggestion: 'اقتراح',
  task: 'مهمة',
  goal: 'هدف',
  project: 'مشروع',
  person: 'شخص أو شركة',
  contract: 'عقد',
  invoice: 'فاتورة',
  conversation: 'محادثة',
  skill: 'مهارة',
  learning: 'مجال تعلّم',
};
export const EDGE_TYPE_LABELS_AR: Record<KnowledgeEdgeType, string> = {
  related_to: 'مرتبط بـ',
  decided_in: 'اتُّخذ في محادثة',
  affected: 'أثّر على',
  blocked: 'منع تنفيذ',
  supersedes: 'استبدل القرار',
  applied_in: 'مطبّق في المشروع',
};

/** عقدة معرفة */
export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  title: string;
  body: string;
  /** معرّف المشروع، أو null إن كانت عامة */
  projectId: string | null;
  source: KnowledgeSource;
  status: KnowledgeNodeStatus;
  confidence: KnowledgeConfidence;
  createdAt: string;
  updatedAt: string;
  /**
   * من أين جاءت: سجل الذاكرة الذي رُحّلت منه، أو (4.0.2) مصدر الاستخراج وبصمة محتواه
   * (sourceRef مثل obs:02-Projects/…/x.md أو chat:<id>)، فلا يُعاد استخراج ما لم يتغيّر.
   */
  origin?: { memoryId?: string; sourceRef?: string; contentHash?: string };
}

/** علاقة مسمّاة بين عقدتين (من ← إلى) */
export interface KnowledgeEdge {
  id: string;
  type: KnowledgeEdgeType;
  from: string;
  to: string;
  createdAt: string;
}

/**
 * عنصر في قائمة المراجعة (4.0.1): عقدة مقترحة مع علاقاتها، لا تدخل المعرفة إلا بموافقة القائد
 * (docs/11: «لا يدخل شيء دون موافقته»). المرفوض يبقى بحالته، فلا يُقترح ثانية.
 */
export interface KnowledgeReviewItem {
  id: string;
  proposal: { node: KnowledgeNode; edges: KnowledgeEdge[] };
  reasonAr: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
}

/** معرّف عقدة أو علاقة أو عنصر مراجعة: حروف وأرقام وشرطات، ويبدأ بـ K- للعقدة و E- للعلاقة و R- للمراجعة */
export const NODE_ID = /^K-[A-Za-z0-9-]{1,160}$/;
export const EDGE_ID = /^E-[a-f0-9]{24}$/;
export const REVIEW_ID = /^R-[A-Za-z0-9-]{1,160}$/;
const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

const MAX_TITLE = 300;
const MAX_BODY = 20000;

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Hint بالعربي: دالة التحقق من عقدة (من الواجهة أو MCP أو المزامنة أو ملف). ترمي برسالة عربية إن كانت غير صالحة،
 *               وتعيد نسخة نظيفة بالحقول المعروفة فقط (حقل غريب لا يُحفظ).
 */
export function validateNode(value: unknown): KnowledgeNode {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof v.id !== 'string' || !NODE_ID.test(v.id)) throw new Error('معرّف عقدة المعرفة غير صالح.');
  if (!oneOf(NODE_TYPES, v.type)) throw new Error(`نوع عقدة غير معروف: ${String(v.type).slice(0, 40)}`);
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > MAX_TITLE) throw new Error('عنوان العقدة مطلوب، وحدّه 300 حرف.');
  if (typeof v.body !== 'string' || v.body.length > MAX_BODY) throw new Error('نص العقدة حدّه 20000 حرف.');
  if (!(v.projectId === null || (typeof v.projectId === 'string' && v.projectId.length <= 200))) throw new Error('مشروع العقدة غير صالح.');
  if (!oneOf(NODE_SOURCES, v.source)) throw new Error('مصدر العقدة غير معروف.');
  if (!oneOf(NODE_STATUSES, v.status)) throw new Error('حالة العقدة غير معروفة.');
  if (!oneOf(CONFIDENCE_LEVELS, v.confidence)) throw new Error('درجة الثقة غير معروفة.');
  if (!isIso(v.createdAt) || !isIso(v.updatedAt)) throw new Error('تاريخ العقدة غير صالح.');
  const node: KnowledgeNode = {
    id: v.id,
    type: v.type,
    title: v.title,
    body: v.body,
    projectId: v.projectId as string | null,
    source: v.source,
    status: v.status,
    confidence: v.confidence,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
  const origin = v.origin as Record<string, unknown> | undefined;
  if (origin && typeof origin === 'object') {
    const clean: NonNullable<KnowledgeNode['origin']> = {};
    if (typeof origin.memoryId === 'string' && origin.memoryId.length <= 120) clean.memoryId = origin.memoryId;
    if (typeof origin.sourceRef === 'string' && origin.sourceRef.length <= 600) clean.sourceRef = origin.sourceRef;
    if (typeof origin.contentHash === 'string' && /^[a-f0-9]{8,64}$/.test(origin.contentHash)) clean.contentHash = origin.contentHash;
    if (Object.keys(clean).length) node.origin = clean;
  }
  return node;
}

/**
 * Hint بالعربي: دالة التحقق من علاقة. المعرّف يجب أن يطابق نوعها وطرفيها (حتمي)، فلا تتكرر العلاقة نفسها بمعرّفين.
 */
export function validateEdge(value: unknown): KnowledgeEdge {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!oneOf(EDGE_TYPES, v.type)) throw new Error(`نوع علاقة غير معروف: ${String(v.type).slice(0, 40)}`);
  if (typeof v.from !== 'string' || !NODE_ID.test(v.from) || typeof v.to !== 'string' || !NODE_ID.test(v.to)) throw new Error('طرفا العلاقة غير صالحين.');
  if (v.from === v.to) throw new Error('العلاقة لا تربط العقدة بنفسها.');
  if (!isIso(v.createdAt)) throw new Error('تاريخ العلاقة غير صالح.');
  const id = edgeIdFor(v.type, v.from, v.to);
  if (v.id !== id) throw new Error('معرّف العلاقة لا يطابق نوعها وطرفيها.');
  return { id, type: v.type, from: v.from, to: v.to, createdAt: v.createdAt };
}

/**
 * Hint بالعربي: دالة التحقق من عنصر مراجعة: العقدة المقترحة وعلاقاتها تُفحص كما لو كُتبت فعلاً،
 *               وكل علاقة يجب أن تمسّ العقدة المقترحة (فلا يُدسّ ربط بين عُقد أخرى).
 */
export function validateReviewItem(value: unknown): KnowledgeReviewItem {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof v.id !== 'string' || !REVIEW_ID.test(v.id)) throw new Error('معرّف عنصر المراجعة غير صالح.');
  const proposal = (v.proposal && typeof v.proposal === 'object' ? v.proposal : {}) as Record<string, unknown>;
  const node = validateNode(proposal.node);
  if (!Array.isArray(proposal.edges) || proposal.edges.length > 20) throw new Error('علاقات الاقتراح غير صالحة.');
  const edges = proposal.edges.map(validateEdge);
  if (edges.some((e) => e.from !== node.id && e.to !== node.id)) throw new Error('علاقة في الاقتراح لا تمسّ العقدة المقترحة.');
  if (typeof v.reasonAr !== 'string' || v.reasonAr.length > 2000) throw new Error('سبب الاقتراح غير صالح.');
  if (!isIso(v.createdAt)) throw new Error('تاريخ الاقتراح غير صالح.');
  if (!oneOf(REVIEW_STATUSES, v.status)) throw new Error('حالة الاقتراح غير معروفة.');
  if (v.decidedAt !== undefined && !isIso(v.decidedAt)) throw new Error('تاريخ القرار غير صالح.');
  return { id: v.id, proposal: { node, edges }, reasonAr: v.reasonAr, createdAt: v.createdAt, status: v.status, ...(v.decidedAt ? { decidedAt: v.decidedAt as string } : {}) };
}

/**
 * Hint بالعربي: معرّف علاقة حتمي من نوعها وطرفيها، فالعلاقة نفسها على جهازين تحمل المعرّف نفسه.
 */
export function edgeIdFor(type: KnowledgeEdgeType, from: string, to: string): string {
  return `E-${crypto.createHash('sha256').update(`${type}|${from}|${to}`).digest('hex').slice(0, 24)}`;
}

/**
 * Hint بالعربي: معرّف عقدة جديدة (غير الترحيل): نوعها مختصراً، والوقت، وجزء عشوائي.
 */
export function newNodeId(type: KnowledgeNodeType, now: number = Date.now()): string {
  return `K-${type.slice(0, 4).toUpperCase()}-${now}-${crypto.randomBytes(4).toString('hex')}`;
}
