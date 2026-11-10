/**
 * ============================================================================
 * الملف: src/features/family-emergency/backup-service.ts
 * القسم: Features -> Family Emergency (ميزة النسخ الاحتياطي المشفر الشامل)
 * Hint بالعربي: يقوم هذا الملف بجمع كافة ملفات Obsidian-Vault والخزنة المشفرة والإعدادات
 *               في حزمة واحدة مشفرة بـ AES-256-GCM جاهزة للنسخ على سحابة خاصة (Google Drive)
 *               أو فلاشة طوارئ (USB) لضمان عدم ضياع أي شيء لو تعطل الحاسوب الشخصي.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EncryptedPayload } from '../../shared/types.ts';
import {
  ensureDirectoryExists,
  formatTimestampIso,
  listFilesRecursive,
  readJsonFileSafe,
  writeJsonFileSafe,
} from '../../shared/file-helpers.ts';
import { decryptWithAes256Gcm, encryptWithAes256Gcm } from '../../core/crypto-engine.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: هيكل حزمة النسخة الاحتياطية الكاملة قبل التشفير.
 */
export interface FullSystemSnapshot {
  createdAt: string;
  appName: string;
  filesCount: number;
  filesMap: Record<string, string>; // مسار نسبي -> محتوى بترميز Base64
}

/**
 * Hint بالعربي: دالة لإنشاء نسخة احتياطية مشفرة بالكامل (Zero-Knowledge Encrypted Backup)
 * تشمل جميع ملفات Obsidian-Vault والخزنة المشفرة.
 */
export function createEncryptedSystemBackup(
  passwordOrEmergencyKey: string,
  customOutputDir?: string
): { backupFilePath: string; filesIncluded: number } {
  const config = loadSystemConfig();
  const outDir = customOutputDir ?? config.paths.encryptedBackupsDir;
  ensureDirectoryExists(outDir);

  const filesMap: Record<string, string> = {};
  const obsidianFiles = listFilesRecursive(config.paths.obsidianVaultDir);

  for (const filePath of obsidianFiles) {
    const relPath = path.relative(config.paths.rootDir, filePath);
    filesMap[relPath] = fs.readFileSync(filePath).toString('base64');
  }

  if (fs.existsSync(config.paths.encryptedVaultFile)) {
    const vaultRel = path.relative(config.paths.rootDir, config.paths.encryptedVaultFile);
    filesMap[vaultRel] = fs.readFileSync(config.paths.encryptedVaultFile).toString('base64');
  }

  const snapshot: FullSystemSnapshot = {
    createdAt: formatTimestampIso(),
    appName: config.appName,
    filesCount: Object.keys(filesMap).length,
    filesMap,
  };

  const encryptedPayload = encryptWithAes256Gcm(JSON.stringify(snapshot), passwordOrEmergencyKey);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFilePath = path.join(outDir, `Second-Brain-Backup-${stamp}.enc.json`);

  writeJsonFileSafe(backupFilePath, encryptedPayload);
  logSystemInfo('BackupService', `تم إنشاء نسخة احتياطية مشفرة تشمل (${snapshot.filesCount}) ملف في: ${backupFilePath}`);

  return { backupFilePath, filesIncluded: snapshot.filesCount };
}

/**
 * Hint بالعربي: دالة لفك تشفير النسخة الاحتياطية والتحقق من سلامة كافة الملفات المحفوظة بداخلها.
 */
export function verifyAndReadEncryptedBackup(
  backupFilePath: string,
  passwordOrEmergencyKey: string
): FullSystemSnapshot {
  const payload = readJsonFileSafe<EncryptedPayload | null>(backupFilePath, null);
  if (!payload) {
    throw new Error(`ملف النسخة الاحتياطية غير موجود أو تالف: ${backupFilePath}`);
  }

  const plainJson = decryptWithAes256Gcm(payload, passwordOrEmergencyKey);
  return JSON.parse(plainJson) as FullSystemSnapshot;
}
