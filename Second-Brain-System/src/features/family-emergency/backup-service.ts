/**
 * ============================================================================
 * الملف: src/features/family-emergency/backup-service.ts
 * القسم: Features -> Family Emergency (ميزة النسخ الاحتياطي المشفر والاستعادة)
 * Hint بالعربي: يجمع ملفات Obsidian-Vault والخزنة والإعدادات والذاكرة والمحادثات في حزمة مشفرة.
 *               الصيغة 3 (3.0.0، بعد الخزنة العائلية) فيها حمولتان:
 *               - الحمولة الكاملة: بمفتاح البيانات، وتُفتح بكلمة المرور الرئيسية وحدها.
 *               - الحمولة العائلية: بالمفتاح العائلي، وتُفتح بمفتاح الطوارئ. فيها ما تحتاجه العائلة فقط:
 *                 ملف الخزنة (الجزء العائلي منه)، والإعدادات، وأدلة العائلة، ومحادثات العائلة.
 *               الصيغة 2 القديمة (مفتاح الطوارئ يفتح كل شيء) تُقرأ فقط، ولا تُكتب بعد الترقية.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SealedData, WrappedKey } from '../../shared/types.ts';
import { ensureDirectoryExists, formatTimestampIso, listFilesRecursive, readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';
import { isValidEmergencyKey, normalizeEmergencyKey, openWithKey, sealWithKey, unwrapDataKey } from '../../core/crypto-engine.ts';
import { loadSystemConfig, resolveDefaultConfigPath, resolveSettingsPath } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { listKnowledgeFiles } from '../knowledge/knowledge-store.ts';
import { hasMainDataKey, isFamilyVaultFile, openVaultKeys, readVaultFile, resolveFamilyKey, type UnlockedVault, type VaultKeyEnvelopes } from '../vault/vault-manager.ts';

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
  /** 3.0.0: «family» = الحمولة العائلية وحدها (فُتحت بمفتاح الطوارئ)، وغيابه = النسخة الكاملة */
  scope?: 'full' | 'family';
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
 * Hint بالعربي: هيكل ملف النسخة الاحتياطية (الصيغة الثالثة، 3.0.0): لا غلاف طوارئ للحمولة الكاملة.
 */
export interface EncryptedBackupFileV3 {
  format: 'second-brain-backup';
  version: 3;
  createdAt: string;
  filesCount: number;
  vaultKeys: { commanderWrap: WrappedKey };
  payload: SealedData;
  family: { fkByEmergency: WrappedKey; filesCount: number; payload: SealedData };
}

/**
 * Hint بالعربي: هل يدخل هذا الملف في الحمولة العائلية؟ (أدلة العائلة، ودليل كل مشروع للعائلة، والإعدادات، وملف الخزنة)
 *               محادثات العائلة تُضاف بعد فحص نطاقها.
 */
export function isFamilyBackupEntry(rel: string): boolean {
  return (
    rel === CONFIG_ENTRY ||
    rel === SETTINGS_ENTRY ||
    /(^|\/)encrypted-vault\/[^/]+\.json$/.test(rel) ||
    /^Obsidian-Vault\/04-Family-Emergency-Guide\//.test(rel) ||
    /^Obsidian-Vault\/02-Projects\/[^/]+\/06-Wife-Guide\.md$/.test(rel) ||
    // 3.1.0: سجل خطوات الطوارئ (مختوم بالمفتاح العائلي أصلاً)
    /(^|\/)data\/family-log\/flog-[0-9]{13}-[a-f0-9]{8}\.enc\.json$/.test(rel)
  );
}

/**
 * Hint بالعربي: هل هذا المسار مما يضعه البرنامج في النسخ؟ (3.9.9، ISS-052) الاستعادة ترفض أي نسخة فيها غيره،
 *               فلا تصبح «نسخة» مصنوعة باليد وسيلة لكتابة ملفات بأي اسم باسم القائد.
 *               المسموح: Obsidian-Vault كله، وملف الخزنة، والهوية والإعدادات، والذاكرة المشتركة، والمحادثات، وسجل الطوارئ.
 */
export function isExpectedBackupEntry(rel: string): boolean {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return false;
  // الأنماط نفسها التي يبني بها createEncryptedSystemBackup المفاتيح (نسبية إلى rootDir، فقد تسبقها مجلدات)
  return (
    rel === CONFIG_ENTRY ||
    rel === SETTINGS_ENTRY ||
    /^Obsidian-Vault\/.+/.test(rel) ||
    /(^|\/)data\/ai-memory-store\.json$/.test(rel) ||
    /(^|\/)encrypted-vault\/[^/]+\.json$/.test(rel) ||
    /(^|\/)vault\.aes256\.json$/.test(rel) ||
    /(^|\/)data\/conversations\/[a-z0-9-]{8,64}\.enc\.json$/.test(rel) ||
    /(^|\/)data\/family-log\/flog-[0-9]{13}-[a-f0-9]{8}\.enc\.json$/.test(rel) ||
    /(^|\/)data\/knowledge\/(nodes\/K-[A-Za-z0-9-]{1,160}|edges\/E-[a-f0-9]{24}|review\/R-[A-Za-z0-9-]{1,160})\.enc\.json$/.test(rel)
  );
}

/**
 * Hint بالعربي: دالة إنشاء نسخة احتياطية مشفرة كاملة من الخزنة المفتوحة.
 *               تشمل: Obsidian-Vault، ملف الخزنة، الإعدادات، والذاكرة المشتركة، والمحادثات المشفّرة.
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
  // ISS-020: المحادثات المشفّرة (بمفتاح الخزنة نفسه) جزء من النسخة، فتُستعاد على جهاز جديد أيضاً
  const conversationsDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'conversations');
  if (fs.existsSync(conversationsDir)) {
    for (const name of fs.readdirSync(conversationsDir)) {
      if (/^[a-z0-9-]{8,64}\.enc\.json$/.test(name)) addFile(path.join(conversationsDir, name));
    }
  }
  // 4.0.0: المعرفة (مختومة بمفتاح المعرفة المشتقّ من مفتاح البيانات، فتُفتح بكلمة المرور عند الاستعادة).
  // في الحمولة الكاملة وحدها، لا العائلية.
  for (const f of listKnowledgeFiles(path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'knowledge'))) addFile(f.file);
  // 3.1.0: سجل خطوات الطوارئ
  const familyLogDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'family-log');
  if (fs.existsSync(familyLogDir)) {
    for (const name of fs.readdirSync(familyLogDir)) {
      if (/^flog-[0-9]{13}-[a-f0-9]{8}\.enc\.json$/.test(name)) addFile(path.join(familyLogDir, name));
    }
  }

  if (!hasMainDataKey(vault)) throw new Error('النسخة الاحتياطية الكاملة تحتاج فتح الخزنة بكلمة المرور الرئيسية.');
  const createdAt = formatTimestampIso();
  const snapshot: FullSystemSnapshot = { createdAt, appName: config.appName, filesCount: Object.keys(filesMap).length, filesMap };
  const vaultFile = readVaultFile(vault.vaultFilePath);
  let backup: EncryptedBackupFileV2 | EncryptedBackupFileV3;
  if (isFamilyVaultFile(vaultFile)) {
    // 3.0.0: الحمولة العائلية: ما تحتاجه العائلة فقط، مختوماً بالمفتاح العائلي
    const familyKey = resolveFamilyKey(vault, vaultFile)!;
    const familyMap: Record<string, string> = {};
    for (const [rel, b64] of Object.entries(filesMap)) {
      if (isFamilyBackupEntry(rel)) familyMap[rel] = b64;
      else if (/(^|\/)data\/conversations\/[a-z0-9-]{8,64}\.enc\.json$/.test(rel)) {
        try {
          const conv = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { mode?: string; keyScope?: string };
          if (conv.mode === 'family' && conv.keyScope === 'family') familyMap[rel] = b64;
        } catch {
          // ملف تالف: لا يدخل الحمولة العائلية
        }
      }
    }
    const familySnapshot: FullSystemSnapshot = { createdAt, appName: config.appName, filesCount: Object.keys(familyMap).length, filesMap: familyMap, scope: 'family' };
    backup = {
      format: 'second-brain-backup',
      version: 3,
      createdAt,
      filesCount: snapshot.filesCount,
      vaultKeys: { commanderWrap: vaultFile.commanderWrap },
      payload: sealWithKey(JSON.stringify(snapshot), vault.dataKey),
      family: { fkByEmergency: vaultFile.family.fkByEmergency, filesCount: familySnapshot.filesCount, payload: sealWithKey(JSON.stringify(familySnapshot), familyKey) },
    };
  } else {
    backup = {
      format: 'second-brain-backup',
      version: 2,
      createdAt,
      filesCount: snapshot.filesCount,
      vaultKeys: { commanderWrap: vaultFile.commanderWrap, emergencyWrap: vaultFile.emergencyWrap },
      payload: sealWithKey(JSON.stringify(snapshot), vault.dataKey),
    };
  }

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
 *               الصيغة 3: كلمة المرور تفتح الحمولة الكاملة، ومفتاح الطوارئ يفتح الحمولة العائلية وحدها (scope = family).
 */
export function openEncryptedBackup(backupFilePath: string, passwordOrEmergencyKey: string): FullSystemSnapshot {
  if (!backupFilePath.endsWith(BACKUP_SUFFIX)) {
    throw new Error(`ملف النسخة الاحتياطية يجب أن ينتهي بـ ${BACKUP_SUFFIX}`);
  }
  const backup = readJsonFileSafe<Partial<EncryptedBackupFileV2> | Partial<EncryptedBackupFileV3> | null>(backupFilePath, null);
  if (!backup) throw new Error(`ملف النسخة الاحتياطية غير موجود أو تالف: ${backupFilePath}`);
  if (backup.format !== 'second-brain-backup' || (backup.version !== 2 && backup.version !== 3) || !backup.vaultKeys || !backup.payload) {
    throw new Error('صيغة النسخة الاحتياطية قديمة أو غير معروفة.');
  }
  if (backup.version === 3) {
    const v3 = backup as EncryptedBackupFileV3;
    if (!v3.family) throw new Error('صيغة النسخة الاحتياطية (3) ناقصة: لا حمولة عائلية.');
    // كلمة المرور ← الحمولة الكاملة، ومفتاح الطوارئ ← الحمولة العائلية وحدها
    const attempts: Array<() => { key: Buffer; scope: 'full' | 'family' }> = [
      () => ({ key: unwrapDataKey(v3.vaultKeys.commanderWrap, passwordOrEmergencyKey), scope: 'full' }),
    ];
    if (isValidEmergencyKey(passwordOrEmergencyKey)) attempts.unshift(() => ({ key: unwrapDataKey(v3.family.fkByEmergency, normalizeEmergencyKey(passwordOrEmergencyKey)), scope: 'family' }));
    for (const attempt of attempts) {
      let opened: { key: Buffer; scope: 'full' | 'family' };
      try {
        opened = attempt();
      } catch {
        continue;
      }
      try {
        const snapshot = JSON.parse(openWithKey(opened.scope === 'full' ? v3.payload : v3.family.payload, opened.key).toString('utf-8')) as FullSystemSnapshot;
        return { ...snapshot, scope: opened.scope };
      } finally {
        opened.key.fill(0);
      }
    }
    throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
  }
  const opened = openVaultKeys(backup.vaultKeys as VaultKeyEnvelopes, passwordOrEmergencyKey);
  const dataKey = opened.dataKey!;
  try {
    return { ...(JSON.parse(openWithKey(backup.payload, dataKey).toString('utf-8')) as FullSystemSnapshot), scope: 'full' };
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
    // 3.9.9 (ISS-052): لا يُكتب إلا ما يصنعه البرنامج نفسه في النسخ (createEncryptedSystemBackup)
    if (!isExpectedBackupEntry(rel)) {
      throw new Error(`ملف خارج هيكل نسخ Second Brain داخل النسخة: ${rel.slice(0, 120)}. النسخة مرفوضة كاملة.`);
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
