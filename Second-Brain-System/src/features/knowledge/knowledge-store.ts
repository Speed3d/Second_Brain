/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-store.ts
 * القسم: Features -> Knowledge (مفتاح المعرفة والتخزين المشفّر، الإصدار 4.0.0)
 * Hint بالعربي: كل عقدة وكل علاقة ملف مستقل مختوم بمفتاح المعرفة (KK):
 *                 data/knowledge/nodes/<id>.enc.json   و   data/knowledge/edges/<id>.enc.json
 *               KK مشتقّ من مفتاح البيانات بـ HKDF-SHA256، فالجهازان يحصلان عليه نفسه بلا مزامنة له،
 *               والاشتقاق لا يُعكس فلا يكشف مفتاح البيانات (قرار القائد، docs/12 3.1).
 *               الملف لا يحمل إلا الصيغة والمحتوى المختوم، فلا يُقرأ عنوان ولا نوع بلا المفتاح.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SealedData } from '../../shared/types.ts';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { ensureDirectoryExists, removePathSync, writeFileAtomic } from '../../shared/file-helpers.ts';
import { validateEdge, validateNode, type KnowledgeEdge, type KnowledgeNode } from './knowledge-types.ts';

/** ثابت الاشتقاق: تغييره يعني مفتاحاً جديداً، فلا يُغيَّر إلا مع ترحيل */
const KK_INFO = Buffer.from('second-brain/knowledge/v1');
const FILE_FORMAT = 'second-brain-knowledge';

/** نوعا السجل ومجلداهما */
export type KnowledgeRecordKind = 'node' | 'edge';
const SUBDIR: Record<KnowledgeRecordKind, string> = { node: 'nodes', edge: 'edges' };

/** الملف على القرص */
interface KnowledgeFile {
  format: typeof FILE_FORMAT;
  version: 1;
  sealed: SealedData;
}

/** المعرفة كلها في الذاكرة */
export interface KnowledgeGraph {
  nodes: Map<string, KnowledgeNode>;
  edges: Map<string, KnowledgeEdge>;
  /** ملفات لم تُفتح بهذا المفتاح أو تالفة (تُعدّ ولا تُحذف) */
  unreadable: number;
}

/**
 * Hint بالعربي: دالة اشتقاق مفتاح المعرفة من مفتاح البيانات (32 بايت). ترمي إن لم يكن مفتاح البيانات صالحاً
 *               (جلسة العائلة أو خزنة ممسوحة لا تملك مفتاح بيانات، فلا تملك المعرفة).
 */
export function deriveKnowledgeKey(dataKey: Buffer): Buffer {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('المعرفة تحتاج فتح الخزنة بكلمة المرور الرئيسية أو البصمة.');
  return Buffer.from(crypto.hkdfSync('sha256', dataKey, Buffer.alloc(0), KK_INFO, 32));
}

/**
 * Hint بالعربي: مجلد المعرفة على هذا الجهاز.
 */
export function resolveKnowledgeDir(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'knowledge');
}

/** اسم ملف سجل المعرفة */
export const KNOWLEDGE_FILE = /^(K-[A-Za-z0-9-]{1,160}|E-[a-f0-9]{24})\.enc\.json$/;

function fileFor(dir: string, kind: KnowledgeRecordKind, id: string): string {
  const name = `${id}.enc.json`;
  if (!KNOWLEDGE_FILE.test(name)) throw new Error('معرّف سجل المعرفة غير صالح.');
  return path.join(dir, SUBDIR[kind], name);
}

/**
 * Hint بالعربي: دالة ختم سجل (عقدة أو علاقة) بمحتواه كما يُكتب على القرص.
 */
export function sealKnowledgeRecord(kk: Buffer, value: KnowledgeNode | KnowledgeEdge): string {
  const file: KnowledgeFile = { format: FILE_FORMAT, version: 1, sealed: sealWithKey(JSON.stringify(value), kk) };
  return JSON.stringify(file);
}

/**
 * Hint بالعربي: دالة فتح ملف سجل والتحقق من شكله. ترمي إن لم يُفتح أو لم يكن صالحاً.
 */
export function openKnowledgeRecord(kk: Buffer, kind: KnowledgeRecordKind, raw: string | Buffer): KnowledgeNode | KnowledgeEdge {
  const file = JSON.parse(raw.toString()) as Partial<KnowledgeFile>;
  if (file.format !== FILE_FORMAT || file.version !== 1 || !file.sealed) throw new Error('ملف معرفة بصيغة غير معروفة.');
  const value = JSON.parse(openWithKey(file.sealed, kk).toString('utf8')) as unknown;
  return kind === 'node' ? validateNode(value) : validateEdge(value);
}

/**
 * Hint بالعربي: دالة كتابة عقدة (بعد التحقق منها).
 */
export function writeNode(kk: Buffer, node: KnowledgeNode, dir: string = resolveKnowledgeDir()): KnowledgeNode {
  const clean = validateNode(node);
  const file = fileFor(dir, 'node', clean.id);
  ensureDirectoryExists(path.dirname(file));
  writeFileAtomic(file, sealKnowledgeRecord(kk, clean));
  return clean;
}

/**
 * Hint بالعربي: دالة كتابة علاقة (بعد التحقق منها). العلاقة إلى عقدة غير موجودة مسموحة هنا،
 *               لأن العقدتين قد تصلان بالمزامنة بترتيب مختلف؛ الاستعلامات تتجاهل الطرف الغائب.
 */
export function writeEdge(kk: Buffer, edge: KnowledgeEdge, dir: string = resolveKnowledgeDir()): KnowledgeEdge {
  const clean = validateEdge(edge);
  const file = fileFor(dir, 'edge', clean.id);
  ensureDirectoryExists(path.dirname(file));
  writeFileAtomic(file, sealKnowledgeRecord(kk, clean));
  return clean;
}

/**
 * Hint بالعربي: دالة حذف سجل. لا تحتاج المفتاح (الحذف بالاسم). المعرفة لا تحذف القرارات عادةً
 *               (تُعلَّم «مُستبدَل»)، والحذف للتصحيح وللمزامنة.
 */
export function removeKnowledgeRecord(kind: KnowledgeRecordKind, id: string, dir: string = resolveKnowledgeDir()): boolean {
  const file = fileFor(dir, kind, id);
  if (!fs.existsSync(file)) return false;
  removePathSync(file, { force: true });
  return true;
}

/**
 * Hint بالعربي: دالة سرد ملفات المعرفة كما هي على القرص (للمزامنة والنسخ).
 */
export function listKnowledgeFiles(dir: string = resolveKnowledgeDir()): Array<{ kind: KnowledgeRecordKind; id: string; file: string }> {
  const out: Array<{ kind: KnowledgeRecordKind; id: string; file: string }> = [];
  for (const kind of ['node', 'edge'] as const) {
    const sub = path.join(dir, SUBDIR[kind]);
    if (!fs.existsSync(sub)) continue;
    for (const name of fs.readdirSync(sub)) {
      if (!KNOWLEDGE_FILE.test(name)) continue;
      const id = name.slice(0, -'.enc.json'.length);
      if ((kind === 'node') !== id.startsWith('K-')) continue;
      out.push({ kind, id, file: path.join(sub, name) });
    }
  }
  return out;
}

/**
 * Hint بالعربي: دالة قراءة المعرفة كلها بمفتاحها. ملف لا يُفتح يُعدّ ولا يُسقط القراءة.
 */
export function readKnowledgeGraph(kk: Buffer, dir: string = resolveKnowledgeDir()): KnowledgeGraph {
  const graph: KnowledgeGraph = { nodes: new Map(), edges: new Map(), unreadable: 0 };
  for (const f of listKnowledgeFiles(dir)) {
    try {
      const value = openKnowledgeRecord(kk, f.kind, fs.readFileSync(f.file));
      if (value.id !== f.id) throw new Error('اسم الملف لا يطابق المعرّف');
      if (f.kind === 'node') graph.nodes.set(value.id, value as KnowledgeNode);
      else graph.edges.set(value.id, value as KnowledgeEdge);
    } catch {
      graph.unreadable += 1;
    }
  }
  return graph;
}
