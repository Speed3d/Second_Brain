/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-migration.ts
 * القسم: Features -> Knowledge (الترحيل من الذاكرة المشتركة، الإصدار 4.0.0)
 * Hint بالعربي: كل سجل في ai-memory-store.json يصبح عقدة «محادثة»، وكل قرار فيه عقدة «قرار»
 *               مرتبطة بها بعلاقة «اتُّخذ في محادثة» (docs/11 الموضوع 3).
 *               - المعرّفات والمحتوى حتمية من السجل نفسه (حتى updatedAt = createdAt)، فإن رحّل الجهازان
 *                 السجل نفسه أنتجا الملف المنطقي نفسه، فلا تعارض في المزامنة.
 *               - يُعاد التشغيل بلا ضرر: ما رُحّل لا يُكتب ثانية، وما أُضيف إلى الذاكرة لاحقاً يُرحَّل.
 *               - الملف القديم لا يُلمس، ويبقى حتى تنجح التجربة على الأجهزة.
 * ============================================================================
 */

import type { SharedAIMemoryEntry } from '../../shared/types.ts';
import { querySharedAIMemory } from '../ai-memory/shared-memory-service.ts';
import { readKnowledgeGraph, resolveKnowledgeDir, writeEdge, writeNode, writeReviewItem } from './knowledge-store.ts';
import { edgeIdFor, NODE_SOURCES, validateEdge, validateNode, type KnowledgeNode, type KnowledgeSource } from './knowledge-types.ts';

/** معرّف عقدة المحادثة المرحّلة من سجل ذاكرة */
export function conversationNodeId(memoryId: string): string {
  return `K-CONV-${memoryId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 140)}`;
}

/** معرّف عقدة القرار رقم n (من 1) في سجل ذاكرة */
export function decisionNodeId(memoryId: string, n: number): string {
  return `K-DEC-${memoryId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 140)}-${n}`;
}

/** نتيجة الترحيل */
export interface MigrationResult {
  entries: number;
  createdNodes: number;
  createdEdges: number;
  /** اقتراحات أُضيفت إلى قائمة المراجعة (سجلات 4.0.1 فما بعد) */
  createdReviews: number;
  alreadyMigrated: number;
  skipped: number;
}

const TITLE_MAX = 120;

function titleOf(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean || 'قرار';
}

/**
 * Hint بالعربي: دالة بناء العُقد والعلاقات من سجل ذاكرة واحد (بلا كتابة). حتمية تماماً.
 */
export function nodesFromMemoryEntry(entry: SharedAIMemoryEntry): { conversation: KnowledgeNode; decisions: KnowledgeNode[] } {
  const source: KnowledgeSource = (NODE_SOURCES as readonly string[]).includes(entry.sourceAI) ? (entry.sourceAI as KnowledgeSource) : 'manual';
  const base = {
    projectId: entry.projectId ? entry.projectId.slice(0, 200) : null,
    source,
    status: 'active' as const,
    confidence: 'confirmed' as const,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
    origin: { memoryId: entry.id },
  };
  const conversation: KnowledgeNode = {
    ...base,
    id: conversationNodeId(entry.id),
    type: 'conversation',
    title: titleOf(entry.title || 'محادثة'),
    body: entry.summaryAr.slice(0, 20000),
  };
  const decisions = entry.keyDecisionsAr
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d, i): KnowledgeNode => ({ ...base, id: decisionNodeId(entry.id, i + 1), type: 'decision', title: titleOf(d), body: d.slice(0, 20000) }));
  return { conversation, decisions };
}

/**
 * Hint بالعربي: دالة الترحيل. المدخلات: مفتاح المعرفة، والسجلات (الافتراضي: الذاكرة المشتركة على هذا الجهاز)،
 *               ومجلد المعرفة. السجل الذي رُحّلت محادثته يُعدّ «مرحّلاً» ولا يُكتب ثانية.
 */
export function migrateSharedMemoryToKnowledge(
  kk: Buffer,
  entries: SharedAIMemoryEntry[] = querySharedAIMemory(),
  dir: string = resolveKnowledgeDir()
): MigrationResult {
  const result: MigrationResult = { entries: entries.length, createdNodes: 0, createdEdges: 0, createdReviews: 0, alreadyMigrated: 0, skipped: 0 };
  const existing = readKnowledgeGraph(kk, dir);
  for (const entry of entries) {
    let built;
    try {
      built = nodesFromMemoryEntry(entry);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (existing.nodes.has(built.conversation.id)) {
      result.alreadyMigrated += 1;
      continue;
    }
    // عقدة المحادثة هي علامة «رُحّل»، فتُكتب أخيراً بعد التحقق من الكل وكتابة القرارات وعلاقاتها.
    // فإن فشل شيء في المنتصف، يُعاد ترحيل السجل كاملاً في المرة التالية.
    const edges = built.decisions.map((d) => ({ id: edgeIdFor('decided_in', d.id, built.conversation.id), type: 'decided_in' as const, from: d.id, to: built.conversation.id, createdAt: entry.createdAt }));
    try {
      validateNode(built.conversation);
      for (const d of built.decisions) validateNode(d);
      for (const e of edges) validateEdge(e);
    } catch {
      // سجل غير صالح (تاريخ تالف مثلاً): يُعدّ ولا يوقف الترحيل
      result.skipped += 1;
      continue;
    }
    if (entry.knowledgeReview) {
      // 4.0.1: سجل حُفظ عبر MCP بعد أساس المعرفة: القرارات اقتراحات تنتظر موافقة القائد، لا عُقد مباشرة
      built.decisions.forEach((d, i) => {
        const id = reviewItemId(entry.id, i + 1);
        if (existing.reviews.has(id) || existing.nodes.has(d.id)) return;
        writeReviewItem(kk, { id, proposal: { node: d, edges: [edges[i]] }, reasonAr: `قرار من ${d.source} في «${built.conversation.title}»`, createdAt: entry.createdAt, status: 'pending' }, dir);
        result.createdReviews += 1;
      });
    } else {
      // سجلات ما قبل 4.0.1: كانت القرارات معتمدة في الذاكرة أصلاً، فتُرحَّل عُقداً مباشرة
      for (const d of built.decisions) {
        if (!existing.nodes.has(d.id)) {
          writeNode(kk, d, dir);
          result.createdNodes += 1;
        }
      }
      for (const e of edges) {
        if (!existing.edges.has(e.id)) {
          writeEdge(kk, e, dir);
          result.createdEdges += 1;
        }
      }
    }
    writeNode(kk, built.conversation, dir);
    result.createdNodes += 1;
  }
  return result;
}

/** معرّف اقتراح القرار رقم n (من 1) في سجل ذاكرة */
export function reviewItemId(memoryId: string, n: number): string {
  return `R-DEC-${memoryId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 140)}-${n}`;
}
