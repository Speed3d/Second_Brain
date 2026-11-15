/**
 * ============================================================================
 * الملف: src/features/sync/sync-context.ts
 * القسم: Features -> Sync (سياق المزامنة: هوية الجهاز، الحالة المحلية، قفل الكتابة)
 * Hint بالعربي: كل جهاز يعمل محلياً بالكامل، والمزامنة تتم عبر مجلد مُزامَن (Google Drive عادةً):
 *               <المجلد>/Second-Brain-Sync/ { manifest.json, write-lease.json, snapshots/, devices/ }.
 *               قفل الكتابة يسمح لجهاز واحد فقط بتعديل البيانات المشتركة، والباقي في وضع القراءة.
 *               القفل ينتهي إن لم يرسل حامله إشارة حياة لمدة 30 دقيقة.
 *               كل الدوال تأخذ "سياقاً" صريحاً (المسارات + الجهاز) حتى تُختبر بمحاكاة عدة أجهزة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig, readRawSettings, resolveDefaultConfigPath, resolveSettingsPath } from '../../core/config-manager.ts';
import { readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';

/** مدة انتهاء قفل الكتابة بلا إشارة حياة */
export const LEASE_EXPIRY_MS = 30 * 60 * 1000;
export const SYNC_FOLDER_NAME = 'Second-Brain-Sync';

/**
 * Hint بالعربي: هوية الجهاز (من data/device.json الذي يكتبه المثبّت).
 */
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
}

/**
 * Hint بالعربي: سياق المزامنة لجهاز واحد: مكان البيانات المحلية ومجلد المزامنة.
 */
export interface SyncContext {
  device: DeviceInfo;
  syncRoot: string;
  rootDir: string;
  dataDir: string;
  vaultFile: string;
  obsidianDir: string;
  brandingPath: string;
  settingsPath: string;
}

/**
 * Hint بالعربي: حالة المزامنة المحلية لهذا الجهاز (data/sync-state.json — لا تُزامَن).
 */
export interface LocalSyncState {
  /** آخر إصدار استورده هذا الجهاز أو نشره (أساس التعديلات المحلية) */
  baseVersion: number;
  /** بصمة المحتوى عند آخر استيراد أو نشر (لمعرفة وجود تغييرات غير منشورة) */
  baseHash: string;
  lastImportAt?: string;
  lastPublishAt?: string;
  lastError?: string;
}

/**
 * Hint بالعربي: قفل الكتابة على مجلد المزامنة.
 */
export interface WriteLease {
  deviceId: string;
  deviceName: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export type LeaseStatus =
  | { kind: 'none' }
  | { kind: 'mine'; lease: WriteLease }
  | { kind: 'other'; lease: WriteLease }
  | { kind: 'other-expired'; lease: WriteLease };

/**
 * Hint بالعربي: دالة قراءة هوية الجهاز من data/device.json (null إن لم يُثبَّت البرنامج بعد بالمثبّت).
 */
export function readDeviceInfo(dataDir: string): DeviceInfo | null {
  const raw = readJsonFileSafe<Partial<DeviceInfo> | null>(path.join(dataDir, 'device.json'), null);
  if (!raw || typeof raw.deviceId !== 'string' || !raw.deviceId) return null;
  return {
    deviceId: raw.deviceId,
    deviceName: typeof raw.deviceName === 'string' && raw.deviceName ? raw.deviceName : os.hostname(),
    platform: typeof raw.platform === 'string' ? raw.platform : process.platform,
  };
}

/**
 * Hint بالعربي: إعدادات المزامنة لهذا الجهاز (من settings.json؛ خاصة بالجهاز ولا تُزامَن).
 */
export function readSyncSettings(configPath: string = resolveDefaultConfigPath()): { enabled: boolean; folder: string } {
  const raw = readRawSettings(configPath) as Record<string, unknown>;
  const s = (raw.sync && typeof raw.sync === 'object' ? raw.sync : {}) as { enabled?: unknown; folder?: unknown };
  return { enabled: s.enabled === true, folder: typeof s.folder === 'string' ? s.folder : '' };
}

/**
 * Hint بالعربي: دالة بناء سياق المزامنة من إعدادات هذا الجهاز. ترجع null إن كانت المزامنة مطفأة
 *               أو المجلد غير موجود أو الجهاز بلا هوية.
 */
export function buildSyncContext(): SyncContext | null {
  const settings = readSyncSettings();
  if (!settings.enabled || !settings.folder) return null;
  const config = loadSystemConfig();
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const device = readDeviceInfo(dataDir);
  if (!device || !fs.existsSync(settings.folder)) return null;
  return {
    device,
    syncRoot: path.join(settings.folder, SYNC_FOLDER_NAME),
    rootDir: config.paths.rootDir,
    dataDir,
    vaultFile: config.paths.encryptedVaultFile,
    obsidianDir: config.paths.obsidianVaultDir,
    brandingPath: resolveDefaultConfigPath(),
    settingsPath: resolveSettingsPath(),
  };
}

function statePath(ctx: SyncContext): string {
  return path.join(ctx.dataDir, 'sync-state.json');
}

/**
 * Hint بالعربي: دالة قراءة حالة المزامنة المحلية.
 */
export function readLocalSyncState(ctx: SyncContext): LocalSyncState {
  const s = readJsonFileSafe<Partial<LocalSyncState>>(statePath(ctx), {});
  return {
    baseVersion: Number.isInteger(s.baseVersion) ? (s.baseVersion as number) : 0,
    baseHash: typeof s.baseHash === 'string' ? s.baseHash : '',
    lastImportAt: s.lastImportAt,
    lastPublishAt: s.lastPublishAt,
    lastError: s.lastError,
  };
}

/**
 * Hint بالعربي: دالة حفظ حالة المزامنة المحلية (دمج مع الموجود).
 */
export function writeLocalSyncState(ctx: SyncContext, patch: Partial<LocalSyncState>): LocalSyncState {
  const next = { ...readLocalSyncState(ctx), ...patch };
  writeFileAtomic(statePath(ctx), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Hint بالعربي: دالة ترجمة أخطاء القراءة والكتابة في مجلد المزامنة إلى رسالة عربية واضحة.
 *               أهمها EDEADLK (رمز -11 على الماك): Google Drive لم يُنزّل ملفاً موجوداً في السحابة فقط،
 *               لأن الخادم يعمل في الخلفية (LaunchAgent) بلا إذن تنزيل. يُحل بـ MaterializeDatalessFiles في المثبّت.
 */
export function describeSyncIoError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (e?.code === 'EDEADLK' || e?.errno === -11 || /system error -11\b/.test(message)) {
    return 'لم يسمح Google Drive للخادم بتنزيل ملف من مجلد المزامنة (الملف في السحابة فقط، والخادم يعمل في الخلفية). على الماك: أعد تشغيل المثبّت install/macos/install-macos.sh (الإصدار 1.9.3 أو أحدث) ثم أعد المحاولة. لم يُغيَّر أي شيء.';
  }
  if (e?.code === 'EBUSY' || e?.code === 'EAGAIN' || e?.code === 'ETIMEDOUT') {
    return 'Google Drive مشغول بملف في مجلد المزامنة الآن. أعد المحاولة بعد قليل. لم يُغيَّر أي شيء.';
  }
  return message;
}

/**
 * Hint بالعربي: دالة قراءة ملف JSON من مجلد المزامنة بأمان:
 *               - غير موجود ← null (هذا وحده يعني «لا يوجد»).
 *               - تعذّرت قراءته أو تحليله (Drive لم يُنزّله، أو نُزّل نصفه) ← خطأ يوقف العملية،
 *                 حتى لا يُعامل ملف غير مقروء كأنه غير موجود (فيُؤخذ قفل محجوز أو يُنشر فوق إصدار أحدث).
 */
export function readSyncJson<T>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)}: ${describeSyncIoError(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${path.basename(file)} على مجلد المزامنة غير مكتمل أو تالف (ربما ما زال Google Drive يُنزّله). أعد المحاولة بعد قليل. لم يُغيَّر أي شيء.`);
  }
}

function leasePath(ctx: SyncContext): string {
  return path.join(ctx.syncRoot, 'write-lease.json');
}

/**
 * Hint بالعربي: دالة قراءة حالة قفل الكتابة بالنسبة لهذا الجهاز.
 */
export function readLeaseStatus(ctx: SyncContext, now: number = Date.now()): LeaseStatus {
  const lease = readSyncJson<WriteLease>(leasePath(ctx));
  if (!lease) return { kind: 'none' };
  if (typeof lease.deviceId !== 'string') throw new Error('write-lease.json على مجلد المزامنة بصيغة غير معروفة. لم يُغيَّر أي شيء.');
  if (lease.deviceId === ctx.device.deviceId) return { kind: 'mine', lease };
  const beat = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(beat) || now - beat > LEASE_EXPIRY_MS) return { kind: 'other-expired', lease };
  return { kind: 'other', lease };
}

/**
 * Hint بالعربي: دالة أخذ قفل الكتابة لهذا الجهاز. ترفض إن كان القفل نشطاً عند جهاز آخر،
 *               إلا مع force (نقل يدوي يؤكده القائد، مثلاً إن تعطّل الجهاز الآخر).
 *               يجب استيراد آخر إصدار قبل أخذ القفل (تتولاه دالة الاستيراد في snapshot-sync).
 */
export function acquireLease(ctx: SyncContext, options: { force?: boolean; now?: number } = {}): WriteLease {
  const now = options.now ?? Date.now();
  const status = readLeaseStatus(ctx, now);
  if (status.kind === 'other' && !options.force) {
    throw new Error(`الكتابة الآن على جهاز «${status.lease.deviceName}». انقلها بتأكيد صريح أو انتظر انتهاء قفله.`);
  }
  const stamp = new Date(now).toISOString();
  const lease: WriteLease = {
    deviceId: ctx.device.deviceId,
    deviceName: ctx.device.deviceName,
    acquiredAt: status.kind === 'mine' ? status.lease.acquiredAt : stamp,
    heartbeatAt: stamp,
  };
  writeFileAtomic(leasePath(ctx), JSON.stringify(lease, null, 2));
  return lease;
}

/**
 * Hint بالعربي: دالة إرسال إشارة حياة (تُحدّث وقت القفل) إن كان القفل لهذا الجهاز.
 */
export function heartbeatLease(ctx: SyncContext, now: number = Date.now()): boolean {
  const status = readLeaseStatus(ctx, now);
  if (status.kind !== 'mine') return false;
  writeFileAtomic(leasePath(ctx), JSON.stringify({ ...status.lease, heartbeatAt: new Date(now).toISOString() }, null, 2));
  return true;
}

/**
 * Hint بالعربي: دالة ترك قفل الكتابة (قبل الانتقال إلى جهاز آخر).
 */
export function releaseLease(ctx: SyncContext): boolean {
  if (readLeaseStatus(ctx).kind !== 'mine') return false;
  fs.rmSync(leasePath(ctx), { force: true });
  return true;
}

/**
 * Hint بالعربي: دالة الحارس: هل يحق لهذا الجهاز تعديل البيانات المشتركة الآن؟
 *               المزامنة مطفأة ← نعم دائماً. مفعّلة ← فقط إن كان القفل لهذا الجهاز.
 *               تُستخدم في الخادم، والمراقب الدوري، والأرشفة، وخادم MCP.
 */
export function checkWriteAccess(ctx: SyncContext | null = buildSyncContext()): { allowed: boolean; reasonAr?: string; holder?: string } {
  if (!ctx) return { allowed: true };
  let status: LeaseStatus;
  try {
    status = readLeaseStatus(ctx);
  } catch (err) {
    // تعذّرت قراءة القفل ← نرفض الكتابة (الأمان أولاً) بدل افتراض أن لا أحد يكتب
    return { allowed: false, reasonAr: `تعذّر التحقق من صلاحية الكتابة: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (status.kind === 'mine') return { allowed: true };
  if (status.kind === 'none') return { allowed: false, reasonAr: 'لا يحمل أي جهاز صلاحية الكتابة. اضغط «انقل الكتابة إلى هذا الجهاز» في قسم المزامنة.' };
  return {
    allowed: false,
    holder: status.lease.deviceName,
    reasonAr: `هذا الجهاز في وضع القراءة: الكتابة الآن على «${status.lease.deviceName}». انقلها إلى هنا من قسم المزامنة.`,
  };
}
