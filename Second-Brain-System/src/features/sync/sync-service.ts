/**
 * ============================================================================
 * الملف: src/features/sync/sync-service.ts
 * القسم: Features -> Sync (تنسيق المزامنة للخادم — الإصدار 2.0: الكتابة من كل الأجهزة)
 * Hint بالعربي: نقطة الدخول التي يستدعيها الخادم:
 *               - عند فتح الخزنة: دورة مزامنة (ترحيل من 1.9 مرة واحدة، ثم نشر ودمج) قبل إنشاء الجلسة.
 *               - كل دقيقتين، وعند قفل الخزنة، وبزر «زامن الآن»: دورة مزامنة، وملف حالة الجهاز.
 *               - التعارضات (عرضها وحسمها) والسلة (عرضها والاسترجاع منها).
 *               لا قفل كتابة بعد الآن: كل جهاز يكتب متى شاء (القرار في docs/11، الموضوع 1).
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, readAppVersion } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { describeRestartRequired, getRuntimeVersionStatus } from '../../core/runtime-version.ts';
import { readJsonFileSafe, toSafeFileName, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { VaultSecretItem } from '../../shared/types.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { LEGACY_LOCK_DEVICE_ID, lockLegacyClients, resolveConflict, resolveHeldDeletes, restoreFromTrash, runSyncCycle, type SyncCycleResult } from './multi-writer-sync.ts';
import { recordKind } from './records.ts';
import { buildSyncContext, describeSyncIoError, readDeviceInfo, readSyncSettings, type SyncContext } from './sync-context.ts';
import { countConflicts, countHeldIncoming, countTrash, listConflicts, listTrash, readHeldIncoming, readSyncIndex, removeTrashEntry, syncDataDir, type ConflictEntry } from './sync-store.ts';

/** جهاز كما يظهر في صفحة المزامنة */
export interface SyncDeviceView {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion?: string;
  lastSeenAt?: string;
  syncFormat?: number;
  isThisDevice: boolean;
}

/**
 * Hint بالعربي: حالة المزامنة كما تعرضها الواجهة.
 */
export interface SyncStatusView {
  enabled: boolean;
  folder: string;
  folderExists: boolean;
  device: { deviceId: string; deviceName: string; platform: string } | null;
  ready: boolean;
  multiWriter: boolean;
  /** ISS-032: الكود على القرص أحدث من الذي يعمل، والمزامنة متوقفة */
  restartRequired?: boolean;
  problemAr?: string;
  migrated?: boolean;
  lastMergeAt?: string;
  lastPublishAt?: string;
  lastCompactionAt?: string;
  lastError?: string;
  lastWarning?: string;
  conflicts?: number;
  trash?: number;
  /** ISS-028: حذف جماعي بانتظار التأكيد (من هذا الجهاز، أو قادم من جهاز آخر) */
  heldOutgoing?: number;
  heldIncoming?: boolean;
  devices?: SyncDeviceView[];
}

/**
 * Hint بالعربي: دالة قراءة ملفات حالة الأجهزة على مجلد المزامنة.
 */
function readDevices(ctx: SyncContext): SyncDeviceView[] {
  const dir = path.join(ctx.syncRoot, 'devices');
  if (!fs.existsSync(dir)) return [];
  const out: SyncDeviceView[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const d = readJsonFileSafe<Partial<SyncDeviceView> | null>(path.join(dir, name), null);
    if (!d || typeof d.deviceId !== 'string') continue;
    out.push({
      deviceId: d.deviceId,
      deviceName: String(d.deviceName ?? d.deviceId),
      platform: String(d.platform ?? ''),
      appVersion: d.appVersion,
      lastSeenAt: d.lastSeenAt,
      syncFormat: d.syncFormat,
      isThisDevice: d.deviceId === ctx.device.deviceId,
    });
  }
  return out.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
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
    multiWriter: true,
  };
  if (!settings.enabled) return { ...view, problemAr: 'المزامنة مطفأة على هذا الجهاز.' };
  const stale = describeRestartRequired();
  if (stale) return { ...view, restartRequired: true, problemAr: `⏸️ ${stale}` };
  if (!device) return { ...view, problemAr: 'هذا الجهاز بلا هوية. شغّل المثبّت (install-windows.ps1 أو install-macos.sh) مرة واحدة.' };
  if (!view.folderExists) return { ...view, problemAr: 'مجلد المزامنة غير موجود. تأكد أن Google Drive for desktop يعمل وأن المسار صحيح.' };
  const ctx = buildSyncContext()!;
  try {
    const index = readSyncIndex(ctx);
    return {
      ...view,
      ready: true,
      migrated: Boolean(index),
      lastMergeAt: index?.lastMergeAt,
      lastPublishAt: index?.lastPublishAt,
      lastCompactionAt: index?.lastCompactionAt,
      lastError: index?.lastError,
      lastWarning: index?.lastWarning,
      conflicts: countConflicts(ctx),
      trash: countTrash(ctx),
      heldOutgoing: index?.heldDeletes?.keys.length ?? 0,
      heldIncoming: countHeldIncoming(ctx),
      devices: readDevices(ctx),
      problemAr: index ? undefined : 'لم يُرحَّل هذا الجهاز إلى المزامنة الجديدة بعد: افتح الخزنة بكلمة المرور الرئيسية فيتم ذلك تلقائياً.',
    };
  } catch (err) {
    return { ...view, problemAr: describeSyncIoError(err) };
  }
}

/**
 * Hint بالعربي: دالة كتابة ملف حالة هذا الجهاز في devices/ (لصفحة الأجهزة على كل جهاز).
 */
export function writeDeviceStatusFile(ctx: SyncContext): void {
  const index = readSyncIndex(ctx);
  const markers = readJsonFileSafe<Record<string, string>>(path.join(syncDataDir(ctx), 'code-markers.json'), {});
  writeFileAtomic(
    path.join(ctx.syncRoot, 'devices', `${toSafeFileName(ctx.device.deviceId, 'device')}.json`),
    JSON.stringify(
      {
        ...ctx.device,
        appVersion: readAppVersion(),
        runningVersion: getRuntimeVersionStatus().runningVersion,
        restartRequired: getRuntimeVersionStatus().restartRequired,
        syncFormat: index ? 2 : 1,
        lastSeenAt: new Date().toISOString(),
        lastMergeAt: index?.lastMergeAt,
        lastPublishAt: index?.lastPublishAt,
        openConflicts: countConflicts(ctx),
        projectCodeChanges: markers,
      },
      null,
      2
    )
  );
}

function describeCycle(r: SyncCycleResult): string {
  const parts: string[] = [];
  if (r.migrated) parts.push('🎉 رُحّل هذا الجهاز إلى المزامنة الجديدة (الكتابة من كل الأجهزة).');
  if (r.published) parts.push(`⬆️ نُشر ${r.published} تغييراً.`);
  if (r.applied) parts.push(`⬇️ دُمج ${r.applied} تغييراً من الأجهزة الأخرى.`);
  if (r.conflicts) parts.push(`⚠️ ${r.conflicts} تعارضاً جديداً ينتظر قرارك في قسم المزامنة.`);
  parts.push(...r.warnings);
  return parts.join(' ');
}

/**
 * Hint بالعربي: دالة تُستدعى عند فتح الخزنة قبل إنشاء الجلسة: دورة مزامنة كاملة.
 *               لا ترمي أبداً (فشل المزامنة لا يمنع فتح الخزنة)، وتُرجع رسالة لعرضها.
 *               الأسرار تُحدَّث داخل الخزنة المفتوحة نفسها، فلا حاجة لفتحها من جديد.
 */
export function syncOnUnlock(vault: UnlockedVault): { imported: boolean; messageAr?: string } {
  const ctx = buildSyncContext();
  if (!ctx) return { imported: false };
  const stale = describeRestartRequired();
  if (stale) return { imported: false, messageAr: `⏸️ ${stale}` };
  try {
    const r = runSyncCycle(ctx, vault);
    writeDeviceStatusFile(ctx);
    const message = describeCycle(r);
    return { imported: false, messageAr: message ? `🔄 ${message}` : undefined };
  } catch (err) {
    const message = describeSyncIoError(err);
    logSystemInfo('Sync', `تعذرت المزامنة عند فتح الخزنة: ${message}`);
    return { imported: false, messageAr: `⚠️ المزامنة: ${message}` };
  }
}

/**
 * Hint بالعربي: دالة دورية (كل دقيقتين، وعند قفل الخزنة): حالة الجهاز، ودورة مزامنة إن كانت الخزنة مفتوحة.
 *               والخزنة مقفلة: لا يمكن فك أي شيء، فتُكتب حالة الجهاز فقط، ويبقى قفل الأجهزة القديمة قائماً.
 */
export function syncTick(activeVault: UnlockedVault | null): void {
  const ctx = buildSyncContext();
  if (!ctx) return;
  // ISS-032: كود قديم في الذاكرة ← لا دمج ولا نشر (قد يطبّق تغييرات بصيغة لا يفهمها، كما في ISS-028).
  // تُكتب حالة الجهاز فقط، فترى الأجهزة الأخرى أنه يحتاج إعادة تشغيل.
  if (describeRestartRequired()) {
    try {
      writeDeviceStatusFile(ctx);
    } catch {
      // لا شيء
    }
    return;
  }
  try {
    if (activeVault) {
      const r = runSyncCycle(ctx, activeVault);
      if (r.published || r.applied || r.conflicts) logSystemInfo('Sync', describeCycle(r));
    } else if (readSyncIndex(ctx)) {
      lockLegacyClients(ctx);
    }
    writeDeviceStatusFile(ctx);
  } catch (err) {
    logSystemInfo('Sync', `المزامنة الدورية: ${describeSyncIoError(err)}`);
  }
}

function requireCtx(): SyncContext {
  const ctx = buildSyncContext();
  if (!ctx) throw new Error(getSyncStatus().problemAr ?? 'المزامنة غير جاهزة.');
  return ctx;
}

function withSyncErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(describeSyncIoError(err));
  }
}

/**
 * Hint بالعربي: دالة «زامن الآن»: دورة فورية بدل انتظار الدقيقتين.
 */
export function syncNow(vault: UnlockedVault): { messageAr: string } {
  return withSyncErrors(() => {
    const stale = describeRestartRequired();
    if (stale) throw new Error(stale);
    const ctx = requireCtx();
    const r = runSyncCycle(ctx, vault);
    writeDeviceStatusFile(ctx);
    return { messageAr: describeCycle(r) || '✅ كل شيء مُزامَن: لا تغييرات جديدة هنا أو على الأجهزة الأخرى.' };
  });
}

/** معاينة نسخة في تعارض (الأسرار تُعرض بلا قيمتها) */
interface ConflictPreview {
  text: string;
  sizeBytes: number;
}

function previewContent(key: string, base64: string | null): ConflictPreview | null {
  if (base64 === null) return null;
  const buf = Buffer.from(base64, 'base64');
  const kind = recordKind(key);
  if (kind === 'secret') {
    try {
      const s = JSON.parse(buf.toString('utf8')) as VaultSecretItem;
      return {
        text: `العنوان: ${s.title}\nالمستخدم: ${s.usernameOrEmail ?? '—'}\nالرابط: ${s.url ?? '—'}\nالقيمة: (مخفية، ${s.secretValue.length} حرفاً)\nآخر تعديل: ${s.updatedAt}`,
        sizeBytes: buf.length,
      };
    } catch {
      return { text: '(سرّ غير مقروء)', sizeBytes: buf.length };
    }
  }
  if (kind === 'conv') return { text: '(محادثة مشفّرة)', sizeBytes: buf.length };
  const text = buf.toString('utf8');
  const printable = !/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000));
  return { text: printable ? text.slice(0, 4000) : '(ملف ثنائي)', sizeBytes: buf.length };
}

/** تعارض كما يظهر في الواجهة */
export interface ConflictView {
  id: string;
  key: string;
  kind: ConflictEntry['kind'];
  createdAt: string;
  otherDevice: string;
  keptSide: ConflictEntry['keptSide'];
  sideFile?: string;
  current: ConflictPreview | null;
  other: ConflictPreview | null;
}

/**
 * Hint بالعربي: دالة سرد التعارضات المفتوحة مع معاينة النسختين.
 */
export function listSyncConflicts(vault: UnlockedVault): ConflictView[] {
  const ctx = requireCtx();
  const secrets = new Map(vault.secrets.map((s) => [`secret:${s.id}`, s]));
  return listConflicts(ctx, vault.dataKey).map((c) => {
    let current: ConflictPreview | null = null;
    const kind = recordKind(c.key);
    if (kind === 'secret') {
      const s = secrets.get(c.key);
      current = s ? previewContent(c.key, Buffer.from(JSON.stringify(s)).toString('base64')) : null;
    } else if (kind === 'obs') {
      const file = path.join(ctx.obsidianDir, c.key.slice('obs:'.length));
      current = fs.existsSync(file) ? previewContent(c.key, fs.readFileSync(file).toString('base64')) : null;
    } else {
      current = { text: '(النسخة الحالية على هذا الجهاز)', sizeBytes: 0 };
    }
    return {
      id: c.id,
      key: c.key,
      kind: c.kind,
      createdAt: c.createdAt,
      otherDevice: c.otherDevice,
      keptSide: c.keptSide,
      sideFile: c.sideFile,
      current,
      other: previewContent(c.key, c.otherContent),
    };
  });
}

/**
 * Hint بالعربي: دالة حسم تعارض: keep = تبقى النسخة الحالية، other = تُعتمد الأخرى. ثم دورة مزامنة لنشر القرار.
 */
export function resolveSyncConflict(vault: UnlockedVault, id: string, choice: 'keep' | 'other'): { messageAr: string } {
  return withSyncErrors(() => {
    const ctx = requireCtx();
    resolveConflict(ctx, vault, id, choice);
    if (!describeRestartRequired()) runSyncCycle(ctx, vault);
    return { messageAr: choice === 'keep' ? '✅ بقيت النسخة الحالية، ونُقلت الأخرى إلى السلة 30 يوماً.' : '✅ اعتُمدت النسخة الأخرى، ونُقلت الحالية إلى السلة 30 يوماً.' };
  });
}

/**
 * Hint بالعربي: دالة سرد السلة (بلا محتوى الأسرار).
 */
export function listSyncTrash(vault: UnlockedVault): Array<{ id: string; key: string; deletedAt: string; deletedBy: string; label: string }> {
  const ctx = requireCtx();
  return listTrash(ctx, vault.dataKey).map((t) => {
    let label = t.key;
    if (recordKind(t.key) === 'secret') {
      try {
        label = `سرّ: ${(JSON.parse(Buffer.from(t.content, 'base64').toString('utf8')) as VaultSecretItem).title}`;
      } catch {
        label = 'سرّ';
      }
    } else if (recordKind(t.key) === 'obs') label = `Obsidian: ${t.key.slice(4)}`;
    else if (recordKind(t.key) === 'conv') label = 'محادثة';
    else if (recordKind(t.key) === 'project') label = `مشروع: ${t.key.slice(8)}`;
    else if (recordKind(t.key) === 'memory') label = `ذاكرة: ${t.key.slice(7)}`;
    return { id: t.id, key: t.key, deletedAt: t.deletedAt, deletedBy: t.deletedBy, label };
  });
}

/**
 * Hint بالعربي: دالة استرجاع عنصر من السلة ثم نشره (فيعود على كل الأجهزة).
 */
export function restoreSyncTrash(vault: UnlockedVault, id: string): { messageAr: string } {
  return withSyncErrors(() => {
    const ctx = requireCtx();
    const entry = listTrash(ctx, vault.dataKey).find((t) => t.id === id);
    if (!entry) throw new Error('العنصر غير موجود في السلة.');
    restoreFromTrash(ctx, vault, entry);
    removeTrashEntry(ctx, id);
    if (!describeRestartRequired()) runSyncCycle(ctx, vault);
    return { messageAr: '♻️ استُرجع العنصر، ونُشر فيعود على الأجهزة الأخرى أيضاً.' };
  });
}

/** حذف جماعي معلّق كما تعرضه الواجهة */
export interface HeldDeletesView {
  outgoing: { count: number; reasonAr: string; detectedAt: string; sample: string[] } | null;
  incoming: Array<{ deviceName: string; reasonAr: string; detectedAt: string; count: number; sample: string[] }>;
}

function labelKey(key: string): string {
  const kind = recordKind(key);
  return kind === 'obs' ? key.slice(4) : kind === 'secret' ? 'سرّ في الخزنة' : key;
}

/**
 * Hint بالعربي: دالة عرض الحذف الجماعي المعلّق (ISS-028).
 */
export function listHeldDeletes(vault: UnlockedVault): HeldDeletesView {
  const ctx = requireCtx();
  const index = readSyncIndex(ctx);
  const held = index?.heldDeletes;
  return {
    outgoing: held ? { count: held.keys.length, reasonAr: held.reasonAr, detectedAt: held.detectedAt, sample: held.keys.slice(0, 8).map(labelKey) } : null,
    incoming: readHeldIncoming(ctx, vault.dataKey).map((h) => ({ deviceName: h.deviceName, reasonAr: h.reasonAr, detectedAt: h.detectedAt, count: h.changes.length, sample: h.changes.slice(0, 8).map((c) => labelKey(c.key)) })),
  };
}

/**
 * Hint بالعربي: دالة حسم الحذف الجماعي المعلّق ثم دورة مزامنة لنشر القرار.
 */
export function resolveSyncHeldDeletes(vault: UnlockedVault, direction: 'outgoing' | 'incoming', action: 'confirm' | 'reject'): { messageAr: string } {
  return withSyncErrors(() => {
    const ctx = requireCtx();
    const n = resolveHeldDeletes(ctx, vault, direction, action);
    if (!describeRestartRequired()) runSyncCycle(ctx, vault);
    const msg =
      direction === 'outgoing'
        ? action === 'confirm'
          ? `🗑️ نُشر حذف ${n} عنصراً إلى كل الأجهزة (وتبقى في السلة 30 يوماً).`
          : `♻️ أُعيد ${n} عنصراً إلى هذا الجهاز، ولم يُنشر أي حذف.`
        : action === 'confirm'
          ? `🗑️ طُبّق الحذف القادم هنا (${n} عنصراً، في السلة 30 يوماً).`
          : `♻️ بقيت ${n} عنصراً هنا، وستعود إلى الجهاز الآخر أيضاً.`;
    return { messageAr: msg };
  });
}

/** معرّف قفل الأجهزة القديمة (للواجهة: لا يُعرض كجهاز) */
export { LEGACY_LOCK_DEVICE_ID };
