/**
 * ============================================================================
 * الملف: src/features/sync/sync-service.ts
 * القسم: Features -> Sync (تنسيق المزامنة للخادم)
 * Hint بالعربي: نقطة الدخول التي يستدعيها الخادم:
 *               - عند فتح الخزنة: استيراد أي إصدار أحدث قبل إنشاء الجلسة.
 *               - كل دقيقتين: إشارة حياة لقفل الكتابة، وملف حالة الجهاز، ونشر التغييرات إن وُجدت.
 *               - نقل الكتابة إلى هذا الجهاز (استيراد ثم أخذ القفل)، وتركها (نشر ثم ترك القفل).
 *               - حالة المزامنة لعرضها في الواجهة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, readAppVersion } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { acquireLease, buildSyncContext, heartbeatLease, readDeviceInfo, readLeaseStatus, readLocalSyncState, readSyncSettings, describeSyncIoError, releaseLease, writeLocalSyncState, type SyncContext } from './sync-context.ts';
import { checkSync, hasAnySnapshots, importLatestSnapshot, publishSnapshot, readManifest, writeDeviceStatus } from './snapshot-sync.ts';

/**
 * Hint بالعربي: حالة المزامنة كما تعرضها الواجهة.
 */
export interface SyncStatusView {
  enabled: boolean;
  folder: string;
  folderExists: boolean;
  device: { deviceId: string; deviceName: string; platform: string } | null;
  ready: boolean;
  problemAr?: string;
  lease?: { kind: string; holder?: string; heartbeatAt?: string };
  canWrite?: boolean;
  baseVersion?: number;
  latestVersion?: number;
  latestFrom?: string;
  newerAvailable?: boolean;
  hasLocalChanges?: boolean;
  lastImportAt?: string;
  lastPublishAt?: string;
  lastError?: string;
}

/**
 * Hint بالعربي: دالة حالة المزامنة الكاملة (بلا أي تعديل).
 */
export function getSyncStatus(): SyncStatusView {
  const settings = readSyncSettings();
  const dataDir = path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data');
  const device = readDeviceInfo(dataDir);
  const view: SyncStatusView = {
    enabled: settings.enabled,
    folder: settings.folder,
    folderExists: Boolean(settings.folder) && fs.existsSync(settings.folder),
    device,
    ready: false,
  };
  if (!settings.enabled) return { ...view, problemAr: 'المزامنة مطفأة على هذا الجهاز.' };
  if (!device) return { ...view, problemAr: 'هذا الجهاز بلا هوية. شغّل المثبّت (install-windows.ps1 أو install-macos.sh) مرة واحدة.' };
  if (!view.folderExists) return { ...view, problemAr: 'مجلد المزامنة غير موجود. تأكد أن Google Drive for desktop يعمل وأن المسار صحيح.' };
  const ctx = buildSyncContext()!;
  let lease: ReturnType<typeof readLeaseStatus>;
  let check: ReturnType<typeof checkSync>;
  const state = readLocalSyncState(ctx);
  try {
    lease = readLeaseStatus(ctx);
    check = checkSync(ctx);
  } catch (err) {
    return { ...view, problemAr: describeSyncIoError(err), lastError: state.lastError };
  }
  return {
    ...view,
    ready: true,
    lease: lease.kind === 'none' ? { kind: 'none' } : { kind: lease.kind, holder: lease.lease.deviceName, heartbeatAt: lease.lease.heartbeatAt },
    canWrite: lease.kind === 'mine',
    baseVersion: check.baseVersion,
    latestVersion: check.manifest?.latestVersion ?? 0,
    latestFrom: check.manifest?.device.deviceName,
    newerAvailable: check.newerAvailable,
    hasLocalChanges: check.hasLocalChanges,
    lastImportAt: state.lastImportAt,
    lastPublishAt: state.lastPublishAt,
    lastError: state.lastError,
  };
}

/**
 * Hint بالعربي: دالة تُستدعى عند فتح الخزنة قبل إنشاء الجلسة: تستورد أي إصدار أحدث.
 *               لا ترمي أبداً (فشل المزامنة لا يمنع فتح الخزنة)، وتُرجع رسالة لعرضها.
 */
export function syncOnUnlock(vault: UnlockedVault): { imported: boolean; messageAr?: string } {
  const ctx = buildSyncContext();
  if (!ctx) return { imported: false };
  try {
    const r = importLatestSnapshot(ctx, vault);
    if (!r.imported) return { imported: false };
    return {
      imported: true,
      messageAr:
        `🔄 استُورد الإصدار ${r.version} من «${r.from}».` +
        (r.hadLocalChanges ? ' كانت على هذا الجهاز تغييرات غير منشورة، وحُفظت في نسخة احتياطية محلية.' : ''),
    };
  } catch (err) {
    const message = describeSyncIoError(err);
    writeLocalSyncState(ctx, { lastError: message });
    logSystemInfo('Sync', `تعذر الاستيراد عند فتح الخزنة: ${message}`);
    return { imported: false, messageAr: `⚠️ المزامنة: ${message}` };
  }
}

/**
 * Hint بالعربي: دالة دورية (كل دقيقتين): إشارة حياة، وحالة الجهاز، ونشر التغييرات إن كانت الخزنة مفتوحة.
 */
export function syncTick(activeVault: UnlockedVault | null): void {
  const ctx = buildSyncContext();
  if (!ctx) return;
  try {
    heartbeatLease(ctx);
    writeDeviceStatus(ctx, readAppVersion());
    if (activeVault && activeVault.unlockedBy === 'commander' && readLeaseStatus(ctx).kind === 'mine') {
      publishSnapshot(ctx, activeVault);
    }
  } catch (err) {
    const message = describeSyncIoError(err);
    writeLocalSyncState(ctx, { lastError: message });
    logSystemInfo('Sync', `المزامنة الدورية: ${message}`);
  }
}

function requireCtx(): SyncContext {
  const ctx = buildSyncContext();
  if (!ctx) throw new Error(getSyncStatus().problemAr ?? 'المزامنة غير جاهزة.');
  return ctx;
}

/**
 * Hint بالعربي: دالة نقل الكتابة إلى هذا الجهاز: يستورد آخر إصدار أولاً ثم يأخذ القفل،
 *               ثم ينشر فوراً إن كان أول جهاز (لا يوجد أي إصدار بعد).
 */
export function takeWriteLease(vault: UnlockedVault, force: boolean): { messageAr: string } {
  return withSyncErrors(() => takeWriteLeaseUnsafe(vault, force));
}

function takeWriteLeaseUnsafe(vault: UnlockedVault, force: boolean): { messageAr: string } {
  const ctx = requireCtx();
  // الاستيراد أولاً: إن تعذّرت قراءة manifest أو النسخة يتوقف هنا، قبل أخذ القفل
  const imported = importLatestSnapshot(ctx, vault);
  const manifestBefore = readManifest(ctx);
  if (!manifestBefore && hasAnySnapshots(ctx)) {
    throw new Error('في مجلد المزامنة نسخ منشورة لكن manifest.json غير موجود (ربما ما زال Google Drive يُنزّله). أعد المحاولة بعد قليل. لم يُغيَّر أي شيء.');
  }
  acquireLease(ctx, { force });
  const first = !manifestBefore;
  if (first) publishSnapshot(ctx, vault, { force: true });
  return {
    messageAr:
      `✍️ صار «${ctx.device.deviceName}» حامل صلاحية الكتابة.` +
      (imported.imported ? ` استُورد قبلها الإصدار ${imported.version}.` : '') +
      (first ? ' ونُشر أول إصدار.' : ''),
  };
}

/**
 * Hint بالعربي: دالة النشر الفوري (زر «انشر الآن»).
 */
export function publishNow(vault: UnlockedVault): { messageAr: string } {
  return withSyncErrors(() => publishNowUnsafe(vault));
}

function publishNowUnsafe(vault: UnlockedVault): { messageAr: string } {
  const ctx = requireCtx();
  const r = publishSnapshot(ctx, vault);
  return { messageAr: r.published ? `⬆️ نُشر الإصدار ${r.version}.` : `لا حاجة للنشر: ${r.reason}.` };
}

/**
 * Hint بالعربي: دالة ترك الكتابة (قبل الانتقال إلى جهاز آخر): ينشر آخر التغييرات ثم يترك القفل.
 */
export function releaseWriteLease(vault: UnlockedVault): { messageAr: string } {
  return withSyncErrors(() => releaseWriteLeaseUnsafe(vault));
}

/**
 * Hint بالعربي: يترجم أخطاء مجلد المزامنة (مثل EDEADLK من Google Drive) إلى رسالة عربية قبل وصولها للواجهة.
 */
function withSyncErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(describeSyncIoError(err));
  }
}

function releaseWriteLeaseUnsafe(vault: UnlockedVault): { messageAr: string } {
  const ctx = requireCtx();
  const r = publishSnapshot(ctx, vault);
  releaseLease(ctx);
  return { messageAr: `🔓 تُركت صلاحية الكتابة${r.published ? ` بعد نشر الإصدار ${r.version}` : ''}. يمكن الآن نقلها إلى جهاز آخر.` };
}
