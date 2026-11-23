/**
 * ============================================================================
 * الملف: src/features/knowledge/obsidian-export.ts
 * القسم: Features -> Knowledge (التصدير إلى Obsidian، الإصدار 4.0.3)
 * Hint بالعربي: للمشاريع التي اختارها القائد فقط (knowledgeExport، معطّل افتراضياً)، تُكتب العُقد غير الحساسة
 *               ملاحظاتٍ في Obsidian-Vault/05-Knowledge/<المشروع>/ بروابط [[...]] إلى جيرانها، فيعمل مخطط Obsidian.
 *               - لا يُصدَّر أبداً: الأشخاص والعقود والفواتير (docs/11: «العُقد غير الحساسة»).
 *               - المحتوى حتمي (بلا وقت التصدير)، فالجهازان يكتبان الملاحظة نفسها حرفياً، فلا تعارض في المزامنة.
 *               - لا يُكتب الملف إن لم يتغيّر، وما لم يعد يُولَّد يُحذف — وحدها الملفات التي تحمل علامة التصدير.
 *               - ملفات Obsidian نص صريح على القرص: لذلك الاختيار لكل مشروع وبيد القائد.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchedProjectConfig } from '../../shared/types.ts';
import { ensureDirectoryExists, removePathSync, writeFileAtomic } from '../../shared/file-helpers.ts';
import { getProjectFolderName } from '../project-indexer/obsidian-sync.ts';
import { neighborsOf } from './knowledge-query.ts';
import { readKnowledgeGraph, resolveKnowledgeDir, type KnowledgeGraph } from './knowledge-store.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { AR_COUNT, countAr } from '../../shared/arabic-count.ts';
import { EDGE_TYPE_LABELS_AR, NODE_TYPE_LABELS_AR, type KnowledgeNode, type KnowledgeNodeType } from './knowledge-types.ts';

/** المجلد في Obsidian (04 مستعمل لدليل العائلة) */
export const KNOWLEDGE_EXPORT_DIR = '05-Knowledge';
/** الأنواع التي لا تُصدَّر أبداً */
export const SENSITIVE_TYPES: KnowledgeNodeType[] = ['person', 'contract', 'invoice'];
/** علامة في رأس كل ملف مُصدَّر: لا يُحذف أو يُكتب فوق ملف بلا هذه العلامة (ملاحظات القائد اليدوية تبقى) */
const MARKER = 'sb-knowledge-export: true';
const INDEX_NAME = '00-فهرس المعرفة.md';

const STATUS_AR = { active: 'ساري', outdated: 'قديم', superseded: 'مُستبدَل' } as const;
const CONFIDENCE_AR = { confirmed: 'مؤكد', likely: 'مرجّح', uncertain: 'غير مؤكد' } as const;

/**
 * Hint بالعربي: اسم ملف الملاحظة: العنوان منقّى ومقصوص، ثم ذيل المعرّف (فلا يتكرر الاسم لعنوانين متشابهين).
 */
export function exportFileName(node: KnowledgeNode): string {
  const clean = node.title.replace(/[\\/:*?"<>|#^[\]\r\n\t]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[ .-]+$/, '');
  return `${clean || NODE_TYPE_LABELS_AR[node.type]} (${node.id.slice(-8)})`;
}

/**
 * Hint بالعربي: نص ملاحظة عقدة (حتمي): الرأس، والنص، والعلاقات بروابط [[...]] مرتّبة.
 */
export function renderNodeNote(graph: KnowledgeGraph, node: KnowledgeNode, exported: Set<string>): string {
  const links = neighborsOf(graph, node.id)
    .filter((n) => exported.has(n.node.id))
    .map((n) => `- ${n.direction === 'out' ? EDGE_TYPE_LABELS_AR[n.edge.type] : `← ${EDGE_TYPE_LABELS_AR[n.edge.type]}`}: [[${exportFileName(n.node)}]]`)
    .sort();
  const lines = [
    '---',
    MARKER,
    `id: ${node.id}`,
    `type: ${node.type}`,
    `status: ${node.status}`,
    `date: ${node.createdAt}`,
    '---',
    '',
    `# ${node.title}`,
    '',
    `**${NODE_TYPE_LABELS_AR[node.type]}** · ${STATUS_AR[node.status]} · ${CONFIDENCE_AR[node.confidence]} · ${node.createdAt.slice(0, 10)}`,
    '',
  ];
  if (node.body.trim() && node.body.trim() !== node.title.trim()) lines.push(node.body.trim(), '');
  if (links.length) lines.push('## العلاقات', '', ...links, '');
  lines.push('> كُتبت تلقائياً من معرفة Second Brain. التعديل هنا لا يصل إلى المعرفة، ويُكتب فوقه عند التغيير التالي.', '');
  return lines.join('\n');
}

/** نتيجة التصدير */
export interface ExportResult {
  projects: number;
  written: number;
  unchanged: number;
  removed: number;
}

/**
 * Hint بالعربي: دالة التصدير لكل المشاريع. المشروع غير المختار تُحذف ملفاته المُصدَّرة (إن وُجدت) ولا يُكتب شيء.
 *               المدخلات: المعرفة، والمشاريع، ومجلد Obsidian. لا ترمي على ملف واحد تالف.
 */
export function exportKnowledgeToObsidian(graph: KnowledgeGraph, projects: WatchedProjectConfig[], obsidianDir: string): ExportResult {
  const result: ExportResult = { projects: 0, written: 0, unchanged: 0, removed: 0 };
  const root = path.join(obsidianDir, KNOWLEDGE_EXPORT_DIR);
  for (const project of projects) {
    const dir = path.join(root, getProjectFolderName(project));
    const wanted = new Map<string, string>();
    if (project.knowledgeExport === true) {
      result.projects += 1;
      const nodes = [...graph.nodes.values()]
        .filter((n) => (n.projectId ?? '').toLowerCase() === project.id.toLowerCase() && !SENSITIVE_TYPES.includes(n.type))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const exported = new Set(nodes.map((n) => n.id));
      for (const n of nodes) wanted.set(`${exportFileName(n)}.md`, renderNodeNote(graph, n, exported));
      const byType = new Map<KnowledgeNodeType, KnowledgeNode[]>();
      for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
      const index = ['---', MARKER, '---', '', `# 🧠 معرفة ${project.name}`, ''];
      for (const [type, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        index.push(`## ${NODE_TYPE_LABELS_AR[type]}`, '', ...list.map((n) => `- [[${exportFileName(n)}]]${n.status === 'superseded' ? ' (مُستبدَل)' : ''}`), '');
      }
      if (!nodes.length) index.push('لا عُقد في معرفة هذا المشروع بعد.', '');
      wanted.set(INDEX_NAME, index.join('\n'));
    }
    // ما لم يعد مطلوباً: يُحذف وحده (الملفات بعلامة التصدير فقط)
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md') || wanted.has(name)) continue;
        const file = path.join(dir, name);
        try {
          if (fs.readFileSync(file, 'utf8').includes(MARKER)) {
            removePathSync(file, { force: true });
            result.removed += 1;
          }
        } catch {
          // ملف لا يُقرأ: يُترك
        }
      }
      if (!wanted.size && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) removePathSync(dir, { force: true });
    }
    if (!wanted.size) continue;
    ensureDirectoryExists(dir);
    for (const [name, content] of wanted) {
      const file = path.join(dir, name);
      let current: string | null = null;
      try {
        current = fs.readFileSync(file, 'utf8');
      } catch {
        current = null;
      }
      if (current === content) {
        result.unchanged += 1;
        continue;
      }
      // ملاحظة يدوية بالاسم نفسه (بلا علامة): لا يُكتب فوقها
      if (current !== null && !current.includes(MARKER)) continue;
      writeFileAtomic(file, content);
      result.written += 1;
    }
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length === 0) removePathSync(root, { force: true });
  return result;
}

/**
 * Hint بالعربي: دالة التحديث بعد أي تغيير (الفتح، والاعتماد، والاستخراج، والمزامنة، وتبديل الخيار).
 *               رخيصة ولا تستهلك أي مزوّد. لا ترمي أبداً (التصدير لا يُفشل العملية التي سبقته).
 */
export function refreshKnowledgeExport(
  kk: Buffer,
  options: { projects?: WatchedProjectConfig[]; obsidianDir?: string; knowledgeDir?: string } = {}
): ExportResult | null {
  try {
    const config = options.projects && options.obsidianDir ? null : loadSystemConfig();
    const projects = options.projects ?? config!.watchedProjects;
    if (!projects.some((p) => p.knowledgeExport === true) && !fs.existsSync(path.join(options.obsidianDir ?? config!.paths.obsidianVaultDir, KNOWLEDGE_EXPORT_DIR))) return null;
    const result = exportKnowledgeToObsidian(readKnowledgeGraph(kk, options.knowledgeDir ?? resolveKnowledgeDir()), projects, options.obsidianDir ?? config!.paths.obsidianVaultDir);
    if (result.written || result.removed) logSystemInfo('Knowledge', `تصدير المعرفة إلى Obsidian: كُتبت ${countAr(result.written, AR_COUNT.note)}، وحُذفت ${countAr(result.removed, AR_COUNT.note)}.`);
    return result;
  } catch (err) {
    logSystemInfo('Knowledge', `تعذّر تصدير المعرفة إلى Obsidian الآن: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
