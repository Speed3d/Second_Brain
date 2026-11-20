/**
 * ============================================================================
 * الملف: src/features/vault/vault-manager.ts
 * القسم: Features -> Vault (ميزة الخزنة السرية — الصيغة الثالثة v3 مع الخزنة العائلية)
 * Hint بالعربي: يدير هذا الملف خزنة الأسرار المشفرة (إيميلات، باسووردات، 2FA، وملفات حساسة).
 *               التصميم (v3، الإصدار 3.0.0):
 *               - أسرار القائد تُشفَّر بمفتاح بيانات عشوائي (DEK)، ملفوف بكلمة المرور الرئيسية فقط.
 *               - الخزنة العائلية: الأسرار المعلَّمة «يظهر للعائلة» تُنسخ تلقائياً عند كل حفظ إلى قسم مستقل
 *                 مشفّر بمفتاح عائلي (FK). المفتاح العائلي مختوم بـ DEK (فيفتحه القائد)، وملفوف بمفتاح الطوارئ.
 *               - مفتاح الطوارئ المطبوع يفتح الخزنة العائلية وحدها، ولا يصل إلى DEK أبداً.
 *               - الصيغة v2 (مفتاح الطوارئ يفتح DEK) تُقرأ حتى يرقّيها القائد بنفسه (migrateVaultToFamilyV3).
 *               - كل حفظ ذرّي مع الاحتفاظ بآخر 5 نسخ سابقة من ملف الخزنة.
 * ============================================================================
 */

import { AR_COUNT, countAr } from '../../shared/arabic-count.ts';
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
 * Hint بالعربي: مفاتيح الخزنة v2 المغلَّفة (مغلف القائد + مغلف الطوارئ الذي يفتح DEK نفسه).
 */
export interface VaultKeyEnvelopes {
  commanderWrap: WrappedKey;
  emergencyWrap: WrappedKey;
}

/**
 * Hint بالعربي: مفاتيح الخزنة العائلية كما تُزامَن وتُحفظ في النسخ (بلا بيانات الأسرار نفسها).
 */
export interface FamilyKeyEnvelopes {
  /** المفتاح العائلي FK مختوماً بمفتاح البيانات DEK (يفتحه القائد تلقائياً) */
  fkByCommander: SealedData;
  /** المفتاح العائلي FK ملفوفاً بمفتاح الطوارئ المطبوع */
  fkByEmergency: WrappedKey;
}

/**
 * Hint بالعربي: سجل المفاتيح كما يُزامَن (vaultkeys:main) ويُحفظ في النسخ:
 *               v2 = commanderWrap + emergencyWrap، و v3 = commanderWrap + family.
 */
export interface VaultKeysRecord {
  commanderWrap: WrappedKey;
  emergencyWrap?: WrappedKey;
  family?: FamilyKeyEnvelopes;
}

/**
 * Hint بالعربي: هيكل ملف الخزنة v2 المحفوظ على القرص (قبل الخزنة العائلية).
 */
export interface VaultFileV2 extends VaultKeyEnvelopes {
  format: 'second-brain-vault';
  version: 2;
  data: SealedData;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hint بالعربي: قسم الخزنة العائلية داخل ملف v3.
 */
export interface FamilyVaultSection extends FamilyKeyEnvelopes {
  /** الأسرار المعلَّمة للعائلة، مختومة بالمفتاح العائلي (تُبنى تلقائياً عند كل حفظ) */
  data: SealedData;
  count: number;
  migratedAt: string;
}

/**
 * Hint بالعربي: هيكل ملف الخزنة v3: بلا emergencyWrap، ومعه قسم الخزنة العائلية.
 */
export interface VaultFileV3 {
  format: 'second-brain-vault';
  version: 3;
  commanderWrap: WrappedKey;
  family: FamilyVaultSection;
  data: SealedData;
  createdAt: string;
  updatedAt: string;
}

export type VaultFile = VaultFileV2 | VaultFileV3;

/**
 * Hint بالعربي: خزنة مفتوحة في الذاكرة. لا تُحفظ على القرص أبداً.
 *               - القائد: dataKey = DEK، و familyKey = FK (أو null قبل الترقية).
 *               - العائلة (v3): dataKey فارغ (طوله 0، فأي استخدام له يفشل فوراً)، و familyKey = FK،
 *                 والأسرار هي أسرار الخزنة العائلية وحدها.
 *               - العائلة (v2 قبل الترقية): dataKey = DEK كما في الإصدارات السابقة.
 */
export interface UnlockedVault {
  vaultFilePath: string;
  dataKey: Buffer;
  familyKey?: Buffer | null;
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
 * Hint بالعربي: دالة بناء نسخة الأسرار التي تراها العائلة: المعلَّمة فقط، بلا ملاحظات القائد،
 *               وبلا الملفات الحساسة التقنية (لا تُفيد العائلة وحجمها كبير).
 */
export function buildFamilyProjection(secrets: VaultSecretItem[]): VaultSecretItem[] {
  return secrets
    .filter((s) => s.familyVisible === true && s.category !== 'critical_file')
    .map((s) => ({
      id: s.id,
      category: s.category,
      title: s.title,
      projectId: s.projectId,
      usernameOrEmail: s.usernameOrEmail,
      secretValue: s.secretValue,
      url: s.url,
      notesForCommanderAr: '',
      notesForWifeAr: s.notesForWifeAr,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      familyVisible: true,
    }));
}

function sealFamilySection(secrets: VaultSecretItem[], familyKey: Buffer): Pick<FamilyVaultSection, 'data' | 'count'> {
  const projection = buildFamilyProjection(secrets);
  return { data: sealWithKey(JSON.stringify(projection), familyKey), count: projection.length };
}

/**
 * Hint بالعربي: دالة إنشاء الخزنة لأول مرة فقط (بالصيغة v3 مباشرة). ترفض العمل إذا كانت الخزنة موجودة.
 *               المخرجات: مفتاح الطوارئ (يُعرض مرة واحدة ليُطبع، ويفتح الخزنة العائلية وحدها) والخزنة مفتوحة.
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
  const familyKey = generateDataKey();
  const now = formatTimestampIso();
  const file: VaultFileV3 = {
    format: 'second-brain-vault',
    version: 3,
    commanderWrap: wrapDataKey(dataKey, masterPassword),
    family: {
      fkByCommander: sealWithKey(familyKey, dataKey),
      fkByEmergency: wrapDataKey(familyKey, emergencyRecoveryKey),
      ...sealFamilySection([], familyKey),
      migratedAt: now,
    },
    data: sealWithKey(JSON.stringify([]), dataKey),
    createdAt: now,
    updatedAt: now,
  };
  writeFileAtomic(vaultFilePath, JSON.stringify(file, null, 2));
  logSystemInfo('VaultManager', `تم إنشاء خزنة جديدة (v3 مع الخزنة العائلية) في المسار: ${vaultFilePath}`);

  return { emergencyRecoveryKey, vault: { vaultFilePath, dataKey, familyKey, unlockedBy: 'commander', secrets: [] } };
}

/**
 * Hint بالعربي: دالة إنشاء خزنة بالصيغة القديمة v2 — للاختبارات فقط (لاختبار الترقية إلى v3).
 */
export function createLegacyV2VaultForTests(masterPassword: string, vaultFilePath: string): { emergencyRecoveryKey: string } {
  if (fs.existsSync(vaultFilePath)) throw new Error('الخزنة موجودة بالفعل.');
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
  return { emergencyRecoveryKey };
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
 * Hint بالعربي: دالة قراءة ملف الخزنة (v2 أو v3) من القرص والتحقق من صيغته.
 */
export function readVaultFile(vaultFilePath: string): VaultFile {
  const file = readJsonFileSafe<Partial<VaultFile> | null>(vaultFilePath, null);
  if (!file) {
    throw new Error('ملف الخزنة المشفرة غير موجود بعد. يرجى إنشاء الخزنة أولاً.');
  }
  if (file.format !== 'second-brain-vault' || (file.version !== 2 && file.version !== 3)) {
    throw new Error('صيغة ملف الخزنة قديمة أو غير معروفة.');
  }
  if (file.version === 3 && (!file.family || !file.family.fkByEmergency || !file.family.fkByCommander)) {
    throw new Error('ملف الخزنة (v3) ناقص: قسم الخزنة العائلية غير مكتمل.');
  }
  return file as VaultFile;
}

/**
 * Hint بالعربي: دالة استخراج سجل المفاتيح من ملف الخزنة (للمزامنة والنسخ). الترتيب ثابت،
 *               حتى تتطابق البصمة على كل الأجهزة.
 */
export function vaultKeysOf(file: VaultFile): VaultKeysRecord {
  if (file.version === 3) {
    return { commanderWrap: file.commanderWrap, family: { fkByCommander: file.family.fkByCommander, fkByEmergency: file.family.fkByEmergency } };
  }
  return { commanderWrap: file.commanderWrap, emergencyWrap: file.emergencyWrap };
}

/**
 * Hint بالعربي: دالة دمج سجلَّي مفاتيح: مغلّف القائد من الأحدث، والخزنة العائلية من أيٍّ منهما يحملها
 *               (الأحدث أولاً). وجود الخزنة العائلية يُلغي غلاف الطوارئ القديم نهائياً.
 */
export function mergeVaultKeys(newer: VaultKeysRecord, older: VaultKeysRecord | null): VaultKeysRecord {
  const family = newer.family ?? older?.family;
  if (family) return { commanderWrap: newer.commanderWrap, family: { fkByCommander: family.fkByCommander, fkByEmergency: family.fkByEmergency } };
  return { commanderWrap: newer.commanderWrap, emergencyWrap: newer.emergencyWrap ?? older?.emergencyWrap };
}

/** نتيجة فتح سجل المفاتيح */
export interface OpenedVaultKeys {
  unlockedBy: 'commander' | 'wife_emergency';
  /** DEK (للقائد، أو للطوارئ في v2 فقط) */
  dataKey: Buffer | null;
  /** FK (v3 فقط) */
  familyKey: Buffer | null;
}

/**
 * Hint بالعربي: دالة فتح سجل المفاتيح بكلمة المرور أو بمفتاح الطوارئ.
 *               - كلمة المرور ← DEK، ومعه FK إن كانت الخزنة العائلية موجودة.
 *               - مفتاح الطوارئ ← FK وحده في v3، أو DEK في v2 (قبل الترقية).
 */
export function openVaultKeys(keys: VaultKeysRecord, passwordOrEmergencyKey: string): OpenedVaultKeys {
  const tryCommander = (): OpenedVaultKeys => {
    const dataKey = unwrapDataKey(keys.commanderWrap, passwordOrEmergencyKey);
    const familyKey = keys.family ? openWithKey(keys.family.fkByCommander, dataKey) : null;
    return { unlockedBy: 'commander', dataKey, familyKey };
  };
  const tryEmergency = (): OpenedVaultKeys => {
    const secret = normalizeEmergencyKey(passwordOrEmergencyKey);
    if (keys.family) return { unlockedBy: 'wife_emergency', dataKey: null, familyKey: unwrapDataKey(keys.family.fkByEmergency, secret) };
    if (keys.emergencyWrap) return { unlockedBy: 'wife_emergency', dataKey: unwrapDataKey(keys.emergencyWrap, secret), familyKey: null };
    throw new Error('لا يوجد مغلّف طوارئ.');
  };
  const attempts = isValidEmergencyKey(passwordOrEmergencyKey) ? [tryEmergency, tryCommander] : [tryCommander];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // نجرب المغلف التالي
    }
  }
  throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
}

/**
 * Hint بالعربي: دالة فتح الخزنة بكلمة المرور الرئيسية (كل الأسرار) أو بمفتاح الطوارئ
 *               (v3: الخزنة العائلية وحدها).
 */
export function unlockVault(passwordOrEmergencyKey: string, customVaultFilePath?: string): UnlockedVault {
  const vaultFilePath = resolveVaultFilePath(customVaultFilePath);
  const file = readVaultFile(vaultFilePath);
  try {
    const opened = openVaultKeys(vaultKeysOf(file), passwordOrEmergencyKey);
    if (opened.dataKey) {
      const secrets = JSON.parse(openWithKey(file.data, opened.dataKey).toString('utf-8')) as VaultSecretItem[];
      return { vaultFilePath, dataKey: opened.dataKey, familyKey: opened.familyKey, unlockedBy: opened.unlockedBy, secrets };
    }
    // جلسة العائلة (v3): لا DEK إطلاقاً
    const familyFile = file as VaultFileV3;
    const secrets = JSON.parse(openWithKey(familyFile.family.data, opened.familyKey!).toString('utf-8')) as VaultSecretItem[];
    return { vaultFilePath, dataKey: Buffer.alloc(0), familyKey: opened.familyKey, unlockedBy: 'wife_emergency', secrets };
  } catch (err) {
    logSystemError('VaultManager', 'محاولة فاشلة لفتح الخزنة المشفرة', err);
    throw new Error('كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
  }
}

/**
 * Hint بالعربي: دالة فتح الخزنة بمفتاح البيانات نفسه (3.3.0: بعد أن يفكّه Passkey بامتداد PRF على هذا الجهاز).
 *               النتيجة جلسة قائد كاملة. ترمي إن لم يفتح المفتاح بيانات الخزنة.
 */
export function unlockVaultWithDataKey(dataKey: Buffer, customVaultFilePath?: string): UnlockedVault {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('مفتاح البيانات غير صالح.');
  const vaultFilePath = resolveVaultFilePath(customVaultFilePath);
  const file = readVaultFile(vaultFilePath);
  const secrets = JSON.parse(openWithKey(file.data, dataKey).toString('utf-8')) as VaultSecretItem[];
  const familyKey = isFamilyVaultFile(file) ? openWithKey(file.family.fkByCommander, dataKey) : null;
  return { vaultFilePath, dataKey: Buffer.from(dataKey), familyKey, unlockedBy: 'commander', secrets };
}

/**
 * Hint بالعربي: بصمة مغلّف القائد الحالي (تتغيّر مع كل تغيير لكلمة المرور الرئيسية، على أي جهاز).
 */
export function commanderWrapFingerprint(customVaultFilePath?: string): string {
  const file = readVaultFile(resolveVaultFilePath(customVaultFilePath));
  return crypto.createHash('sha256').update(JSON.stringify(file.commanderWrap)).digest('hex');
}

/**
 * Hint بالعربي: هل تملك هذه الجلسة مفتاح البيانات الرئيسي (أي يمكنها حفظ الأسرار والمزامنة والنسخ الكاملة)؟
 */
export function hasMainDataKey(vault: UnlockedVault): boolean {
  return vault.dataKey.length === 32;
}

/**
 * Hint بالعربي: هل ملف الخزنة مرقّى إلى الخزنة العائلية (v3)؟
 */
export function isFamilyVaultFile(file: VaultFile): file is VaultFileV3 {
  return file.version === 3;
}

/**
 * Hint بالعربي: دالة الحصول على المفتاح العائلي لجلسة القائد (من الجلسة، أو من الملف إن لم يُحمَّل بعد).
 */
export function resolveFamilyKey(vault: UnlockedVault, file?: VaultFile): Buffer | null {
  if (vault.familyKey && vault.familyKey.length === 32) return vault.familyKey;
  const f = file ?? readVaultFile(vault.vaultFilePath);
  if (!isFamilyVaultFile(f) || !hasMainDataKey(vault)) return null;
  vault.familyKey = openWithKey(f.family.fkByCommander, vault.dataKey);
  return vault.familyKey;
}

/**
 * Hint بالعربي: دالة حفظ الأسرار الحالية للخزنة المفتوحة (إعادة تشفير البيانات بنفس المفتاح وحفظ ذرّي).
 *               في v3 تُعاد كتابة الخزنة العائلية من الأسرار المعلَّمة في كل حفظ (مصدر واحد للحقيقة).
 *               جلسة العائلة لا تحفظ أبداً.
 */
export function persistVault(vault: UnlockedVault): void {
  if (!hasMainDataKey(vault)) throw new Error('جلسة العائلة للقراءة فقط: تعديل الخزنة يحتاج كلمة المرور الرئيسية.');
  const file = readVaultFile(vault.vaultFilePath);
  const updatedAt = formatTimestampIso();
  const data = sealWithKey(JSON.stringify(vault.secrets), vault.dataKey);
  let updated: VaultFile;
  if (isFamilyVaultFile(file)) {
    const familyKey = resolveFamilyKey(vault, file)!;
    updated = { ...file, data, family: { ...file.family, ...sealFamilySection(vault.secrets, familyKey) }, updatedAt };
  } else {
    updated = { ...file, data, updatedAt };
  }
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
 *               ولا تلمس مفتاح الطوارئ (الورقة المطبوعة تبقى صالحة).
 */
export function changeMasterPassword(vault: UnlockedVault, currentPassword: string, newPassword: string): void {
  const file = readVaultFile(vault.vaultFilePath);
  try {
    unwrapDataKey(file.commanderWrap, currentPassword);
  } catch {
    throw new Error('كلمة المرور الحالية غير صحيحة.');
  }
  assertStrongMasterPassword(newPassword);
  const updated: VaultFile = { ...file, commanderWrap: wrapDataKey(vault.dataKey, newPassword), updatedAt: formatTimestampIso() };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(updated, null, 2), VAULT_FILE_BACKUPS);
  logSystemInfo('VaultManager', 'تم تغيير كلمة المرور الرئيسية للخزنة.');
}

/**
 * Hint بالعربي: دالة تدوير مفتاح الطوارئ (عند فقدان الوثيقة المطبوعة مثلاً): تولّد مفتاحاً جديداً
 *               وتُبطل القديم. تتطلب كلمة المرور الرئيسية. في v3 يُعاد لفّ المفتاح العائلي فقط.
 */
export function rotateEmergencyKey(vault: UnlockedVault, masterPassword: string): string {
  const file = readVaultFile(vault.vaultFilePath);
  try {
    unwrapDataKey(file.commanderWrap, masterPassword);
  } catch {
    throw new Error('كلمة المرور الرئيسية غير صحيحة.');
  }
  const newKey = generateEmergencyRecoveryKey();
  const updatedAt = formatTimestampIso();
  const updated: VaultFile = isFamilyVaultFile(file)
    ? { ...file, family: { ...file.family, fkByEmergency: wrapDataKey(resolveFamilyKey(vault, file)!, newKey) }, updatedAt }
    : { ...file, emergencyWrap: wrapDataKey(vault.dataKey, newKey), updatedAt };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(updated, null, 2), VAULT_FILE_BACKUPS);
  logSystemInfo('VaultManager', 'تم تدوير مفتاح الطوارئ العائلي وإبطال المفتاح السابق.');
  return newKey;
}

/**
 * Hint بالعربي: دالة الترقية إلى الخزنة العائلية (v2 ← v3). تُنفَّذ مرة واحدة على جهاز واحد بطلب القائد:
 *               - تولّد مفتاحاً عائلياً FK ومفتاح طوارئ جديداً إجبارياً (القديم يفتح النسخ القديمة كلها).
 *               - تعلّم الأسرار المختارة «يظهر للعائلة» وتبني منها الخزنة العائلية.
 *               - تحذف غلاف الطوارئ القديم من الملف، فلا يفتح المفتاح القديم هذه الخزنة بعد الآن.
 *               المخرجات: مفتاح الطوارئ الجديد (يُطبع فوراً).
 */
export function migrateVaultToFamilyV3(vault: UnlockedVault, masterPassword: string, familySecretIds: string[]): { emergencyRecoveryKey: string; familyCount: number } {
  if (vault.unlockedBy !== 'commander' || !hasMainDataKey(vault)) throw new Error('الترقية تحتاج فتح الخزنة بكلمة المرور الرئيسية.');
  const file = readVaultFile(vault.vaultFilePath);
  if (isFamilyVaultFile(file)) throw new Error('الخزنة مرقّاة إلى الخزنة العائلية بالفعل.');
  try {
    unwrapDataKey(file.commanderWrap, masterPassword).fill(0);
  } catch {
    throw new Error('كلمة المرور الرئيسية غير صحيحة.');
  }
  const chosen = new Set(familySecretIds);
  const now = formatTimestampIso();
  vault.secrets = vault.secrets.map((s) => {
    const visible = chosen.has(s.id) && s.category !== 'critical_file';
    return visible === (s.familyVisible === true) ? s : { ...s, familyVisible: visible, updatedAt: now };
  });
  const familyKey = generateDataKey();
  const emergencyRecoveryKey = generateEmergencyRecoveryKey();
  const section = sealFamilySection(vault.secrets, familyKey);
  const upgraded: VaultFileV3 = {
    format: 'second-brain-vault',
    version: 3,
    commanderWrap: file.commanderWrap,
    family: { fkByCommander: sealWithKey(familyKey, vault.dataKey), fkByEmergency: wrapDataKey(familyKey, emergencyRecoveryKey), ...section, migratedAt: now },
    data: sealWithKey(JSON.stringify(vault.secrets), vault.dataKey),
    createdAt: file.createdAt,
    updatedAt: now,
  };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(upgraded, null, 2), VAULT_FILE_BACKUPS);
  vault.familyKey = familyKey;
  logSystemInfo('VaultManager', `تمت الترقية إلى الخزنة العائلية v3 (${countAr(section.count, AR_COUNT.secret)} للعائلة)، وأُبطل مفتاح الطوارئ القديم.`);
  return { emergencyRecoveryKey, familyCount: section.count };
}

/**
 * Hint بالعربي: دالة تطبيق مفاتيح خزنة عائلية وصلت بالمزامنة من جهاز رقّى خزنته (أو غيّر مفاتيحها).
 *               - ملف v2 هنا ← يُرقّى إلى v3 بالمفتاح العائلي نفسه (لا يولَّد مفتاح جديد على هذا الجهاز).
 *               - ملف v3 بمفتاح عائلي آخر ← يُعتمد القادم. المخرجات: المفتاح العائلي السابق إن تغيّر.
 */
export function adoptFamilyKeys(vault: UnlockedVault, keys: VaultKeysRecord): { upgraded: boolean; previousFamilyKey: Buffer | null } {
  if (!keys.family) throw new Error('سجل المفاتيح لا يحمل خزنة عائلية.');
  if (!hasMainDataKey(vault)) throw new Error('تطبيق مفاتيح الخزنة العائلية يحتاج جلسة القائد.');
  const file = readVaultFile(vault.vaultFilePath);
  const familyKey = openWithKey(keys.family.fkByCommander, vault.dataKey);
  const previous = isFamilyVaultFile(file) ? resolveFamilyKey(vault, file) : null;
  const now = formatTimestampIso();
  const upgraded: VaultFileV3 = {
    format: 'second-brain-vault',
    version: 3,
    commanderWrap: keys.commanderWrap,
    family: {
      fkByCommander: keys.family.fkByCommander,
      fkByEmergency: keys.family.fkByEmergency,
      ...sealFamilySection(vault.secrets, familyKey),
      migratedAt: isFamilyVaultFile(file) ? file.family.migratedAt : now,
    },
    data: file.data,
    createdAt: file.createdAt,
    updatedAt: now,
  };
  writeFileAtomic(vault.vaultFilePath, JSON.stringify(upgraded, null, 2), VAULT_FILE_BACKUPS);
  vault.familyKey = familyKey;
  const changed = previous && !previous.equals(familyKey) ? previous : null;
  return { upgraded: !isFamilyVaultFile(file), previousFamilyKey: changed };
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
    unwrapDataKey(isFamilyVaultFile(file) ? file.family.fkByEmergency : file.emergencyWrap, normalizeEmergencyKey(emergencyKey)).fill(0);
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
  vault.familyKey?.fill(0);
  vault.familyKey = null;
  vault.secrets = [];
}
