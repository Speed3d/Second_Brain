/**
 * ============================================================================
 * الملف: src/features/vault/vault-manager.ts
 * القسم: Features -> Vault (ميزة الخزنة السرية — الصيغة الثانية v2)
 * Hint بالعربي: يدير هذا الملف خزنة الأسرار المشفرة (إيميلات، باسووردات، 2FA، وملفات حساسة).
 *               التصميم:
 *               - الأسرار تُشفَّر مرة واحدة بمفتاح بيانات عشوائي (DEK).
 *               - مفتاح البيانات نفسه مغلَّف مرتين: بكلمة المرور الرئيسية، وبمفتاح الطوارئ للزوجة.
 *               - لذلك: الحفظ لا يحتاج مفتاح الطوارئ، والمفتاح المطبوع لا يتغير أبداً إلا بطلب صريح.
 *               - كل حفظ ذرّي مع الاحتفاظ بآخر 5 نسخ سابقة من ملف الخزنة.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SealedData, VaultSecretItem, WrappedKey } from '../../shared/types.ts';
import { formatTimestampIso, readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';
import {
  generateDataKey,
  generateEmergencyRecoveryKey,
  isValidEmergencyKey,
  normalizeEmergencyKey,
  openWithKey,
  sealWithKey,
  unwrapDataKey,
  wrapDataKey,
} from '../../core/crypto-engine.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';

/** أقل طول مسموح لكلمة المرور الرئيسية */
export const MIN_MASTER_PASSWORD_LENGTH = 10;
/** عدد النسخ السابقة المحفوظة من ملف الخزنة */
const VAULT_FILE_BACKUPS = 5;
/** عدد النسخ التاريخية المحفوظة لكل ملف حساس */
const MAX_FILE_VERSIONS = 5;
/** أكبر حجم لملف حساس يُحفظ داخل الخزنة */
export const MAX_CRITICAL_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Hint بالعربي: مفاتيح الخزنة المغلَّفة (مغلف القائد + مغلف الطوارئ للزوجة).
 */
export interface VaultKeyEnvelopes {
  commanderWrap: WrappedKey;
  emergencyWrap: WrappedKey;
}

/**
 * Hint بالعربي: هيكل ملف الخزنة v2 المحفوظ على القرص.
 */
export interface VaultFileV2 extends VaultKeyEnvelopes {
  format: 'second-brain-vault';
  version: 2;
  data: SealedData;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hint بالعربي: خزنة مفتوحة في الذاكرة: مفتاح البيانات + الأسرار + من فتحها. لا تُحفظ على القرص أبداً.
 */
export interface UnlockedVault {
  vaultFilePath: string;
  dataKey: Buffer;
  unlockedBy: 'commander' | 'wife_emergency';
  secrets: VaultSecretItem[];
}

/**
 * Hint بالعربي: دالة تحديد مسار ملف الخزنة (المخصص أو الافتراضي من الإعدادات).
 */
export function resolveVaultFilePath(customVaultFilePath?: string): string {
  return customVaultFilePath ?? loadSystemConfig().paths.encryptedVaultFile;
}

/**
 * Hint بالعربي: دالة للتحقق من وجود خزنة مُنشأة مسبقاً.
 */
export function vaultExists(customVaultFilePath?: string): boolean {
  return fs.existsSync(resolveVaultFilePath(customVaultFilePath));
}

/**
 * Hint بالعربي: دالة إنشاء الخزنة لأول مرة فقط. ترفض العمل إذا كانت الخزنة موجودة (حتى لا تُمسح أبداً).
 *               المخرجات: مفتاح الطوارئ (يُعرض مرة واحدة ليُطبع) والخزنة مفتوحة.
 */
export function createVault(
  masterPassword: string,
  customVaultFilePath?: string
): { emergencyRecoveryKey: string; vault: UnlockedVault } {
  const vaultFilePath = resolveVaultFilePath(customVaultFilePath);
  if (fs.existsSync(vaultFilePath)) {
    throw new Error('الخزنة موجودة بالفعل. لا يمكن إنشاؤها من جديد حتى لا تُمسح أسرارك.');
  }
  assertStrongMasterPassword(masterPassword);

  const emergencyRecoveryKey = generateEmergencyRecoveryKey();
  const dataKey = generateDataKey();
  const now = formatTimestampIso();
  const file: VaultFileV2 = {
    format: 'second-brain-vault',
    version: 2,
    commanderWrap: wrapDataKey(dataKey, masterPassword),
    emergencyWrap: wrapDataKey(dataKey, emergencyRecoveryKey),
    data: sealWithKey(JSON.stringify([]), dataKey),
    createdAt: now,
    updatedAt: now,
  };
  writeFileAtomic(vaultFilePath, JSON.stringify(file, null, 2));
  logSystemInfo('VaultManager', `تم إنشاء خزنة جديدة (v2) في المسار: ${vaultFilePath}`);

  return { emergencyRecoveryKey, vault: { vaultFilePath, dataKey, unlockedBy: 'commander', secrets: [] } };
}

/**
 * Hint بالعربي: دالة التحقق من قوة كلمة المرور الرئيسية (الطول الأدنى).
 */
export function assertStrongMasterPassword(masterPassword: string): void {
  if (typeof masterPassword !== 'string' || masterPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(`كلمة المرور الرئيسية يجب ألا تقل عن ${MIN_MASTER_PASSWORD_LENGTH} أحرف.`);
  }
}

/**
 * Hint بالعربي: دالة قراءة ملف الخزنة v2 من القرص والتحقق من صيغته.
 */
export function readVaultFile(vaultFilePath: string): VaultFileV2 {
  const file = readJsonFileSafe<Partial<VaultFileV2> | null>(vaultFilePath, null);
  if (!file) {
    throw new Error('ملف الخزنة المشفرة غير موجود بعد. يرجى إنشاء الخزنة أولاً.');
  }
  if (file.format !== 'second-brain-vault' || file.version !== 2) {
    throw new Error('صيغة ملف الخزنة قديمة أو غير معروفة.');
  }
  return file as VaultFileV2;
}

/**
 * Hint بالعربي: دالة فك تغليف مفتاح البيانات من المغلفين بكلمة المرور أو مفتاح الطوارئ.
 *               إذا كان المُدخل بشكل مفتاح طوارئ صحيح نجرب مغلف الطوارئ أولاً (أسرع).
 */
export function unwrapVaultDataKey(
  envelopes: VaultKeyEnvelopes,
  passwordOrEmergencyKey: string
): { dataKey: Buffer; unlockedBy: 'commander' | 'wife_emergency' } {
  const attempts: Array<{ by: 'commander' | 'wife_emergency'; wrap: WrappedKey; secret: string }> = [];
  const looksLikeEmergencyKey = isValidEmergencyKey(passwordOrEmergencyKey);
  const emergencyAttempt = {
    by: 'wife_emergency' as const,
    wrap: envelopes.emergencyWrap,
    secret: normalizeEmergencyKey(passwordOrEmergencyKey),
  };
  const commanderAttempt = { by: 'commander' as const, wrap: envelopes.commanderWrap, secret: passwordOrEmergencyKey };
  if (looksLikeEmergencyKey) attempts.push(emergencyAttempt, commanderAttempt);
  else attempts.push(commanderAttempt);

  for (const attempt of attempts) {
    try {
      return { dataKey: unwrapDataKey(attempt.wrap, attempt.secret), unlockedBy: attempt.by };
    } catch {
      // نجرب المغلف التالي
    }
  }
  throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
}

/**
 * Hint بالعربي: دالة فتح الخزنة وقراءة جميع الأسرار بكلمة المرور الرئيسية أو بمفتاح الطوارئ للزوجة.
 */
export function unlockVault(passwordOrEmergencyKey: string, customVaultFilePath?: string): UnlockedVault {
  const vaultFilePath = resolveVaultFilePath(customVaultFilePath);
  const file = readVaultFile(vaultFilePath);
  try {
    const { dataKey, unlockedBy } = unwrapVaultDataKey(file, passwordOrEmergencyKey);
    const secrets = JSON.parse(openWithKey(file.data, dataKey).toString('utf-8')) as VaultSecretItem[];
    return { vaultFilePath, dataKey, unlockedBy, secrets };
  } catch (err) {
    logSystemError('VaultManager', 'محاولة فاشلة لفتح الخزنة المشفرة', err);
    throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
  }
}

/**
 * Hint بالعربي: دالة حفظ الأسرار الحالية للخزنة المفتوحة (إعادة تشفير البيانات بنفس المفتاح وحفظ ذرّي).
 *               المغلفان لا يتغيران، لذلك يبقى مفتاح الطوارئ المطبوع صالحاً دائماً.
 */
export function persistVault(vault: UnlockedVault): void {
  const file = readVaultFile(vault.vaultFilePath);
  const updated: VaultFileV2 = {
    ...file,
    data: sealWithKey(JSON.stringify(vault.secrets), vault.dataKey),
    updatedAt: formatTimestampIso(),
  };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(updated, null, 2), VAULT_FILE_BACKUPS);
}

/**
 * Hint بالعربي: دالة إضافة أو تعديل سر داخل الخزنة المفتوحة ثم حفظها فوراً.
 */
export function upsertVaultSecret(vault: UnlockedVault, item: Omit<VaultSecretItem, 'updatedAt'> & { updatedAt?: string }): VaultSecretItem {
  const now = formatTimestampIso();
  const existingIdx = vault.secrets.findIndex((s) => s.id === item.id);
  const saved: VaultSecretItem = {
    ...item,
    createdAt: existingIdx >= 0 ? vault.secrets[existingIdx].createdAt ?? item.createdAt ?? now : item.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIdx >= 0) vault.secrets[existingIdx] = saved;
  else vault.secrets.push(saved);
  persistVault(vault);
  logSystemInfo('VaultManager', `تم حفظ وتشفير العنصر السري: ${item.title}`);
  return saved;
}

/**
 * Hint بالعربي: دالة حذف سر من الخزنة المفتوحة. المخرجات: true إذا وُجد وحُذف.
 */
export function deleteVaultSecret(vault: UnlockedVault, secretId: string): boolean {
  const before = vault.secrets.length;
  vault.secrets = vault.secrets.filter((s) => s.id !== secretId);
  if (vault.secrets.length === before) return false;
  persistVault(vault);
  logSystemInfo('VaultManager', `تم حذف العنصر السري: ${secretId}`);
  return true;
}

/**
 * Hint بالعربي: دالة تغيير كلمة المرور الرئيسية: تعيد تغليف مفتاح البيانات فقط،
 *               ولا تلمس مغلف الطوارئ (مفتاح الزوجة المطبوع يبقى صالحاً).
 */
export function changeMasterPassword(vault: UnlockedVault, currentPassword: string, newPassword: string): void {
  const file = readVaultFile(vault.vaultFilePath);
  try {
    unwrapDataKey(file.commanderWrap, currentPassword);
  } catch {
    throw new Error('كلمة المرور الحالية غير صحيحة.');
  }
  assertStrongMasterPassword(newPassword);
  const updated: VaultFileV2 = { ...file, commanderWrap: wrapDataKey(vault.dataKey, newPassword), updatedAt: formatTimestampIso() };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(updated, null, 2), VAULT_FILE_BACKUPS);
  logSystemInfo('VaultManager', 'تم تغيير كلمة المرور الرئيسية للخزنة.');
}

/**
 * Hint بالعربي: دالة تدوير مفتاح الطوارئ (عند فقدان الوثيقة المطبوعة مثلاً): تولّد مفتاحاً جديداً
 *               وتُبطل القديم. تتطلب كلمة المرور الرئيسية. المخرجات: المفتاح الجديد (يُطبع فوراً).
 */
export function rotateEmergencyKey(vault: UnlockedVault, masterPassword: string): string {
  const file = readVaultFile(vault.vaultFilePath);
  try {
    unwrapDataKey(file.commanderWrap, masterPassword);
  } catch {
    throw new Error('كلمة المرور الرئيسية غير صحيحة.');
  }
  const newKey = generateEmergencyRecoveryKey();
  const updated: VaultFileV2 = { ...file, emergencyWrap: wrapDataKey(vault.dataKey, newKey), updatedAt: formatTimestampIso() };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(updated, null, 2), VAULT_FILE_BACKUPS);
  logSystemInfo('VaultManager', 'تم تدوير مفتاح الطوارئ العائلي وإبطال المفتاح السابق.');
  return newKey;
}

/**
 * Hint بالعربي: دالة التحقق من كلمة المرور الرئيسية فقط (مفتاح الطوارئ لا يُقبل هنا).
 */
export function verifyMasterPassword(masterPassword: string, customVaultFilePath?: string): boolean {
  const file = readVaultFile(resolveVaultFilePath(customVaultFilePath));
  try {
    unwrapDataKey(file.commanderWrap, masterPassword).fill(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hint بالعربي: دالة التحقق من أن مفتاح طوارئ معيّن يفتح هذه الخزنة فعلاً (قبل طباعته في الكتيب).
 */
export function verifyEmergencyKey(emergencyKey: string, customVaultFilePath?: string): boolean {
  if (!isValidEmergencyKey(emergencyKey)) return false;
  const file = readVaultFile(resolveVaultFilePath(customVaultFilePath));
  try {
    unwrapDataKey(file.emergencyWrap, normalizeEmergencyKey(emergencyKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hint بالعربي: دالة تأمين ملف حساس (مثل .env أو keystore) داخل الخزنة المفتوحة مع نسخ تاريخية:
 *               إذا لم يتغير محتوى الملف لا يُحفظ شيء جديد، وإذا تغيّر تُحفظ النسخة السابقة (آخر 5).
 *               المخرجات: معرّف السر، وهل تغيّر الملف.
 */
export function backupCriticalFileToVault(
  vault: UnlockedVault,
  projectId: string,
  filePath: string,
  reasonAr: string
): { secretId: string; changed: boolean } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`الملف الحساس المطلوب تأمينه غير موجود: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_CRITICAL_FILE_BYTES) {
    throw new Error(`الملف أكبر من الحد المسموح للتأمين (${MAX_CRITICAL_FILE_BYTES} بايت): ${filePath}`);
  }

  const content = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const pathHash = crypto.createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 12).toUpperCase();
  const secretId = `FILE-${projectId}-${pathHash}`;
  const existing = vault.secrets.find((s) => s.id === secretId);

  if (existing && existing.contentSha256 === sha256) {
    return { secretId, changed: false };
  }

  const previousVersions = existing?.fileVersions ?? [];
  const fileVersions =
    existing && existing.contentSha256
      ? [{ sha256: existing.contentSha256, savedAt: existing.updatedAt, contentBase64: existing.secretValue }, ...previousVersions].slice(
          0,
          MAX_FILE_VERSIONS
        )
      : previousVersions;

  upsertVaultSecret(vault, {
    id: secretId,
    category: 'critical_file',
    title: `ملف حساس مؤمّن: ${path.basename(filePath)}`,
    projectId,
    secretValue: content.toString('base64'),
    contentSha256: sha256,
    fileVersions,
    originalFilePath: filePath,
    notesForCommanderAr: `نسخة مشفرة من الملف الحساس (${reasonAr}).`,
    notesForWifeAr: `هذا ملف تقني سري خاص بمشروع (${projectId}). إذا طلب مبرمج استعادة إعدادات المشروع، يمكن استرجاعه من البرنامج.`,
    createdAt: existing?.createdAt,
  });
  return { secretId, changed: true };
}

/**
 * Hint بالعربي: دالة استرجاع ملف حساس من الخزنة المفتوحة إلى مسار محدد.
 *               لا تكتب فوق ملف موجود إلا إذا طُلب ذلك صراحة (overwrite = true).
 */
export function restoreCriticalFileFromVault(
  vault: UnlockedVault,
  secretId: string,
  targetOutputPath?: string,
  overwrite: boolean = false
): string {
  const found = vault.secrets.find((s) => s.id === secretId && s.category === 'critical_file');
  if (!found) {
    throw new Error(`لم يتم العثور على الملف السري بالمعرف: ${secretId}`);
  }
  const destination = targetOutputPath ?? found.originalFilePath;
  if (!destination) {
    throw new Error('لا يوجد مسار استرجاع محدد لهذا الملف السري.');
  }
  if (fs.existsSync(destination) && !overwrite) {
    throw new Error(`يوجد ملف في المسار بالفعل، ولن تتم الكتابة فوقه: ${destination}`);
  }
  writeFileAtomic(destination, Buffer.from(found.secretValue, 'base64'));
  logSystemInfo('VaultManager', `تم استرجاع الملف الحساس بنجاح إلى المسار: ${destination}`);
  return destination;
}

/**
 * Hint بالعربي: دالة مسح مفتاح البيانات من الذاكرة عند قفل الخزنة.
 */
export function wipeUnlockedVault(vault: UnlockedVault): void {
  vault.dataKey.fill(0);
  vault.secrets = [];
}
