/**
 * ============================================================================
 * الملف: src/features/sync/sync-store.ts
 * القسم: Features -> Sync (المخزن المحلي للمزامنة متعددة الكتابة)
 * Hint بالعربي: كل ما يحفظه الجهاز لنفسه عن المزامنة، داخل data/sync/ (لا يُزامَن):
 *               - index.json    فهرس السجلات: متجه الإصدارات (من عدّل ماذا) + آخر ختم + البصمة + علامة الحذف،
 *                               ومؤشرات القراءة لكل جهاز آخر، وساعة الجهاز الذكية.
 *               - shadow/       آخر محتوى مُزامَن لكل سجل (مشفّر)، لاستعادة المحذوف ونقله إلى السلة.
 *               - conflicts/    التعارضات بانتظار قرار القائد (مشفّرة).
 *               - trash/        المحذوفات لمدة 30 يوماً (مشفّرة).
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { readJsonFileSafe, removePathSync, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { SealedData } from '../../shared/types.ts';
import type { HlcState } from './hlc.ts';
import type { SyncContext } from './sync-context.ts';

/** متجه الإصدارات: لكل جهاز عدد التعديلات التي قام بها على السجل */
export type VersionVector = Record<string, number>;

/** حالة سجل واحد في الفهرس */
export interface IndexRecord {
  vv: VersionVector;
  hlc: string;
  hash: string;
  deleted?: boolean;
  deletedAt?: string;
}

/** فهرس المزامنة المحلي */
export interface SyncIndex {
  format: 'second-brain-sync-index';
  version: 1;
  deviceId: string;
  createdAt: string;
  /** من أين بدأ هذا الجهاز (ترحيل من 1.9 أو إقلاع من نسخة 2.0) */
  origin: { kind: 'legacy-migration' | 'bootstrap' | 'fresh'; legacyVersion?: number; snapshot?: string };
  clock: HlcState;
  records: Record<string, IndexRecord>;
  /** آخر دفعة قُرئت من كل جهاز آخر (اسم الملف) */
  cursors: Record<string, string>;
  lastBatch?: string;
  /** سجلات يجب إعادة نشرها في الدورة القادمة (تعديل محلي بقي أمام حذف من جهاز آخر، أو حسم تعارض) */
  pendingRepublish?: string[];
  lastMergeAt?: string;
  lastPublishAt?: string;
  lastCompactionAt?: string;
  lastTrashPurgeAt?: string;
  lastError?: string;
  lastWarning?: string;
}

/** نتيجة مقارنة متجهَي إصدارات */
export type VvOrder = 'equal' | 'greater' | 'less' | 'concurrent';

/**
 * Hint بالعربي: دالة مقارنة متجهين: greater = الأول رأى كل ما رآه الثاني وأكثر،
 *               concurrent = كلٌّ منهما فيه تعديل لم يره الآخر (تعارض حقيقي).
 */
export function compareVv(a: VersionVector, b: VersionVector): VvOrder {
  let aAhead = false;
  let bAhead = false;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id] ?? 0;
    const y = b[id] ?? 0;
    if (x > y) aAhead = true;
    else if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return 'concurrent';
  if (aAhead) return 'greater';
  if (bAhead) return 'less';
  return 'equal';
}

/**
 * Hint بالعربي: دالة دمج متجهين (الأكبر لكل جهاز).
 */
export function mergeVv(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [id, n] of Object.entries(b)) out[id] = Math.max(out[id] ?? 0, n);
  return out;
}

export function syncDataDir(ctx: SyncContext): string {
  return path.join(ctx.dataDir, 'sync');
}

function indexPath(ctx: SyncContext): string {
  return path.join(syncDataDir(ctx), 'index.json');
}

/**
 * Hint بالعربي: دالة قراءة الفهرس (null إن لم يُرحَّل هذا الجهاز إلى 2.0 بعد).
 */
export function readSyncIndex(ctx: SyncContext): SyncIndex | null {
  const idx = readJsonFileSafe<SyncIndex | null>(indexPath(ctx), null);
  if (!idx) return null;
  if (idx.format !== 'second-brain-sync-index' || idx.version !== 1) throw new Error('فهرس المزامنة المحلي بصيغة غير معروفة.');
  return idx;
}

/**
 * Hint بالعربي: دالة حفظ الفهرس (حفظ ذرّي مع نسختين سابقتين).
 */
export function writeSyncIndex(ctx: SyncContext, index: SyncIndex): void {
  writeFileAtomic(indexPath(ctx), JSON.stringify(index), 2);
}

function keyFile(key: string): string {
  return crypto.createHash('sha1').update(key).digest('hex');
}

// ===================== الظل: آخر محتوى مُزامَن لكل سجل =====================

/**
 * Hint بالعربي: دالة حفظ آخر محتوى مُزامَن لسجل (مشفّراً بمفتاح الخزنة).
 */
export function writeShadow(ctx: SyncContext, dataKey: Buffer, key: string, content: Buffer | null): void {
  const file = path.join(syncDataDir(ctx), 'shadow', `${keyFile(key)}.enc.json`);
  if (content === null) {
    removePathSync(file, { force: true });
    return;
  }
  writeFileAtomic(file, JSON.stringify({ key, sealed: sealWithKey(content, dataKey) }));
}

/**
 * Hint بالعربي: دالة قراءة آخر محتوى مُزامَن لسجل (null إن لم يوجد).
 */
export function readShadow(ctx: SyncContext, dataKey: Buffer, key: string): Buffer | null {
  const file = path.join(syncDataDir(ctx), 'shadow', `${keyFile(key)}.enc.json`);
  const raw = readJsonFileSafe<{ key: string; sealed: SealedData } | null>(file, null);
  if (!raw || raw.key !== key) return null;
  try {
    return openWithKey(raw.sealed, dataKey);
  } catch {
    return null;
  }
}

// ===================== التعارضات =====================

/** تعارض بانتظار قرار القائد */
export interface ConflictEntry {
  id: string;
  key: string;
  kind: 'edit' | 'secret' | 'delete-vs-edit';
  createdAt: string;
  /** الجهاز الذي جاء منه التعديل الآخر */
  otherDevice: string;
  /** أي النسختين معتمدة الآن على هذا الجهاز */
  keptSide: 'local' | 'incoming';
  keptHash: string | null;
  /** النسخة الأخرى (null إن كانت حذفاً) */
  otherContent: string | null;
  otherHash: string | null;
  /** لملفات Obsidian: مسار النسخة الجانبية المكتوبة بجانب الأصلي */
  sideFile?: string;
}

function conflictsDir(ctx: SyncContext): string {
  return path.join(syncDataDir(ctx), 'conflicts');
}

export function saveConflict(ctx: SyncContext, dataKey: Buffer, conflict: ConflictEntry): void {
  writeFileAtomic(path.join(conflictsDir(ctx), `${conflict.id}.enc.json`), JSON.stringify({ id: conflict.id, sealed: sealWithKey(JSON.stringify(conflict), dataKey) }));
}

/**
 * Hint بالعربي: دالة سرد التعارضات المفتوحة (الأحدث أولاً).
 */
export function listConflicts(ctx: SyncContext, dataKey: Buffer): ConflictEntry[] {
  const dir = conflictsDir(ctx);
  if (!fs.existsSync(dir)) return [];
  const out: ConflictEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.enc.json')) continue;
    const raw = readJsonFileSafe<{ sealed: SealedData } | null>(path.join(dir, name), null);
    if (!raw) continue;
    try {
      out.push(JSON.parse(openWithKey(raw.sealed, dataKey).toString('utf8')) as ConflictEntry);
    } catch {
      // تعارض مشفّر بخزنة أخرى: يُتجاهل
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function countConflicts(ctx: SyncContext): number {
  const dir = conflictsDir(ctx);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.enc.json')).length : 0;
}

export function removeConflict(ctx: SyncContext, id: string): void {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('معرّف تعارض غير صالح.');
  removePathSync(path.join(conflictsDir(ctx), `${id}.enc.json`), { force: true });
}

// ===================== السلة =====================

/** عنصر في سلة المحذوفات */
export interface TrashEntry {
  id: string;
  key: string;
  deletedAt: string;
  deletedBy: string;
  content: string;
}

export const TRASH_DAYS = 30;

function trashDir(ctx: SyncContext): string {
  return path.join(syncDataDir(ctx), 'trash');
}

/**
 * Hint بالعربي: دالة نقل محتوى سجل محذوف إلى السلة (مشفّراً).
 */
export function moveToTrash(ctx: SyncContext, dataKey: Buffer, key: string, content: Buffer, deletedBy: string, now: Date = new Date()): string {
  const id = `${now.getTime()}-${keyFile(key).slice(0, 12)}`;
  const entry: TrashEntry = { id, key, deletedAt: now.toISOString(), deletedBy, content: content.toString('base64') };
  writeFileAtomic(path.join(trashDir(ctx), `${id}.enc.json`), JSON.stringify({ id, deletedAt: entry.deletedAt, sealed: sealWithKey(JSON.stringify(entry), dataKey) }));
  return id;
}

export function listTrash(ctx: SyncContext, dataKey: Buffer): TrashEntry[] {
  const dir = trashDir(ctx);
  if (!fs.existsSync(dir)) return [];
  const out: TrashEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.enc.json')) continue;
    const raw = readJsonFileSafe<{ sealed: SealedData } | null>(path.join(dir, name), null);
    if (!raw) continue;
    try {
      out.push(JSON.parse(openWithKey(raw.sealed, dataKey).toString('utf8')) as TrashEntry);
    } catch {
      // مشفّر بخزنة أخرى
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function removeTrashEntry(ctx: SyncContext, id: string): void {
  if (!/^[0-9]{1,16}-[0-9a-f]{12}$/.test(id)) throw new Error('معرّف عنصر السلة غير صالح.');
  removePathSync(path.join(trashDir(ctx), `${id}.enc.json`), { force: true });
}

/**
 * Hint بالعربي: دالة تفريغ ما مضى عليه أكثر من 30 يوماً في السلة. المخرجات: عدد المحذوف.
 */
export function purgeTrash(ctx: SyncContext, now: number = Date.now()): number {
  const dir = trashDir(ctx);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const ms = Number(name.split('-')[0]);
    if (Number.isFinite(ms) && now - ms > TRASH_DAYS * 24 * 3600 * 1000) {
      removePathSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

export function countTrash(ctx: SyncContext): number {
  const dir = trashDir(ctx);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.enc.json')).length : 0;
}
