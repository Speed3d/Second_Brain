/**
 * ============================================================================
 * الملف: src/features/sync/snapshot-sync.ts
 * القسم: Features -> Sync (نشر واستيراد النسخ المشفرة بين الأجهزة)
 * Hint بالعربي: يجمع البيانات المشتركة (الخزنة، الهوية، المشاريع، الذاكرة، المحادثات، Obsidian) في نسخة
 *               مشفرة بمفتاح بيانات الخزنة، فلا يرى Google أي محتوى. كل نسخة لها رقم إصدار متزايد،
 *               و manifest.json يشير إلى الأحدث. الاستيراد يحفظ نسخة احتياطية محلية قبل تطبيق أي شيء،
 *               والنشر يرفض الكتابة فوق إصدار أحدث من الذي بدأ منه الجهاز (حماية من التعارض).
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { listFilesRecursive, readJsonFileSafe, removePathSync, toSafeFileName, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { SealedData } from '../../shared/types.ts';
import { readVaultFile, type UnlockedVault, type VaultKeyEnvelopes } from '../vault/vault-manager.ts';
import { readLocalSyncState, readLeaseStatus, readSyncJson, writeLocalSyncState, type DeviceInfo, type SyncContext } from './sync-context.ts';

const SNAPSHOT_PREFIX = 'Second-Brain-Snapshot-';
const SNAPSHOT_SUFFIX = '.enc.json';
const KEEP_SNAPSHOTS = 10;
const KEEP_LOCAL_BACKUPS = 5;
/** ملفات Obsidian الخاصة بواجهة كل جهاز (لا تُزامَن) */
const OBSIDIAN_LOCAL_ONLY = [/^\.obsidian\/workspace[^/]*\.json$/, /^\.trash\//];

/**
 * Hint بالعربي: محتوى manifest.json (يشير إلى أحدث نسخة).
 */
export interface SyncManifest {
  format: 'second-brain-sync-manifest';
  latestVersion: number;
  file: string;
  contentHash: string;
  device: DeviceInfo;
  publishedAt: string;
}

/**
 * Hint بالعربي: ملف النسخة المشفرة على مجلد المزامنة.
 */
interface SnapshotFile {
  format: 'second-brain-sync-snapshot';
  formatVersion: 1;
  snapshotVersion: number;
  baseVersion: number;
  createdAt: string;
  device: DeviceInfo;
  contentHash: string;
  vaultKeys: VaultKeyEnvelopes;
  payload: SealedData;
}

/** المحتوى المشترك: مفتاح ثابت ← محتوى بترميز Base64 */
export type SharedEntries = Record<string, string>;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Hint بالعربي: دالة جمع البيانات المشتركة لهذا الجهاز بمفاتيح ثابتة لا تعتمد على المسارات:
 *               vault، branding، projects، memory، conversations/<ملف>، obsidian/<مسار نسبي>.
 */
export function packSharedState(ctx: SyncContext): SharedEntries {
  const entries: SharedEntries = {};
  const add = (key: string, file: string): void => {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) entries[key] = fs.readFileSync(file).toString('base64');
  };
  add('vault', ctx.vaultFile);
  add('branding', ctx.brandingPath);
  add('memory', path.join(ctx.dataDir, 'ai-memory-store.json'));
  const settings = readJsonFileSafe<Record<string, unknown>>(ctx.settingsPath, {});
  const projects = Array.isArray(settings.watchedProjects) ? settings.watchedProjects : [];
  entries.projects = Buffer.from(JSON.stringify(projects), 'utf8').toString('base64');
  const convDir = path.join(ctx.dataDir, 'conversations');
  if (fs.existsSync(convDir)) {
    for (const name of fs.readdirSync(convDir)) {
      if (/^[a-z0-9-]{8,64}\.enc\.json$/.test(name)) add(`conversations/${name}`, path.join(convDir, name));
    }
  }
  for (const file of listFilesRecursive(ctx.obsidianDir)) {
    const rel = toPosix(path.relative(ctx.obsidianDir, file));
    if (OBSIDIAN_LOCAL_ONLY.some((re) => re.test(rel))) continue;
    add(`obsidian/${rel}`, file);
  }
  return entries;
}

/**
 * Hint بالعربي: دالة بصمة المحتوى (SHA-256 على المفاتيح مرتبة) لمعرفة وجود تغييرات.
 */
export function hashSharedState(entries: SharedEntries): string {
  const h = crypto.createHash('sha256');
  for (const key of Object.keys(entries).sort()) {
    h.update(key);
    h.update('\u0000');
    h.update(entries[key]);
    h.update('\u0001');
  }
  return h.digest('hex');
}

function manifestPath(ctx: SyncContext): string {
  return path.join(ctx.syncRoot, 'manifest.json');
}

/**
 * Hint بالعربي: دالة قراءة manifest.json: null فقط إن لم يُنشر شيء بعد (الملف غير موجود).
 *               إن تعذّرت قراءته أو كانت صيغته غير معروفة ← خطأ، لا null (حتى لا يُظن أنه أول جهاز).
 */
export function readManifest(ctx: SyncContext): SyncManifest | null {
  const m = readSyncJson<SyncManifest>(manifestPath(ctx));
  if (!m) return null;
  if (m.format !== 'second-brain-sync-manifest' || !Number.isInteger(m.latestVersion)) {
    throw new Error('manifest.json على مجلد المزامنة بصيغة غير معروفة. لم يُغيَّر أي شيء.');
  }
  return m;
}

/**
 * Hint بالعربي: هل يوجد أي نسخة منشورة في snapshots/؟ (حماية إضافية قبل اعتبار الجهاز «أول جهاز»)
 */
export function hasAnySnapshots(ctx: SyncContext): boolean {
  const dir = path.join(ctx.syncRoot, 'snapshots');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith(SNAPSHOT_SUFFIX));
}

function sealEntries(entries: SharedEntries, vault: UnlockedVault): SealedData {
  return sealWithKey(JSON.stringify(entries), vault.dataKey);
}

/**
 * Hint بالعربي: دالة حفظ نسخة احتياطية مشفرة من الحالة المحلية قبل الاستيراد (data/sync-backups/)،
 *               مع الإبقاء على آخر 5 فقط.
 */
export function saveLocalBackup(ctx: SyncContext, vault: UnlockedVault, entries: SharedEntries): string {
  const dir = path.join(ctx.dataDir, 'sync-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `pre-import-${stamp}.enc.json`);
  writeFileAtomic(file, JSON.stringify({ format: 'second-brain-sync-local-backup', createdAt: new Date().toISOString(), payload: sealEntries(entries, vault) }));
  const all = fs.readdirSync(dir).filter((n) => n.startsWith('pre-import-')).sort().reverse();
  for (const old of all.slice(KEEP_LOCAL_BACKUPS)) removePathSync(path.join(dir, old), { force: true });
  return file;
}

/**
 * Hint بالعربي: دالة تطبيق محتوى مشترك على هذا الجهاز. Obsidian والمحادثات تُطابَق تماماً
 *               (يُحذف ما حُذف على الجهاز الناشر)، والإعدادات لا يتغير منها إلا قائمة المشاريع.
 */
function applySharedState(ctx: SyncContext, entries: SharedEntries): void {
  const buf = (key: string): Buffer | null => (entries[key] !== undefined ? Buffer.from(entries[key], 'base64') : null);
  const vault = buf('vault');
  if (vault) writeFileAtomic(ctx.vaultFile, vault);
  const branding = buf('branding');
  if (branding) writeFileAtomic(ctx.brandingPath, branding);
  const memory = buf('memory');
  if (memory) writeFileAtomic(path.join(ctx.dataDir, 'ai-memory-store.json'), memory);

  const projects = buf('projects');
  if (projects) {
    const settings = readJsonFileSafe<Record<string, unknown>>(ctx.settingsPath, {});
    settings.watchedProjects = JSON.parse(projects.toString('utf8'));
    writeFileAtomic(ctx.settingsPath, JSON.stringify(settings, null, 2));
  }

  // المحادثات: مطابقة تامة
  const convDir = path.join(ctx.dataDir, 'conversations');
  const incomingConv = new Set(Object.keys(entries).filter((k) => k.startsWith('conversations/')).map((k) => k.slice('conversations/'.length)));
  if (fs.existsSync(convDir)) {
    for (const name of fs.readdirSync(convDir)) {
      if (/\.enc\.json$/.test(name) && !incomingConv.has(name)) removePathSync(path.join(convDir, name), { force: true });
    }
  }
  for (const name of incomingConv) {
    if (!/^[a-z0-9-]{8,64}\.enc\.json$/.test(name)) continue;
    writeFileAtomic(path.join(convDir, name), buf(`conversations/${name}`)!);
  }

  // Obsidian: مطابقة تامة (ما عدا ملفات الواجهة المحلية)، مع منع أي مسار يخرج من المجلد
  const obsidianRoot = path.resolve(ctx.obsidianDir);
  const incomingObs = new Map<string, Buffer>();
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('obsidian/')) continue;
    const rel = key.slice('obsidian/'.length);
    const dest = path.resolve(obsidianRoot, rel);
    if (!dest.startsWith(obsidianRoot + path.sep)) throw new Error(`مسار غير آمن داخل النسخة: ${rel}`);
    incomingObs.set(toPosix(path.relative(obsidianRoot, dest)), buf(key)!);
  }
  for (const file of listFilesRecursive(obsidianRoot)) {
    const rel = toPosix(path.relative(obsidianRoot, file));
    if (OBSIDIAN_LOCAL_ONLY.some((re) => re.test(rel))) continue;
    if (!incomingObs.has(rel)) removePathSync(file, { force: true });
  }
  for (const [rel, content] of incomingObs) writeFileAtomic(path.join(obsidianRoot, rel), content);
}

/**
 * Hint بالعربي: دالة تنظيف سجل الأرشفة المحلي بعد الاستيراد. الاستيراد يطابق Obsidian مع النسخة القادمة،
 *               فقد يحذف محادثة أرشفها هذا الجهاز ولم تُنشر بعد. السجل (data/harvest-state.json، محلي)
 *               كان سيظنها مؤرشفة فلا يعيدها أبداً، لذلك يُنسى كل ما حُذف ملفه، فتُعاد أرشفته في الدورة التالية.
 *               المخرجات: عدد الجلسات التي ستُعاد أرشفتها.
 */
export function forgetMissingArchives(ctx: SyncContext): number {
  const file = path.join(ctx.dataDir, 'harvest-state.json');
  const state = readJsonFileSafe<{ version?: number; sessions?: Record<string, { outFile?: string }> } | null>(file, null);
  if (!state || !state.sessions) return 0;
  let forgotten = 0;
  for (const [key, entry] of Object.entries(state.sessions)) {
    if (!entry?.outFile || !fs.existsSync(entry.outFile)) {
      delete state.sessions[key];
      forgotten += 1;
    }
  }
  if (forgotten) writeFileAtomic(file, JSON.stringify(state, null, 2));
  return forgotten;
}

/**
 * Hint بالعربي: نتيجة فحص حالة المزامنة.
 */
export interface SyncCheck {
  manifest: SyncManifest | null;
  baseVersion: number;
  newerAvailable: boolean;
  hasLocalChanges: boolean;
}

/**
 * Hint بالعربي: دالة فحص: هل على Drive إصدار أحدث؟ وهل لدى هذا الجهاز تغييرات غير منشورة؟
 */
export function checkSync(ctx: SyncContext): SyncCheck {
  const manifest = readManifest(ctx);
  const state = readLocalSyncState(ctx);
  const hash = hashSharedState(packSharedState(ctx));
  return {
    manifest,
    baseVersion: state.baseVersion,
    newerAvailable: Boolean(manifest && manifest.latestVersion > state.baseVersion),
    hasLocalChanges: hash !== state.baseHash,
  };
}

/**
 * Hint بالعربي: دالة استيراد أحدث نسخة إن كانت أحدث من أساس هذا الجهاز.
 *               1) تتحقق من التشفير والبصمة، 2) تحفظ نسخة احتياطية من الحالة المحلية، 3) تطبّق النسخة.
 *               تحتاج مفتاح بيانات الخزنة (الخزنة مفتوحة، أو عند فتحها).
 */
export function importLatestSnapshot(
  ctx: SyncContext,
  vault: UnlockedVault
): { imported: boolean; version?: number; from?: string; localBackup?: string; hadLocalChanges?: boolean; reharvest?: number } {
  const manifest = readManifest(ctx);
  const state = readLocalSyncState(ctx);
  if (!manifest || manifest.latestVersion <= state.baseVersion) return { imported: false };
  const file = path.join(ctx.syncRoot, 'snapshots', path.basename(manifest.file));
  let snap: SnapshotFile | null;
  try {
    snap = readSyncJson<SnapshotFile>(file);
  } catch (err) {
    throw new Error(`تعذّرت قراءة النسخة ${manifest.latestVersion}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!snap || snap.format !== 'second-brain-sync-snapshot' || snap.snapshotVersion !== manifest.latestVersion) {
    throw new Error('النسخة المشار إليها في manifest.json غير موجودة بعد على هذا الجهاز (ربما ما زال Google Drive يُنزّلها). أعد المحاولة بعد قليل.');
  }
  let entries: SharedEntries;
  try {
    entries = JSON.parse(openWithKey(snap.payload, vault.dataKey).toString('utf8')) as SharedEntries;
  } catch {
    throw new Error('النسخة على مجلد المزامنة مشفرة بخزنة مختلفة عن خزنة هذا الجهاز، فلم تُستورد.');
  }
  if (hashSharedState(entries) !== snap.contentHash) throw new Error('بصمة النسخة لا تطابق محتواها (ملف ناقص أو معدَّل)، فلم تُستورد.');

  const local = packSharedState(ctx);
  const hadLocalChanges = hashSharedState(local) !== state.baseHash && state.baseVersion > 0;
  const localBackup = saveLocalBackup(ctx, vault, local);
  applySharedState(ctx, entries);
  const reharvest = forgetMissingArchives(ctx);
  writeLocalSyncState(ctx, { baseVersion: snap.snapshotVersion, baseHash: snap.contentHash, lastImportAt: new Date().toISOString(), lastError: undefined });
  logSystemInfo('Sync', `استُورد الإصدار ${snap.snapshotVersion} من «${snap.device.deviceName}». نسخة احتياطية محلية: ${localBackup}` + (reharvest ? `، وستُعاد أرشفة ${reharvest} محادثة حُذفت بالمطابقة.` : ''));
  return { imported: true, version: snap.snapshotVersion, from: snap.device.deviceName, localBackup, hadLocalChanges, reharvest };
}

/**
 * Hint بالعربي: دالة نشر الحالة المحلية كنسخة جديدة. الشروط:
 *               - هذا الجهاز يحمل قفل الكتابة.
 *               - لا يوجد على Drive إصدار أحدث من أساس هذا الجهاز (وإلا يجب الاستيراد أولاً).
 *               - المحتوى تغيّر منذ آخر استيراد أو نشر (إلا مع force).
 */
export function publishSnapshot(
  ctx: SyncContext,
  vault: UnlockedVault,
  options: { force?: boolean } = {}
): { published: boolean; version?: number; reason?: string } {
  const lease = readLeaseStatus(ctx);
  if (lease.kind !== 'mine') throw new Error('لا يملك هذا الجهاز صلاحية الكتابة، فلا يمكنه النشر.');
  const manifest = readManifest(ctx);
  const state = readLocalSyncState(ctx);
  if (manifest && manifest.latestVersion > state.baseVersion) {
    throw new Error(`يوجد على مجلد المزامنة إصدار أحدث (${manifest.latestVersion}) من «${manifest.device.deviceName}». استورده أولاً.`);
  }
  const entries = packSharedState(ctx);
  const contentHash = hashSharedState(entries);
  if (!options.force && contentHash === state.baseHash && state.baseVersion > 0) return { published: false, reason: 'لا تغييرات جديدة' };

  const version = Math.max(state.baseVersion, manifest?.latestVersion ?? 0) + 1;
  const createdAt = new Date().toISOString();
  const vaultFile = readVaultFile(ctx.vaultFile);
  const snapshot: SnapshotFile = {
    format: 'second-brain-sync-snapshot',
    formatVersion: 1,
    snapshotVersion: version,
    baseVersion: state.baseVersion,
    createdAt,
    device: ctx.device,
    contentHash,
    vaultKeys: { commanderWrap: vaultFile.commanderWrap, emergencyWrap: vaultFile.emergencyWrap },
    payload: sealEntries(entries, vault),
  };
  const fileName = `${SNAPSHOT_PREFIX}${String(version).padStart(6, '0')}-${toSafeFileName(ctx.device.deviceName, 'device')}${SNAPSHOT_SUFFIX}`;
  const snapshotsDir = path.join(ctx.syncRoot, 'snapshots');
  // الملف أولاً ثم manifest: إن انقطع النشر في المنتصف يبقى manifest على الإصدار السابق السليم
  writeFileAtomic(path.join(snapshotsDir, fileName), JSON.stringify(snapshot));
  const next: SyncManifest = { format: 'second-brain-sync-manifest', latestVersion: version, file: fileName, contentHash, device: ctx.device, publishedAt: createdAt };
  writeFileAtomic(manifestPath(ctx), JSON.stringify(next, null, 2));
  writeLocalSyncState(ctx, { baseVersion: version, baseHash: contentHash, lastPublishAt: createdAt, lastError: undefined });
  const all = fs.readdirSync(snapshotsDir).filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith(SNAPSHOT_SUFFIX)).sort().reverse();
  for (const old of all.slice(KEEP_SNAPSHOTS)) removePathSync(path.join(snapshotsDir, old), { force: true });
  logSystemInfo('Sync', `نُشر الإصدار ${version} من «${ctx.device.deviceName}».`);
  return { published: true, version };
}

/**
 * Hint بالعربي: دالة كتابة ملف حالة هذا الجهاز في devices/ (آخر ظهور، الإصدار، المنصة) — لصفحة «أجهزتي» لاحقاً.
 */
export function writeDeviceStatus(ctx: SyncContext, appVersion: string): void {
  const state = readLocalSyncState(ctx);
  writeFileAtomic(
    path.join(ctx.syncRoot, 'devices', `${toSafeFileName(ctx.device.deviceId, 'device')}.json`),
    JSON.stringify({ ...ctx.device, appVersion, lastSeenAt: new Date().toISOString(), baseVersion: state.baseVersion }, null, 2)
  );
}
