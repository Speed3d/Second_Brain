/**
 * ============================================================================
 * الملف: src/features/sync/multi-writer-sync.ts
 * القسم: Features -> Sync (محرك المزامنة متعددة الكتابة — الإصدار 2.0)
 * Hint بالعربي: كل جهاز يكتب ويعدّل متى شاء، بلا قفل كتابة:
 *   1) كشف التغييرات المحلية: مقارنة سجلات الجهاز بالفهرس، ونشرها دفعةً مشفّرة في
 *      Second-Brain-Sync/changes/<معرّف الجهاز>/ (لا يكتب جهاز أبداً في مجلد جهاز آخر).
 *   2) الدمج: قراءة دفعات الأجهزة الأخرى، ومقارنة متجهات الإصدارات لكل سجل:
 *      الأحدث يُطبَّق، والأقدم يُتجاهل، والمتزامنان (لم يرَ أحدهما الآخر) تعارض لا يضيع فيه شيء.
 *      الأسرار المتعارضة لا يُحسم أيٌّ منها تلقائياً. التطبيق معاملة واحدة مع نسخة احتياطية قبلها.
 *   3) الضغط: نسخة كاملة مشفّرة في snapshots-v2/ كل أسبوع، وكل جهاز يحذف دفعاته هو فقط بعد 90 يوماً.
 *   4) الترحيل من 1.9 (مرة واحدة): استيراد آخر إصدار قديم، ثم بناء الفهرس من «الأساس» نفسه على كل جهاز،
 *      وقفل الأجهزة القديمة على وضع القراءة حتى تُحدَّث.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openWithKey, sealWithKey, unwrapDataKey } from '../../core/crypto-engine.ts';
import { readAppVersion } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { formatTimestampIso, readJsonFileSafe, removePathSync, toSafeFileName, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { SealedData, VaultSecretItem } from '../../shared/types.ts';
import { readVaultFile, type UnlockedVault, type VaultFileV2 } from '../vault/vault-manager.ts';
import { hlcCompare, hlcParse, hlcReceive, hlcTick, hlcToString, type HlcStamp } from './hlc.ts';
import { applyRecordWrites, hashContent, isGeneratedProjectDoc, normalizeObsidianFileNames, OBSIDIAN_LOCAL_ONLY, readLocalRecords, recordKind, recordsFromLegacyEntries, type RecordMap, type RecordWrite } from './records.ts';
import { importLatestSnapshot, packSharedState, readManifest, saveLocalBackup, type SharedEntries } from './snapshot-sync.ts';
import { readLocalSyncState, readSyncJson, type DeviceInfo, type SyncContext } from './sync-context.ts';
import {
  compareVv,
  listConflicts,
  mergeVv,
  moveToTrash,
  purgeTrash,
  readHeldIncoming,
  writeHeldIncoming,
  readShadow,
  readSyncIndex,
  removeConflict,
  saveConflict,
  writeShadow,
  writeSyncIndex,
  type ConflictEntry,
  type IndexRecord,
  type SyncIndex,
  type VersionVector,
} from './sync-store.ts';

/**
 * ISS-028: صيغة سجلات التغيير التي يكتبها هذا الإصدار ويفهمها.
 * 1 = 2.0.0–2.0.1 (مفاتيح كما هي)، 2 = منذ 2.0.2 (مفاتيح Obsidian بصيغة NFC، والوثائق المولّدة تُحسم بصمت).
 * أي دفعة بصيغة أعلى لا تُدمج، ويُطلب تحديث هذا الجهاز.
 */
export const CHANGE_FORMAT = 2;
/** أقل إصدار يفهم ما ينشره هذا الإصدار بأمان؛ يُكتب في manifest.json، والأجهزة الأقدم تتوقف (من 2.2.0 فصاعداً) */
export const MIN_SYNC_APP_VERSION = '2.2.0';
/** ISS-028: حدّ الأمان: حذف هذا العدد أو أكثر دفعة واحدة لا يُنشر ولا يُطبَّق بلا تأكيد القائد */
export const MASS_DELETE_THRESHOLD = 10;
/** مجلد فيه هذا العدد أو أكثر اختفى كله دفعة واحدة = حذف جماعي */
const FOLDER_WIPE_MIN = 3;

/**
 * Hint بالعربي: مقارنة إصدارين x.y.z: سالب إن كان الأول أقدم.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Hint بالعربي: دالة كشف الحذف الجماعي (ISS-028): عدد كبير دفعة واحدة، أو مجلد كامل (3 ملفات أو أكثر) اختفى.
 *               المدخلات: المفاتيح المحذوفة، وكل مفاتيح السجلات الحية قبل الحذف. المخرجات: سبب عربي، أو null.
 */
export function detectMassDelete(deletedKeys: string[], liveKeysBefore: string[]): string | null {
  if (!deletedKeys.length) return null;
  if (deletedKeys.length >= MASS_DELETE_THRESHOLD) return `${deletedKeys.length} عنصراً حُذفت دفعة واحدة (الحدّ ${MASS_DELETE_THRESHOLD}).`;
  const deleted = new Set(deletedKeys);
  const byFolder = new Map<string, string[]>();
  for (const key of liveKeysBefore) {
    if (recordKind(key) !== 'obs') continue;
    const dir = path.posix.dirname(key.slice('obs:'.length));
    if (dir === '.') continue;
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir)!.push(key);
  }
  for (const [dir, keys] of byFolder) {
    if (keys.length >= FOLDER_WIPE_MIN && keys.every((k) => deleted.has(k))) return `المجلد «${dir}» اختفى كاملاً (${keys.length} ملفات).`;
  }
  return null;
}

/** معرّف «الجهاز» الوهمي الذي يمسك قفل 1.9 ليبقي الأجهزة القديمة في وضع القراءة */
export const LEGACY_LOCK_DEVICE_ID = 'second-brain-2-multi-writer';
const LEGACY_LOCK_UNTIL = '2999-01-01T00:00:00.000Z';
const CHANGES_DIR = 'changes';
const SNAPSHOTS_V2_DIR = 'snapshots-v2';
const BATCH_SUFFIX = '.enc.json';
const KEEP_SNAPSHOTS_V2 = 10;
const COMPACTION_EVERY_MS = 7 * 24 * 3600 * 1000;
const CHANGE_RETENTION_MS = 90 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** تغيير واحد داخل دفعة منشورة */
export interface ChangeRecord {
  key: string;
  op: 'put' | 'delete';
  vv: VersionVector;
  hlc: string;
  hash: string | null;
  content: string | null;
  /** ISS-028: حذف جماعي أكّده القائد على الجهاز الناشر، فلا يُطلب تأكيده مرة ثانية على الأجهزة الأخرى */
  confirmed?: boolean;
}

/** ملف دفعة التغييرات على مجلد المزامنة */
interface ChangeBatchFile {
  format: 'second-brain-sync-changes';
  formatVersion: 1;
  device: DeviceInfo;
  createdAt: string;
  batch: string;
  count: number;
  /** ISS-028: صيغة السجلات (غيابها = 1، من 2.0.0–2.0.1) */
  changeFormat?: number;
  appVersion?: string;
  payload: SealedData;
}

/** ملف النسخة الكاملة بصيغة 2.0 */
interface SnapshotV2File {
  format: 'second-brain-sync-snapshot';
  formatVersion: 2;
  device: DeviceInfo;
  createdAt: string;
  hlc: string;
  /** آخر دفعة تغطيها النسخة من كل جهاز */
  covers: Record<string, string>;
  vaultKeys: Pick<VaultFileV2, 'commanderWrap' | 'emergencyWrap'>;
  recordCount: number;
  payload: SealedData;
}

interface SnapshotV2Payload {
  records: Record<string, IndexRecord & { content: string | null }>;
}

/** نتيجة دورة مزامنة */
export interface SyncCycleResult {
  migrated: boolean;
  published: number;
  applied: number;
  conflicts: number;
  skippedBatches: number;
  compacted: boolean;
  warnings: string[];
}

/** خيارات للاختبارات فقط */
export interface SyncCycleOptions {
  now?: number;
  /** تحقن فشلاً بعد كتابة الدمج (للتأكد من التراجع) */
  failMergeAfterWrite?: boolean;
  /** النشر فقط من القائد (الافتراضي)، وفي الاختبارات يمكن تعطيله */
  skipPublish?: boolean;
  /** للاختبارات: إصدار هذا الجهاز (بدل package.json) */
  appVersion?: string;
  /** للاختبارات: محاكاة جهاز قديم بلا حدّ أمان للحذف */
  unguardedPublishForTests?: boolean;
}

function changesRoot(ctx: SyncContext): string {
  return path.join(ctx.syncRoot, CHANGES_DIR);
}

function myChangesDir(ctx: SyncContext): string {
  return path.join(changesRoot(ctx), toSafeFileName(ctx.device.deviceId, 'device'));
}

function snapshotsV2Dir(ctx: SyncContext): string {
  return path.join(ctx.syncRoot, SNAPSHOTS_V2_DIR);
}

/**
 * Hint بالعربي: هل يُزامَن هذا السجل؟ ملفات Obsidian المحلية (الواجهة، والسلة، ومرآة فهرس الدوال) لا تُزامَن أبداً،
 *               حتى لو وصلت من جهاز بإصدار أقدم (ISS-026).
 */
function isSyncableKey(key: string): boolean {
  if (recordKind(key) !== 'obs') return true;
  const rel = key.slice('obs:'.length).normalize('NFC');
  return !OBSIDIAN_LOCAL_ONLY.some((re) => re.test(rel));
}

function bumpVv(vv: VersionVector | undefined, deviceId: string): VersionVector {
  const out: VersionVector = { ...(vv ?? {}) };
  out[deviceId] = (out[deviceId] ?? 0) + 1;
  return out;
}

function batchName(stamp: HlcStamp): string {
  return `${String(stamp.wallMs).padStart(15, '0')}-${String(stamp.counter).padStart(6, '0')}${BATCH_SUFFIX}`;
}

function batchTimeMs(name: string): number {
  return Number(name.slice(0, 15));
}

// ===================== الترحيل والإقلاع =====================

/**
 * Hint بالعربي: دالة قراءة سجلات «الأساس» القديم (نسخة 1.9) التي بدأ منها هذا الجهاز، لمعرفة ما تغيّر محلياً بعدها.
 */
function readLegacyBaseRecords(ctx: SyncContext, vault: UnlockedVault, version: number): RecordMap | null {
  if (version <= 0) return null;
  const dir = path.join(ctx.syncRoot, 'snapshots');
  if (!fs.existsSync(dir)) return null;
  const name = fs.readdirSync(dir).find((n) => n.startsWith(`Second-Brain-Snapshot-${String(version).padStart(6, '0')}-`));
  if (!name) return null;
  const snap = readSyncJson<{ payload: SealedData }>(path.join(dir, name));
  if (!snap) return null;
  const entries = JSON.parse(openWithKey(snap.payload, vault.dataKey).toString('utf8')) as SharedEntries;
  return recordsFromLegacyEntries(entries, vault.dataKey);
}

/**
 * Hint بالعربي: دالة إعادة قراءة الأسرار من ملف الخزنة إلى الجلسة الحية (بعد استيراد نسخة قديمة كتبت الملف).
 */
function reloadVaultSecrets(ctx: SyncContext, vault: UnlockedVault): void {
  const file = readVaultFile(ctx.vaultFile);
  const secrets = JSON.parse(openWithKey(file.data, vault.dataKey).toString('utf8')) as VaultSecretItem[];
  vault.secrets.splice(0, vault.secrets.length, ...secrets);
}

/**
 * Hint بالعربي: دالة الترحيل من 1.9 إلى 2.0 (مرة واحدة لكل جهاز):
 *   1) استيراد آخر إصدار قديم إن كان أحدث (فتصبح كل الأجهزة على الأساس نفسه).
 *   2) نسخة احتياطية محلية كاملة.
 *   3) بناء الفهرس: كل سجل يطابق الأساس متجهه فارغ (الأساس المشترك)، وكل ما يختلف عنه تغيير محلي ينتظر النشر.
 */
export function migrateFromLegacy(ctx: SyncContext, vault: UnlockedVault, now: number = Date.now()): SyncIndex {
  let legacyVersion = readLocalSyncState(ctx).baseVersion;
  const manifest = readManifest(ctx);
  if (manifest && manifest.latestVersion > legacyVersion) {
    const r = importLatestSnapshot(ctx, vault);
    if (r.imported && r.version) {
      legacyVersion = r.version;
      reloadVaultSecrets(ctx, vault);
    }
  }
  saveLocalBackup(ctx, vault, packSharedState(ctx));
  const base = readLegacyBaseRecords(ctx, vault, legacyVersion);
  const index: SyncIndex = {
    format: 'second-brain-sync-index',
    version: 1,
    deviceId: ctx.device.deviceId,
    createdAt: new Date(now).toISOString(),
    origin: { kind: base ? 'legacy-migration' : 'fresh', legacyVersion: legacyVersion || undefined },
    clock: { wallMs: 0, counter: 0 },
    records: {},
    cursors: {},
  };
  const baseStamp = hlcToString({ wallMs: 0, counter: 0, deviceId: 'base' });
  // الأساس المشترك (نسخة 1.9 نفسها على كل جهاز): متجه فارغ.
  // ما حُذف محلياً بعد الأساس يُكشف تلقائياً في أول دورة (موجود في الفهرس وغير موجود محلياً)،
  // وما أُضيف أو عُدّل يُكشف لأن بصمته تختلف.
  // بلا أساس قديم (شبكة جديدة): الفهرس فارغ، فيُنشر كل شيء كتغييرات من هذا الجهاز.
  for (const [key, content] of base ?? new Map<string, Buffer>()) {
    index.records[key] = { vv: {}, hlc: baseStamp, hash: hashContent(content) };
    writeShadow(ctx, vault.dataKey, key, content);
  }
  writeSyncIndex(ctx, index);
  lockLegacyClients(ctx, now);
  logSystemInfo('Sync', `رُحّل هذا الجهاز إلى المزامنة متعددة الكتابة (2.0) من الإصدار القديم ${legacyVersion || 'لا شيء'}، بـ ${Object.keys(index.records).length} سجلاً في الأساس.`);
  return index;
}

/**
 * Hint بالعربي: دالة قفل الأجهزة القديمة (1.9): قفل كتابة لا ينتهي باسم «Second Brain 2.0»،
 *               فيبقى أي جهاز لم يُحدَّث في وضع القراءة ولا ينشر فوق البيانات. وإشارة في manifest.json.
 */
export function lockLegacyClients(ctx: SyncContext, now: number = Date.now()): void {
  const leaseFile = path.join(ctx.syncRoot, 'write-lease.json');
  let lease: { deviceId?: string } | null = null;
  try {
    lease = readSyncJson<{ deviceId?: string }>(leaseFile);
  } catch {
    lease = null;
  }
  if (!lease || lease.deviceId !== LEGACY_LOCK_DEVICE_ID) {
    writeFileAtomic(
      leaseFile,
      JSON.stringify(
        {
          deviceId: LEGACY_LOCK_DEVICE_ID,
          deviceName: 'Second Brain 2.0 — حدّث هذا الجهاز إلى الإصدار 2.0 أو أحدث',
          acquiredAt: new Date(now).toISOString(),
          heartbeatAt: LEGACY_LOCK_UNTIL,
        },
        null,
        2
      )
    );
  }
  const manifestFile = path.join(ctx.syncRoot, 'manifest.json');
  const manifest = readJsonFileSafe<Record<string, unknown> | null>(manifestFile, null);
  // ISS-028: الحدّ الأدنى يرتفع مع كل صيغة جديدة، ولا ينخفض أبداً (جهاز أقدم لا يخفّضه)
  if (manifest) {
    const current = typeof manifest.minAppVersion === 'string' ? manifest.minAppVersion : '0.0.0';
    if (compareSemver(MIN_SYNC_APP_VERSION, current) > 0 || manifest.multiWriter !== true) {
      writeFileAtomic(manifestFile, JSON.stringify({ ...manifest, minAppVersion: compareSemver(MIN_SYNC_APP_VERSION, current) > 0 ? MIN_SYNC_APP_VERSION : current, multiWriter: true }, null, 2));
    }
  }
}

// ===================== النشر =====================

/**
 * Hint بالعربي: دالة كشف التغييرات المحلية ونشرها دفعةً واحدة. المخرجات: عدد التغييرات المنشورة.
 */
export function publishLocalChanges(ctx: SyncContext, vault: UnlockedVault, index: SyncIndex, now: number = Date.now(), options: { unguardedForTests?: boolean } = {}): number {
  // ISS-025: توحيد أسماء الملفات العربية قبل الكشف (Windows فقط)
  normalizeObsidianFileNames(ctx, vault.dataKey, ctx.device.deviceName);
  // ISS-026: السجلات التي صارت محلية فقط تُنسى من الفهرس، ولا يُنشر حذفها (فلا تُحذف من الأجهزة الأخرى)
  for (const key of Object.keys(index.records)) if (!isSyncableKey(key)) delete index.records[key];
  const local = readLocalRecords(ctx, vault);
  const changes: ChangeRecord[] = [];
  const pending = new Set(index.pendingRepublish ?? []);
  for (const [key, content] of local) {
    const rec = index.records[key];
    const hash = hashContent(content);
    if (rec && !rec.deleted && rec.hash === hash && !pending.has(key)) continue;
    const stamp = hlcToString(hlcTick(index.clock, ctx.device.deviceId, now));
    const vv = pending.has(key) ? rec!.vv : bumpVv(rec?.vv, ctx.device.deviceId);
    changes.push({ key, op: 'put', vv, hlc: stamp, hash, content: content.toString('base64') });
  }
  // ISS-028: الحذف الجماعي (مجلد كامل أو عدد كبير) لا يُنشر بلا تأكيد القائد
  const confirmed = new Set(index.confirmedDeletes ?? []);
  const missing = Object.entries(index.records).filter(([key, rec]) => !rec.deleted && !local.has(key)).map(([key]) => key);
  const unconfirmed = missing.filter((k) => !confirmed.has(k));
  const liveBefore = Object.entries(index.records).filter(([, rec]) => !rec.deleted).map(([key]) => key);
  const massReason = options.unguardedForTests ? null : detectMassDelete(unconfirmed, liveBefore);
  if (massReason) {
    index.heldDeletes = { keys: unconfirmed, detectedAt: index.heldDeletes?.detectedAt ?? new Date(now).toISOString(), reasonAr: massReason };
  } else {
    index.heldDeletes = undefined;
  }
  const deletable = massReason ? missing.filter((k) => confirmed.has(k)) : missing;
  for (const key of deletable) {
    const rec = index.records[key];
    const stamp = hlcToString(hlcTick(index.clock, ctx.device.deviceId, now));
    changes.push({ key, op: 'delete', vv: bumpVv(rec.vv, ctx.device.deviceId), hlc: stamp, hash: null, content: null, ...(confirmed.has(key) ? { confirmed: true } : {}) });
  }
  index.confirmedDeletes = [...confirmed].filter((k) => !deletable.includes(k) && missing.includes(k));
  if (!changes.length) {
    index.pendingRepublish = [];
    return 0;
  }

  const batchStamp = hlcTick(index.clock, ctx.device.deviceId, now);
  const name = batchName(batchStamp);
  const file: ChangeBatchFile = {
    format: 'second-brain-sync-changes',
    formatVersion: 1,
    device: ctx.device,
    createdAt: new Date(now).toISOString(),
    batch: name,
    count: changes.length,
    changeFormat: CHANGE_FORMAT,
    appVersion: readAppVersion(),
    payload: sealWithKey(JSON.stringify(changes), vault.dataKey),
  };
  writeFileAtomic(path.join(myChangesDir(ctx), name), JSON.stringify(file));

  // بعد نجاح كتابة الدفعة فقط: تحديث الفهرس والظل والسلة
  for (const c of changes) {
    if (c.op === 'put') {
      index.records[c.key] = { vv: c.vv, hlc: c.hlc, hash: c.hash! };
      writeShadow(ctx, vault.dataKey, c.key, Buffer.from(c.content!, 'base64'));
    } else {
      const previous = readShadow(ctx, vault.dataKey, c.key);
      if (previous) moveToTrash(ctx, vault.dataKey, c.key, previous, ctx.device.deviceName, new Date(now));
      index.records[c.key] = { vv: c.vv, hlc: c.hlc, hash: index.records[c.key]?.hash ?? '', deleted: true, deletedAt: new Date(now).toISOString() };
      writeShadow(ctx, vault.dataKey, c.key, null);
    }
  }
  index.lastBatch = name;
  index.lastPublishAt = new Date(now).toISOString();
  index.pendingRepublish = [];
  return changes.length;
}

// ===================== الدمج =====================

interface IncomingBatch {
  deviceId: string;
  deviceName: string;
  name: string;
  changes: ChangeRecord[];
}

/**
 * Hint بالعربي: دالة قراءة الدفعات الجديدة من كل جهاز آخر (بعد آخر مؤشر).
 *               ملف لم يكتمل تنزيله أو تعذّرت قراءته يوقف قراءة ذلك الجهاز فقط حتى الدورة التالية،
 *               ولا يُعدّ «غير موجود» (درس ISS-013).
 */
function readIncomingBatches(ctx: SyncContext, vault: UnlockedVault, index: SyncIndex, warnings: string[]): { batches: IncomingBatch[]; skipped: number } {
  const root = changesRoot(ctx);
  if (!fs.existsSync(root)) return { batches: [], skipped: 0 };
  const batches: IncomingBatch[] = [];
  let skipped = 0;
  const myDir = toSafeFileName(ctx.device.deviceId, 'device');
  for (const dir of fs.readdirSync(root)) {
    if (dir === myDir) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const cursor = index.cursors[dir] ?? '';
    const names = fs.readdirSync(full).filter((n) => n.endsWith(BATCH_SUFFIX) && n > cursor).sort();
    for (const name of names) {
      let file: ChangeBatchFile | null;
      try {
        file = readSyncJson<ChangeBatchFile>(path.join(full, name));
      } catch (err) {
        warnings.push(`دفعة ${name} من جهاز آخر لم تكتمل بعد (${err instanceof Error ? err.message : String(err)}). ستُقرأ في الدورة التالية.`);
        skipped += 1;
        break;
      }
      if (file && file.format === 'second-brain-sync-changes' && (file.changeFormat ?? 1) > CHANGE_FORMAT) {
        warnings.push(`⛔ «${file.device.deviceName}» (الإصدار ${file.appVersion ?? '؟'}) نشر تغييرات بصيغة أحدث (${file.changeFormat}) مما يفهمه هذا الجهاز (${CHANGE_FORMAT}). حدّث هذا الجهاز؛ لن تُدمج تغييراته حتى ذلك الحين (ISS-028).`);
        skipped += 1;
        break;
      }
      if (!file || file.format !== 'second-brain-sync-changes') {
        warnings.push(`دفعة ${name} بصيغة غير معروفة، تُركت.`);
        skipped += 1;
        break;
      }
      let changes: ChangeRecord[];
      try {
        changes = JSON.parse(openWithKey(file.payload, vault.dataKey).toString('utf8')) as ChangeRecord[];
      } catch {
        warnings.push(`دفعة ${name} من «${file.device.deviceName}» لا تُفتح بمفتاح هذه الخزنة (خزنة مختلفة أو ملف ناقص). ستُعاد المحاولة.`);
        skipped += 1;
        break;
      }
      batches.push({ deviceId: dir, deviceName: file.device.deviceName, name, changes });
    }
  }
  batches.sort((a, b) => (a.name === b.name ? a.deviceId.localeCompare(b.deviceId) : a.name.localeCompare(b.name)));
  return { batches, skipped };
}

function sideFileKey(key: string, deviceName: string, hlc: string): string {
  const rel = key.slice('obs:'.length);
  const ext = path.posix.extname(rel);
  const base = ext ? rel.slice(0, -ext.length) : rel;
  const date = new Date(hlcParse(hlc).wallMs || Date.now()).toISOString().slice(0, 16).replace(':', '-');
  return `obs:${base} (تعارض - ${toSafeFileName(deviceName, 'device')} - ${date})${ext}`;
}

/**
 * Hint بالعربي: دالة دمج الدفعات القادمة في هذا الجهاز. كل القرارات تُحسب أولاً، ثم تُكتب كلها كمعاملة واحدة
 *               بعد نسخة احتياطية محلية. إن فشلت الكتابة لا يتغيّر الفهرس ولا المؤشرات (تُعاد المحاولة لاحقاً).
 */
export function mergeIncoming(
  ctx: SyncContext,
  vault: UnlockedVault,
  index: SyncIndex,
  options: SyncCycleOptions & { warnings: string[] }
): { applied: number; conflicts: number; skipped: number } {
  const now = options.now ?? Date.now();
  const { batches, skipped } = readIncomingBatches(ctx, vault, index, options.warnings);
  if (!batches.length) return { applied: 0, conflicts: 0, skipped };

  const local = readLocalRecords(ctx, vault);
  const records: Record<string, IndexRecord> = JSON.parse(JSON.stringify(index.records));
  const writes = new Map<string, Buffer | null>();
  const current = (key: string): Buffer | null => (writes.has(key) ? writes.get(key)! : local.get(key) ?? null);
  const newConflicts: ConflictEntry[] = [];
  const trash: Array<{ key: string; content: Buffer; by: string }> = [];
  const resolvedElsewhere = new Set<string>();
  const republish = new Set(index.pendingRepublish ?? []);
  const clock = { ...index.clock };
  let conflictSeq = 0;

  const conflict = (c: Omit<ConflictEntry, 'id' | 'createdAt'>): void => {
    conflictSeq += 1;
    newConflicts.push({ ...c, id: `${now}-${conflictSeq}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date(now).toISOString() });
  };

  // ISS-028: حذف جماعي قادم (عدد كبير، أو مجلد كامل) لا يُطبَّق بلا تأكيد القائد
  const heldNow = new Set<string>();
  const heldList = readHeldIncoming(ctx, vault.dataKey);
  for (const batch of batches) {
    const deletes = batch.changes.filter((c) => c.op === 'delete' && !c.confirmed && isSyncableKey(c.key) && local.has(c.key) && records[c.key] && compareVv(c.vv, records[c.key].vv) === 'greater');
    const liveBefore = Object.entries(records).filter(([, r]) => !r.deleted).map(([k]) => k);
    const reason = detectMassDelete(deletes.map((c) => c.key), liveBefore);
    if (!reason) continue;
    for (const c of deletes) heldNow.add(`${batch.name}|${c.key}`);
    heldList.push({ deviceName: batch.deviceName, detectedAt: new Date(now).toISOString(), reasonAr: reason, changes: deletes.map((c) => ({ key: c.key, vv: c.vv, hlc: c.hlc })) });
    options.warnings.push(`🛑 «${batch.deviceName}» نشر حذفاً جماعياً: ${reason} لم يُطبَّق هنا، وينتظر تأكيدك في قسم المزامنة (ISS-028).`);
  }

  for (const batch of batches) {
    for (const c of batch.changes) {
      if (!isSyncableKey(c.key)) continue;
      if (heldNow.has(`${batch.name}|${c.key}`)) continue;
      try {
        hlcReceive(clock, hlcParse(c.hlc), now);
      } catch {
        continue;
      }
      const rec = records[c.key];
      const incoming = c.content !== null ? Buffer.from(c.content, 'base64') : null;
      if (!rec) {
        records[c.key] = { vv: c.vv, hlc: c.hlc, hash: c.hash ?? '', ...(c.op === 'delete' ? { deleted: true, deletedAt: new Date(now).toISOString() } : {}) };
        if (c.op === 'put') writes.set(c.key, incoming);
        continue;
      }
      const order = compareVv(c.vv, rec.vv);
      if (order === 'less' || order === 'equal') continue;
      if (order === 'greater') {
        if (c.op === 'delete') {
          const existing = current(c.key);
          if (existing) trash.push({ key: c.key, content: existing, by: batch.deviceName });
          writes.set(c.key, null);
          records[c.key] = { vv: c.vv, hlc: c.hlc, hash: rec.hash, deleted: true, deletedAt: new Date(now).toISOString() };
        } else {
          writes.set(c.key, incoming);
          records[c.key] = { vv: c.vv, hlc: c.hlc, hash: c.hash! };
          if (recordKind(c.key) === 'vaultkeys') {
            options.warnings.push(`🔑 تغيّرت كلمة المرور الرئيسية (أو مفتاح الطوارئ) على «${batch.deviceName}». عند قفل الخزنة هنا استخدم كلمة المرور الجديدة.`);
          }
        }
        resolvedElsewhere.add(c.key);
        republish.delete(c.key);
        continue;
      }

      // ===== تعديلان متزامنان: لم يرَ أيٌّ منهما الآخر =====
      const merged = mergeVv(rec.vv, c.vv);
      const incomingNewer = hlcCompare(c.hlc, rec.hlc) > 0;
      const winnerHlc = incomingNewer ? c.hlc : rec.hlc;
      const localContent = current(c.key);
      if ((rec.deleted && c.op === 'delete') || (!rec.deleted && c.op === 'put' && rec.hash === c.hash)) {
        records[c.key] = { ...rec, vv: merged, hlc: winnerHlc };
        continue;
      }
      if (rec.deleted && c.op === 'put') {
        // حُذف هنا وعُدّل هناك ← يبقى التعديل
        writes.set(c.key, incoming);
        records[c.key] = { vv: merged, hlc: c.hlc, hash: c.hash! };
        conflict({ key: c.key, kind: 'delete-vs-edit', otherDevice: batch.deviceName, keptSide: 'incoming', keptHash: c.hash, otherContent: null, otherHash: null });
        continue;
      }
      if (!rec.deleted && c.op === 'delete') {
        // عُدّل هنا وحُذف هناك ← يبقى التعديل، ويُعاد نشره بمتجه أعلى حتى يستعيده الجهاز الآخر
        const vv = bumpVv(merged, ctx.device.deviceId);
        records[c.key] = { vv, hlc: hlcToString(hlcTick(clock, ctx.device.deviceId, now)), hash: rec.hash };
        republish.add(c.key);
        conflict({ key: c.key, kind: 'delete-vs-edit', otherDevice: batch.deviceName, keptSide: 'local', keptHash: rec.hash, otherContent: null, otherHash: null });
        continue;
      }
      // تعديلان مختلفان للسجل نفسه
      const kind = recordKind(c.key);
      if (isGeneratedProjectDoc(c.key)) {
        // ISS-026: وثيقة مولّدة آلياً: الأحدث يُعتمد بصمت، والأخرى إلى السلة (لا بطاقة تعارض ولا نسخة جانبية)
        if (incomingNewer) {
          if (localContent) trash.push({ key: c.key, content: localContent, by: `${ctx.device.deviceName} (وثيقة مولّدة أقدم)` });
          writes.set(c.key, incoming);
          records[c.key] = { vv: merged, hlc: c.hlc, hash: c.hash! };
        } else {
          if (incoming) trash.push({ key: c.key, content: incoming, by: `${batch.deviceName} (وثيقة مولّدة أقدم)` });
          records[c.key] = { ...rec, vv: merged };
        }
        continue;
      }
      if (kind === 'vaultkeys') {
        // مغلّفا المفتاح (تغيير كلمة المرور): الأحدث يفوز، مع تنبيه
        if (incomingNewer) {
          writes.set(c.key, incoming);
          records[c.key] = { vv: merged, hlc: c.hlc, hash: c.hash! };
          options.warnings.push(`🔑 تغيّرت كلمة المرور الرئيسية (أو مفتاح الطوارئ) على «${batch.deviceName}». عند قفل الخزنة هنا استخدم كلمة المرور الجديدة.`);
        } else {
          records[c.key] = { ...rec, vv: merged };
        }
        continue;
      }
      if (kind === 'secret') {
        // الأسرار: لا فائز تلقائياً. تبقى القيمة المحلية، والأخرى تنتظر قرار القائد
        records[c.key] = { ...rec, vv: merged };
        conflict({ key: c.key, kind: 'secret', otherDevice: batch.deviceName, keptSide: 'local', keptHash: rec.hash, otherContent: c.content, otherHash: c.hash });
        continue;
      }
      if (incomingNewer) {
        writes.set(c.key, incoming);
        records[c.key] = { vv: merged, hlc: c.hlc, hash: c.hash! };
        const loser = localContent;
        let sideFile: string | undefined;
        if (kind === 'obs' && loser) {
          sideFile = sideFileKey(c.key, ctx.device.deviceName, rec.hlc);
          writes.set(sideFile, loser);
        }
        conflict({ key: c.key, kind: 'edit', otherDevice: batch.deviceName, keptSide: 'incoming', keptHash: c.hash, otherContent: loser ? loser.toString('base64') : null, otherHash: rec.hash, sideFile });
      } else {
        records[c.key] = { ...rec, vv: merged };
        let sideFile: string | undefined;
        if (kind === 'obs' && incoming) {
          sideFile = sideFileKey(c.key, batch.deviceName, c.hlc);
          writes.set(sideFile, incoming);
        }
        conflict({ key: c.key, kind: 'edit', otherDevice: batch.deviceName, keptSide: 'local', keptHash: rec.hash, otherContent: c.content, otherHash: c.hash, sideFile });
      }
    }
  }

  // ===== الكتابة كمعاملة واحدة =====
  const writeList: RecordWrite[] = [...writes].map(([key, content]) => ({ key, content }));
  if (writeList.length) {
    saveLocalBackup(ctx, vault, packSharedState(ctx));
    applyRecordWrites(ctx, vault, writeList, { failAfterWrite: options.failMergeAfterWrite });
  }

  // نجحت الكتابة ← تحديث الظل والسلة والتعارضات والفهرس والمؤشرات
  for (const t of trash) moveToTrash(ctx, vault.dataKey, t.key, t.content, t.by, new Date(now));
  for (const [key, content] of writes) {
    // النسخ الجانبية لملفات Obsidian تغييرات محلية جديدة: تُكشف وتُنشر في الدورة التالية
    if (records[key]) writeShadow(ctx, vault.dataKey, key, content);
  }
  if (resolvedElsewhere.size) {
    for (const open of listConflicts(ctx, vault.dataKey)) {
      if (resolvedElsewhere.has(open.key)) removeConflict(ctx, open.id);
    }
  }
  for (const c of newConflicts) saveConflict(ctx, vault.dataKey, c);
  if (heldNow.size) writeHeldIncoming(ctx, vault.dataKey, heldList);
  index.records = records;
  index.clock = clock;
  for (const b of batches) index.cursors[b.deviceId] = b.name > (index.cursors[b.deviceId] ?? '') ? b.name : index.cursors[b.deviceId];
  index.pendingRepublish = [...republish];
  index.lastMergeAt = new Date(now).toISOString();
  return { applied: writeList.length, conflicts: newConflicts.length, skipped };
}

// ===================== الضغط والإقلاع =====================

function listSnapshotsV2(ctx: SyncContext): string[] {
  const dir = snapshotsV2Dir(ctx);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(BATCH_SUFFIX)).sort();
}

/**
 * Hint بالعربي: دالة إنشاء نسخة كاملة مشفّرة (صيغة 2.0) تغطي كل الدفعات حتى الآن، لإقلاع أي جهاز جديد منها.
 *               تُستدعى بعد النشر والدمج، فيكون المحتوى المحلي مطابقاً للفهرس.
 */
export function createSnapshotV2(ctx: SyncContext, vault: UnlockedVault, index: SyncIndex, now: number = Date.now()): string {
  const local = readLocalRecords(ctx, vault);
  const payload: SnapshotV2Payload = { records: {} };
  for (const [key, rec] of Object.entries(index.records)) {
    const content = rec.deleted ? null : local.get(key) ?? null;
    payload.records[key] = { ...rec, content: content ? content.toString('base64') : null };
  }
  const stamp = hlcTick(index.clock, ctx.device.deviceId, now);
  const hlc = hlcToString(stamp);
  const covers = { ...index.cursors };
  if (index.lastBatch) covers[toSafeFileName(ctx.device.deviceId, 'device')] = index.lastBatch;
  const vaultFile = readVaultFile(ctx.vaultFile);
  const file: SnapshotV2File = {
    format: 'second-brain-sync-snapshot',
    formatVersion: 2,
    device: ctx.device,
    createdAt: new Date(now).toISOString(),
    hlc,
    covers,
    vaultKeys: { commanderWrap: vaultFile.commanderWrap, emergencyWrap: vaultFile.emergencyWrap },
    recordCount: Object.keys(payload.records).length,
    payload: sealWithKey(JSON.stringify(payload), vault.dataKey),
  };
  const name = `${hlc}${BATCH_SUFFIX}`;
  writeFileAtomic(path.join(snapshotsV2Dir(ctx), name), JSON.stringify(file));
  index.lastCompactionAt = new Date(now).toISOString();
  return name;
}

/**
 * Hint بالعربي: دالة التنظيف بعد الضغط: كل جهاز يحذف نسخه هو فقط (خارج آخر 10 نسخ)،
 *               ودفعاته هو فقط إن مضى عليها 90 يوماً وكانت مغطّاة بأحدث نسخة. لا حذف عبر الأجهزة أبداً.
 */
export function pruneOwnSyncFiles(ctx: SyncContext, now: number = Date.now()): { snapshots: number; batches: number } {
  const all = listSnapshotsV2(ctx);
  const deviceSuffix = `-${ctx.device.deviceId}${BATCH_SUFFIX}`;
  let snapshots = 0;
  for (const name of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS_V2))) {
    if (name.endsWith(deviceSuffix)) {
      removePathSync(path.join(snapshotsV2Dir(ctx), name), { force: true });
      snapshots += 1;
    }
  }
  let batches = 0;
  const newest = all[all.length - 1];
  if (newest) {
    const snap = readSyncJson<SnapshotV2File>(path.join(snapshotsV2Dir(ctx), newest));
    const covered = snap?.covers[toSafeFileName(ctx.device.deviceId, 'device')] ?? '';
    const dir = myChangesDir(ctx);
    if (covered && fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(BATCH_SUFFIX) && name <= covered && now - batchTimeMs(name) > CHANGE_RETENTION_MS) {
          removePathSync(path.join(dir, name), { force: true });
          batches += 1;
        }
      }
    }
  }
  return { snapshots, batches };
}

/**
 * Hint بالعربي: دالة إقلاع جهاز جديد من أحدث نسخة 2.0 بكلمة المرور الرئيسية (المكتبي، Android لاحقاً):
 *               تكتب ملف الخزنة وكل السجلات، وتبني الفهرس من النسخة، ثم تُكمل الدورات العادية الدفعات اللاحقة.
 *               ترفض إن كانت على الجهاز خزنة موجودة (حتى لا تُمسح بيانات).
 */
export function bootstrapFromSnapshotV2(ctx: SyncContext, masterPassword: string, now: number = Date.now()): { vault: UnlockedVault; records: number; snapshot: string } {
  if (fs.existsSync(ctx.vaultFile)) throw new Error('على هذا الجهاز خزنة موجودة. الإقلاع من النسخة لجهاز جديد فقط.');
  const all = listSnapshotsV2(ctx);
  const newest = all[all.length - 1];
  if (!newest) throw new Error('لا توجد نسخة كاملة (2.0) على مجلد المزامنة بعد. افتح الخزنة على جهاز مُرحَّل أولاً.');
  const snap = readSyncJson<SnapshotV2File>(path.join(snapshotsV2Dir(ctx), newest));
  if (!snap || snap.formatVersion !== 2) throw new Error('النسخة الكاملة غير مكتملة بعد على هذا الجهاز. أعد المحاولة بعد قليل.');
  let dataKey: Buffer;
  try {
    dataKey = unwrapDataKey(snap.vaultKeys.commanderWrap, masterPassword);
  } catch {
    throw new Error('كلمة المرور الرئيسية غير صحيحة لهذه النسخة.');
  }
  const payload = JSON.parse(openWithKey(snap.payload, dataKey).toString('utf8')) as SnapshotV2Payload;
  const nowIso = formatTimestampIso();
  const emptyVault: VaultFileV2 = {
    format: 'second-brain-vault',
    version: 2,
    commanderWrap: snap.vaultKeys.commanderWrap,
    emergencyWrap: snap.vaultKeys.emergencyWrap,
    data: sealWithKey(JSON.stringify([]), dataKey),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  writeFileAtomic(ctx.vaultFile, JSON.stringify(emptyVault, null, 2));
  const vault: UnlockedVault = { vaultFilePath: ctx.vaultFile, dataKey, unlockedBy: 'commander', secrets: [] };
  const writes: RecordWrite[] = [];
  const index: SyncIndex = {
    format: 'second-brain-sync-index',
    version: 1,
    deviceId: ctx.device.deviceId,
    createdAt: new Date(now).toISOString(),
    origin: { kind: 'bootstrap', snapshot: newest },
    clock: { wallMs: 0, counter: 0 },
    records: {},
    cursors: {},
  };
  for (const [key, rec] of Object.entries(payload.records)) {
    const { content, ...meta } = rec;
    index.records[key] = meta;
    if (!rec.deleted && content !== null) {
      const buf = Buffer.from(content, 'base64');
      writes.push({ key, content: buf });
      writeShadow(ctx, dataKey, key, buf);
    }
    try {
      hlcReceive(index.clock, hlcParse(rec.hlc), now);
    } catch {
      // ختم الأساس
    }
  }
  const myDir = toSafeFileName(ctx.device.deviceId, 'device');
  for (const [dev, cursor] of Object.entries(snap.covers)) if (dev !== myDir) index.cursors[dev] = cursor;
  applyRecordWrites(ctx, vault, writes);
  writeSyncIndex(ctx, index);
  logSystemInfo('Sync', `أُقلع هذا الجهاز من النسخة الكاملة ${newest} (${writes.length} سجلاً).`);
  return { vault, records: writes.length, snapshot: newest };
}

// ===================== الدورة الكاملة =====================

let cycleRunning = false;

/**
 * Hint بالعربي: دالة دورة مزامنة كاملة على هذا الجهاز (تحتاج الخزنة مفتوحة):
 *               الترحيل إن لزم ← نشر التغييرات المحلية ← دمج القادم ← الضغط الأسبوعي ← تفريغ السلة ← قفل الأجهزة القديمة.
 *               النشر من القائد فقط، والدمج متاح لوضع العائلة أيضاً (لترى آخر البيانات).
 */
export function runSyncCycle(ctx: SyncContext, vault: UnlockedVault, options: SyncCycleOptions = {}): SyncCycleResult {
  if (cycleRunning) return { migrated: false, published: 0, applied: 0, conflicts: 0, skippedBatches: 0, compacted: false, warnings: ['دورة مزامنة أخرى تعمل الآن.'] };
  cycleRunning = true;
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  try {
    let index = readSyncIndex(ctx);
    let migrated = false;
    if (!index) {
      if (vault.unlockedBy !== 'commander') {
        return { migrated: false, published: 0, applied: 0, conflicts: 0, skippedBatches: 0, compacted: false, warnings: ['الترحيل إلى 2.0 يحتاج فتح الخزنة بكلمة المرور الرئيسية.'] };
      }
      index = migrateFromLegacy(ctx, vault, now);
      migrated = true;
    }
    // ISS-028: جهاز أقدم من الحدّ الأدنى المكتوب في manifest.json لا ينشر ولا يدمج
    let minRequired: string | undefined;
    try {
      minRequired = (readSyncJson<{ minAppVersion?: string }>(path.join(ctx.syncRoot, 'manifest.json')) ?? {}).minAppVersion;
    } catch {
      minRequired = undefined;
    }
    const running = options.appVersion ?? readAppVersion();
    if (minRequired && compareSemver(running, minRequired) < 0) {
      return { migrated, published: 0, applied: 0, conflicts: 0, skippedBatches: 0, compacted: false, warnings: [`⛔ هذا الجهاز (${running}) أقدم من الحدّ الأدنى للمزامنة (${minRequired}) الذي كتبه جهاز أحدث. حدّثه (git pull ثم أعد تشغيل الخادم)؛ المزامنة متوقفة هنا حتى ذلك (ISS-028).`] };
    }
    const canPublish = vault.unlockedBy === 'commander' && !options.skipPublish;
    let published = 0;
    try {
      if (canPublish) {
        published = publishLocalChanges(ctx, vault, index, now, { unguardedForTests: options.unguardedPublishForTests });
        // الدفعة كُتبت على Drive ← يُحفظ الفهرس فوراً، فلا يُعاد نشرها إن فشل الدمج بعدها
        if (published) writeSyncIndex(ctx, index);
      }
      const merge = mergeIncoming(ctx, vault, index, { ...options, now, warnings });
      // النسخ الجانبية والسجلات المعاد نشرها بعد الدمج تُنشر في الدورة نفسها
      if (canPublish && (merge.applied || (index.pendingRepublish ?? []).length)) published += publishLocalChanges(ctx, vault, index, now, { unguardedForTests: options.unguardedPublishForTests });
      let compacted = false;
      if (canPublish) {
        const snaps = listSnapshotsV2(ctx);
        const newest = snaps[snaps.length - 1];
        const newestMs = newest ? Number(newest.slice(0, 15)) : 0;
        if (!newest || now - newestMs > COMPACTION_EVERY_MS) {
          createSnapshotV2(ctx, vault, index, now);
          pruneOwnSyncFiles(ctx, now);
          compacted = true;
        }
      }
      if (!index.lastTrashPurgeAt || now - Date.parse(index.lastTrashPurgeAt) > DAY_MS) {
        purgeTrash(ctx, now);
        index.lastTrashPurgeAt = new Date(now).toISOString();
      }
      if (canPublish) lockLegacyClients(ctx, now);
      const legacy = readManifest(ctx);
      if (legacy && index.origin.legacyVersion && legacy.latestVersion > index.origin.legacyVersion && legacy.device.deviceId !== LEGACY_LOCK_DEVICE_ID) {
        warnings.push(`⚠️ جهاز بإصدار قديم («${legacy.device.deviceName}») نشر نسخة بالنظام القديم (${legacy.latestVersion}). حدّثه إلى 2.0؛ تغييراته في تلك النسخة لم تُدمج.`);
      }
      index.lastError = undefined;
      index.lastWarning = warnings.length ? warnings.join(' ') : undefined;
      writeSyncIndex(ctx, index);
      return { migrated, published, applied: merge.applied, conflicts: merge.conflicts, skippedBatches: merge.skipped, compacted, warnings };
    } catch (err) {
      // الفهرس على القرص يبقى كما كان قبل الدورة (لم يُكتب)، فتُعاد المحاولة كاملة لاحقاً
      const fresh = readSyncIndex(ctx);
      if (fresh) {
        fresh.lastError = err instanceof Error ? err.message : String(err);
        writeSyncIndex(ctx, fresh);
      }
      throw err;
    }
  } finally {
    cycleRunning = false;
  }
}

/**
 * Hint بالعربي: دالة حل تعارض: keep = اعتماد النسخة الحالية، other = اعتماد النسخة الأخرى.
 *               في الحالتين تُنقل النسخة التي لم تُعتمد إلى السلة (30 يوماً) فلا يضيع شيء،
 *               ويُنشر القرار في الدورة التالية بمتجه أعلى من الطرفين.
 */
export function resolveConflict(ctx: SyncContext, vault: UnlockedVault, id: string, choice: 'keep' | 'other'): void {
  const entry = listConflicts(ctx, vault.dataKey).find((c) => c.id === id);
  if (!entry) throw new Error('التعارض غير موجود (ربما حُلّ على جهاز آخر).');
  const local = readLocalRecords(ctx, vault);
  const writes: RecordWrite[] = [];
  if (choice === 'other') {
    const currentContent = local.get(entry.key);
    if (currentContent) moveToTrash(ctx, vault.dataKey, entry.key, currentContent, `تعارض: ${ctx.device.deviceName}`);
    writes.push({ key: entry.key, content: entry.otherContent ? Buffer.from(entry.otherContent, 'base64') : null });
  } else if (entry.otherContent) {
    moveToTrash(ctx, vault.dataKey, entry.key, Buffer.from(entry.otherContent, 'base64'), `تعارض: ${entry.otherDevice}`);
  }
  if (entry.sideFile && local.has(entry.sideFile)) {
    // النسخة الجانبية منشورة كملف عادي: حذفها يُكشف وينقلها إلى السلة في الدورة التالية (مرة واحدة فقط)
    writes.push({ key: entry.sideFile, content: null });
  }
  applyRecordWrites(ctx, vault, writes);
  // حتى إن لم يتغيّر المحتوى (keep)، يُعاد نشر السجل بمتجه أعلى فيحسم التعارض على الأجهزة الأخرى أيضاً
  const index = readSyncIndex(ctx);
  if (index && index.records[entry.key] && choice === 'keep' && !index.records[entry.key].deleted) {
    index.records[entry.key].vv = bumpVv(index.records[entry.key].vv, ctx.device.deviceId);
    index.pendingRepublish = [...new Set([...(index.pendingRepublish ?? []), entry.key])];
    writeSyncIndex(ctx, index);
  }
  removeConflict(ctx, id);
}

/**
 * Hint بالعربي: دالة استرجاع عنصر من السلة: يُكتب محتواه من جديد، ويُنشر في الدورة التالية فيعود على كل الأجهزة.
 */
export function restoreFromTrash(ctx: SyncContext, vault: UnlockedVault, entry: { key: string; content: string }): void {
  applyRecordWrites(ctx, vault, [{ key: entry.key, content: Buffer.from(entry.content, 'base64') }]);
}

/**
 * Hint بالعربي: دالة حسم الحذف الجماعي المعلّق (ISS-028).
 *   - outgoing/confirm: القائد حذفها فعلاً ← تُنشر في الدورة القادمة.
 *   - outgoing/reject: لم يحذفها ← تُعاد من «الظل» إلى هذا الجهاز.
 *   - incoming/confirm: يُطبَّق حذف الجهاز الآخر هنا (والمحتوى إلى السلة).
 *   - incoming/reject: تبقى هنا، وتُعاد نشرها بمتجه أعلى فتعود إلى الجهاز الآخر أيضاً.
 */
export function resolveHeldDeletes(ctx: SyncContext, vault: UnlockedVault, direction: 'outgoing' | 'incoming', action: 'confirm' | 'reject', now: number = Date.now()): number {
  const index = readSyncIndex(ctx);
  if (!index) throw new Error('المزامنة لم تُرحَّل بعد على هذا الجهاز.');
  if (direction === 'outgoing') {
    const held = index.heldDeletes;
    if (!held) return 0;
    if (action === 'confirm') {
      index.confirmedDeletes = [...new Set([...(index.confirmedDeletes ?? []), ...held.keys])];
    } else {
      const writes: RecordWrite[] = [];
      for (const key of held.keys) {
        const content = readShadow(ctx, vault.dataKey, key);
        if (content) writes.push({ key, content });
      }
      applyRecordWrites(ctx, vault, writes);
    }
    index.heldDeletes = undefined;
    writeSyncIndex(ctx, index);
    return held.keys.length;
  }
  const heldList = readHeldIncoming(ctx, vault.dataKey);
  if (!heldList.length) return 0;
  const local = readLocalRecords(ctx, vault);
  let count = 0;
  const writes: RecordWrite[] = [];
  for (const h of heldList) {
    for (const c of h.changes) {
      const rec = index.records[c.key];
      if (!rec) continue;
      count += 1;
      if (action === 'confirm') {
        if (compareVv(c.vv, rec.vv) !== 'greater') continue; // تغيّر محلياً بعدها: يبقى
        const content = local.get(c.key);
        if (content) moveToTrash(ctx, vault.dataKey, c.key, content, h.deviceName, new Date(now));
        writes.push({ key: c.key, content: null });
        index.records[c.key] = { vv: c.vv, hlc: c.hlc, hash: rec.hash, deleted: true, deletedAt: new Date(now).toISOString() };
        writeShadow(ctx, vault.dataKey, c.key, null);
      } else {
        index.records[c.key] = { ...rec, vv: bumpVv(mergeVv(rec.vv, c.vv), ctx.device.deviceId), hlc: hlcToString(hlcTick(index.clock, ctx.device.deviceId, now)) };
        index.pendingRepublish = [...new Set([...(index.pendingRepublish ?? []), c.key])];
      }
    }
  }
  if (writes.length) applyRecordWrites(ctx, vault, writes);
  writeHeldIncoming(ctx, vault.dataKey, []);
  writeSyncIndex(ctx, index);
  return count;
}

