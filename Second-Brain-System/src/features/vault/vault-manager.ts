/**
 * ============================================================================
 * الملف: src/features/vault/vault-manager.ts
 * القسم: Features -> Vault (ميزة الخزنة السرية المزدوجة)
 * Hint بالعربي: يدير هذا الملف خزنة الأسرار المشفرة (إيميلات، باسووردات، 2FA، وملفات حساسة).
 *               يتميز بآلية "المغلف المزدوج" (Dual-Key Envelope): يمكن فتح الخزنة إما بكلمة
 *               المرور الرئيسية الخاصة بك، أو بمفتاح الطوارئ المطبوع لزوجتك عند الحاجة!
 * ============================================================================
 */

import * as fs from 'node:fs';
import type { EncryptedPayload, VaultSecretItem } from '../../shared/types.ts';
import { formatTimestampIso, readJsonFileSafe, writeJsonFileSafe } from '../../shared/file-helpers.ts';
import { decryptWithAes256Gcm, encryptWithAes256Gcm, generateEmergencyRecoveryKey } from '../../core/crypto-engine.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: هيكل ملف الخزنة المحفوظ على القرص الصلب؛ يحتوي على مغلفين مشفرين
 * لنفس البيانات حتى تتمكن أنت أو زوجتك (بمفتاح الطوارئ) من فك التشفير بأمان.
 */
export interface DualEnvelopeVaultFile {
  version: string;
  commanderEnvelope: EncryptedPayload;
  wifeEmergencyEnvelope: EncryptedPayload;
  updatedAt: string;
}

/**
 * Hint بالعربي: دالة لتهيئة الخزنة لأول مرة (أو إعادة تشفيرها) بكلمة المرور الرئيسية
 * مع توليد مفتاح طوارئ عائلي خاص بالزوجة وإرجاعه ليتم حفظه في كتيب الطوارئ.
 */
export function initializeEncryptedVault(
  masterPassword: string,
  initialSecrets: VaultSecretItem[] = [],
  customEmergencyKey?: string,
  customVaultFilePath?: string
): { emergencyRecoveryKey: string; vaultFilePath: string } {
  const config = loadSystemConfig();
  const vaultFilePath = customVaultFilePath ?? config.paths.encryptedVaultFile;
  const emergencyRecoveryKey = customEmergencyKey ?? generateEmergencyRecoveryKey();

  const serializedSecrets = JSON.stringify(initialSecrets);
  const commanderEnvelope = encryptWithAes256Gcm(serializedSecrets, masterPassword);
  const wifeEmergencyEnvelope = encryptWithAes256Gcm(serializedSecrets, emergencyRecoveryKey);

  const vaultFile: DualEnvelopeVaultFile = {
    version: '1.0.0',
    commanderEnvelope,
    wifeEmergencyEnvelope,
    updatedAt: formatTimestampIso(),
  };

  writeJsonFileSafe(vaultFilePath, vaultFile);
  logSystemInfo('VaultManager', `تم تهيئة الخزنة المشفرة بنجاح في المسار: ${vaultFilePath}`);

  return { emergencyRecoveryKey, vaultFilePath };
}

/**
 * Hint بالعربي: دالة لفتح الخزنة وقراءة جميع الأسرار باستخدام كلمة المرور الرئيسية أو مفتاح الطوارئ للزوجة.
 */
export function unlockAndReadVault(
  passwordOrEmergencyKey: string,
  customVaultFilePath?: string
): { unlockedBy: 'commander' | 'wife_emergency'; secrets: VaultSecretItem[] } {
  const config = loadSystemConfig();
  const vaultFilePath = customVaultFilePath ?? config.paths.encryptedVaultFile;

  const vaultFile = readJsonFileSafe<DualEnvelopeVaultFile | null>(vaultFilePath, null);
  if (!vaultFile) {
    throw new Error('ملف الخزنة المشفرة غير موجود بعد. يرجى تهيئة الخزنة أولاً.');
  }

  // محاولة الفتح بمغلف القائد أولاً
  try {
    const plainJson = decryptWithAes256Gcm(vaultFile.commanderEnvelope, passwordOrEmergencyKey);
    const secrets = JSON.parse(plainJson) as VaultSecretItem[];
    return { unlockedBy: 'commander', secrets };
  } catch {
    // إذا لم تكن كلمة مرور القائد، نجرب مفتاح الطوارئ الخاص بالزوجة
    try {
      const plainJson = decryptWithAes256Gcm(vaultFile.wifeEmergencyEnvelope, passwordOrEmergencyKey);
      const secrets = JSON.parse(plainJson) as VaultSecretItem[];
      return { unlockedBy: 'wife_emergency', secrets };
    } catch (err) {
      logSystemError('VaultManager', 'محاولة فاشلة لفتح الخزنة المشفرة بكلمة مرور غير صحيحة', err);
      throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
    }
  }
}

/**
 * Hint بالعربي: دالة لإضافة أو تحديث سر جديد داخل الخزنة (إيميل، باسوورد، مفتاح API، أو ملف حساس)
 * مع إعادة تشفير مغلف القائد ومغلف الطوارئ معاً.
 */
export function upsertVaultSecret(
  item: VaultSecretItem,
  masterPassword: string,
  emergencyRecoveryKey: string,
  customVaultFilePath?: string
): VaultSecretItem[] {
  const config = loadSystemConfig();
  const vaultFilePath = customVaultFilePath ?? config.paths.encryptedVaultFile;

  let currentSecrets: VaultSecretItem[] = [];
  if (fs.existsSync(vaultFilePath)) {
    const unlocked = unlockAndReadVault(masterPassword, vaultFilePath);
    currentSecrets = unlocked.secrets;
  }

  const existingIdx = currentSecrets.findIndex((s) => s.id === item.id);
  const updatedItem: VaultSecretItem = {
    ...item,
    updatedAt: formatTimestampIso(),
  };

  if (existingIdx >= 0) {
    currentSecrets[existingIdx] = updatedItem;
  } else {
    currentSecrets.push(updatedItem);
  }

  initializeEncryptedVault(masterPassword, currentSecrets, emergencyRecoveryKey, vaultFilePath);
  logSystemInfo('VaultManager', `تم حفظ وتشفير العنصر السري بنجاح: ${item.title}`);
  return currentSecrets;
}

/**
 * Hint بالعربي: دالة لتأمين وحفظ محتوى ملف حساس من مشاريعك (مثل .env أو keystore) داخل الخزنة المشفرة
 * بحيث لا يضيع أبداً ويمكن استرجاعه في أي وقت.
 */
export function backupCriticalFileToVault(
  projectId: string,
  filePath: string,
  reasonAr: string,
  masterPassword: string,
  emergencyRecoveryKey: string,
  customVaultFilePath?: string
): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`الملف الحساس المطلوب تأمينه غير موجود: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const base64Content = fileBuffer.toString('base64');
  const secretId = `FILE-${projectId}-${Buffer.from(filePath).toString('hex').slice(-10).toUpperCase()}`;

  const item: VaultSecretItem = {
    id: secretId,
    category: 'critical_file',
    title: `ملف حساس مؤمّن: ${filePath.split(/[\\/]/).pop()}`,
    projectId,
    secretValue: base64Content,
    originalFilePath: filePath,
    notesForCommanderAr: `نسخة مشفرة (Base64) من الملف الحساس (${reasonAr}) في المسار: ${filePath}`,
    notesForWifeAr: `هذا ملف تقني سري خاص بمشروع (${projectId}). إذا طلب مبرمج استعادة إعدادات المشروع، يمكن استرجاعه بضغطة زر من البرنامج.`,
    updatedAt: formatTimestampIso(),
  };

  upsertVaultSecret(item, masterPassword, emergencyRecoveryKey, customVaultFilePath);
  return secretId;
}

/**
 * Hint بالعربي: دالة لاسترجاع ملف حساس من داخل الخزنة المشفرة وإعادته إلى مساره الأصلي (أو مسار مخصص).
 */
export function restoreCriticalFileFromVault(
  secretId: string,
  passwordOrEmergencyKey: string,
  targetOutputPath?: string,
  customVaultFilePath?: string
): string {
  const { secrets } = unlockAndReadVault(passwordOrEmergencyKey, customVaultFilePath);
  const found = secrets.find((s) => s.id === secretId && s.category === 'critical_file');
  if (!found) {
    throw new Error(`لم يتم العثور على الملف السري بالمعرف: ${secretId}`);
  }

  const destination = targetOutputPath ?? found.originalFilePath;
  if (!destination) {
    throw new Error('لا يوجد مسار استرجاع محدد لهذا الملف السري.');
  }

  const fileBuffer = Buffer.from(found.secretValue, 'base64');
  fs.mkdirSync(destination.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  fs.writeFileSync(destination, fileBuffer);
  logSystemInfo('VaultManager', `تم استرجاع الملف الحساس بنجاح إلى المسار: ${destination}`);
  return destination;
}
