/**
 * ============================================================================
 * الملف: src/features/family-emergency/backup-service.ts
 * القسم: Features -> Family Emergency (ميزة النسخ الاحتياطي المشفر والاستعادة)
 * Hint بالعربي: يجمع ملفات Obsidian-Vault والخزنة والإعدادات والذاكرة في حزمة واحدة مشفرة بمفتاح
 *               بيانات الخزنة. الحزمة تحمل معها مغلّفي المفتاح، لذلك تُفتح بكلمة المرور الرئيسية
 *               أو بمفتاح الطوارئ للزوجة — حتى على جهاز جديد تماماً بعد تعطّل الحاسوب.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SealedData } from '../../shared/types.ts';
import { ensureDirectoryExists, formatTimestampIso, listFilesRecursive, readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { loadSystemConfig, resolveDefaultConfigPath, resolveSettingsPath } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { readVaultFile, unwrapVaultDataKey, type UnlockedVault, type VaultKeyEnvelopes } from '../vault/vault-manager.ts';

/** بادئة ولاحقة اسم ملف النسخة الاحتياطية */
const BACKUP_PREFIX = 'Second-Brain-Backup-';
const BACKUP_SUFFIX = '.enc.json';
/** المسار الثابت للإعدادات داخل النسخة (مهما كان مكانها الفعلي) */
const CONFIG_ENTRY = 'Second-Brain-System/config/branding.json';
const SETTINGS_ENTRY = 'Second-Brain-System/config/settings.json';

/**
 * Hint بالعربي: محتوى النسخة الاحتياطية بعد فك تشفيرها.
 */
export interface FullSystemSnapshot {
  createdAt: string;
  appName: string;
  filesCount: number;
  filesMap: Record<string, string>; // مسار نسبي -> محتوى بترميز Base64
}

/**
 * Hint بالعربي: هيكل ملف النسخة الاحتياطية (الصيغة الثانية).
 */
export interface EncryptedBackupFileV2 {
  format: 'second-brain-backup';
  version: 2;
  createdAt: string;
  filesCount: number;
  vaultKeys: VaultKeyEnvelopes;
  payload: SealedData;
}

/**
 * Hint بالعربي: دالة إنشاء نسخة احتياطية مشفرة كاملة من الخزنة المفتوحة.
 *               تشمل: Obsidian-Vault، ملف الخزنة، الإعدادات، والذاكرة المشتركة.
 *               تحفظ في مجلد النسخ (وفي المجلد الإضافي إن وُجد) وتحذف الأقدم من حد الاحتفاظ.
 */
export function createEncryptedSystemBackup(
  vault: UnlockedVault,
  options: { outputDir?: string; extraOutputDir?: string; keep?: number } = {}
): { backupFilePath: string; extraCopyPath?: string; filesIncluded: number; removedOldBackups: number } {
  const config = loadSystemConfig();
  const outDir = options.outputDir ?? config.paths.encryptedBackupsDir;
  const extraDir = options.extraOutputDir ?? config.security?.extraBackupDir;
  const keep = Math.max(1, options.keep ?? config.security?.backupRetention ?? 10);

  const filesMap: Record<string, string> = {};
  const addFile = (absPath: string, relKey?: string): void => {
    if (!fs.existsSync(absPath)) return;
    const key = (relKey ?? path.relative(config.paths.rootDir, absPath)).replace(/\\/g, '/');
    filesMap[key] = fs.readFileSync(absPath).toString('base64');
  };

  for (const filePath of listFilesRecursive(config.paths.obsidianVaultDir)) addFile(filePath);
  addFile(vault.vaultFilePath);
  addFile(resolveDefaultConfigPath(), CONFIG_ENTRY);
  // الإعدادات (المشاريع، الدخل والفواتير، الذكاء...) — ضرورية للاستعادة الكاملة على جهاز جديد
  addFile(resolveSettingsPath(), SETTINGS_ENTRY);
  addFile(path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'ai-memory-store.json'));

  const createdAt = formatTimestampIso();
  const snapshot: FullSystemSnapshot = { createdAt, appName: config.appName, filesCount: Object.keys(filesMap).length, filesMap };
  const vaultFile = readVaultFile(vault.vaultFilePath);
  const backup: EncryptedBackupFileV2 = {
    format: 'second-brain-backup',
    version: 2,
    createdAt,
    filesCount: snapshot.filesCount,
    vaultKeys: { commanderWrap: vaultFile.commanderWrap, emergencyWrap: vaultFile.emergencyWrap },
    payload: sealWithKey(JSON.stringify(snapshot), vault.dataKey),
  };

  const stamp = createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
  const backupFilePath = path.join(outDir, fileName);
  const serialized = JSON.stringify(backup);
  writeFileAtomic(backupFilePath, serialized);

  let extraCopyPath: string | undefined;
  if (extraDir) {
    extraCopyPath = path.join(extraDir, fileName);
    writeFileAtomic(extraCopyPath, serialized);
  }

  const removedOldBackups = pruneOldBackups(outDir, keep);
  logSystemInfo('BackupService', `تم إنشاء نسخة احتياطية مشفرة تشمل (${snapshot.filesCount}) ملف في: ${backupFilePath}`);
  return { backupFilePath, extraCopyPath, filesIncluded: snapshot.filesCount, removedOldBackups };
}

/**
 * Hint بالعربي: دالة حذف النسخ الاحتياطية الأقدم مع الإبقاء على أحدث (keep) نسخة. المخرجات: عدد المحذوف.
 */
export function pruneOldBackups(backupsDir: string, keep: number): number {
  const all = listEncryptedBackups(backupsDir);
  const toRemove = all.slice(keep);
  for (const b of toRemove) fs.unlinkSync(b.filePath);
  return toRemove.length;
}

/**
 * Hint بالعربي: دالة سرد النسخ الاحتياطية الموجودة في مجلد (الأحدث أولاً) مع حجمها وتاريخها.
 */
export function listEncryptedBackups(backupsDir?: string): Array<{ fileName: string; filePath: string; sizeBytes: number; modifiedAt: string }> {
  const dir = backupsDir ?? loadSystemConfig().paths.encryptedBackupsDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .map((fileName) => {
      const filePath = path.join(dir, fileName);
      const stat = fs.statSync(filePath);
      return { fileName, filePath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
}

/**
 * Hint بالعربي: دالة فتح نسخة احتياطية وفك تشفيرها بكلمة المرور الرئيسية أو بمفتاح الطوارئ (دون الحاجة لخزنة على الجهاز).
 */
export function openEncryptedBackup(backupFilePath: string, passwordOrEmergencyKey: string): FullSystemSnapshot {
  if (!backupFilePath.endsWith(BACKUP_SUFFIX)) {
    throw new Error(`ملف النسخة الاحتياطية يجب أن ينتهي بـ ${BACKUP_SUFFIX}`);
  }
  const backup = readJsonFileSafe<Partial<EncryptedBackupFileV2> | null>(backupFilePath, null);
  if (!backup) throw new Error(`ملف النسخة الاحتياطية غير موجود أو تالف: ${backupFilePath}`);
  if (backup.format !== 'second-brain-backup' || backup.version !== 2 || !backup.vaultKeys || !backup.payload) {
    throw new Error('صيغة النسخة الاحتياطية قديمة أو غير معروفة.');
  }
  const { dataKey } = unwrapVaultDataKey(backup.vaultKeys, passwordOrEmergencyKey);
  try {
    return JSON.parse(openWithKey(backup.payload, dataKey).toString('utf-8')) as FullSystemSnapshot;
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Hint بالعربي: دالة استعادة نسخة احتياطية إلى مجلد جديد أو فارغ فقط (لا تكتب فوق بياناتك الحالية أبداً).
 *               مع dryRun = true تُرجع قائمة الملفات للمعاينة دون كتابة أي شيء.
 */
export function restoreEncryptedBackup(
  backupFilePath: string,
  passwordOrEmergencyKey: string,
  targetDir: string,
  options: { dryRun?: boolean } = {}
): { targetDir: string; files: string[]; createdAt: string; written: boolean } {
  const snapshot = openEncryptedBackup(backupFilePath, passwordOrEmergencyKey);
  const resolvedTarget = path.resolve(targetDir);
  const files = Object.keys(snapshot.filesMap).sort();

  for (const rel of files) {
    const dest = path.resolve(resolvedTarget, rel);
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`مسار غير آمن داخل النسخة الاحتياطية: ${rel}`);
    }
  }

  if (options.dryRun) {
    return { targetDir: resolvedTarget, files, createdAt: snapshot.createdAt, written: false };
  }

  if (fs.existsSync(resolvedTarget) && fs.readdirSync(resolvedTarget).length > 0) {
    throw new Error('مجلد الاستعادة يجب أن يكون جديداً أو فارغاً حتى لا تُستبدل أي بيانات موجودة.');
  }
  ensureDirectoryExists(resolvedTarget);
  for (const rel of files) {
    writeFileAtomic(path.resolve(resolvedTarget, rel), Buffer.from(snapshot.filesMap[rel], 'base64'));
  }
  logSystemInfo('BackupService', `تمت استعادة نسخة احتياطية (${files.length} ملف) إلى: ${resolvedTarget}`);
  return { targetDir: resolvedTarget, files, createdAt: snapshot.createdAt, written: true };
}
