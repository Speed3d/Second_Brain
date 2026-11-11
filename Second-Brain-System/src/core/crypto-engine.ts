/**
 * ============================================================================
 * الملف: src/core/crypto-engine.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: محرك التشفير (AES-256-GCM + scrypt).
 *               - يشتق مفاتيح قوية من كلمة المرور الرئيسية أو مفتاح الطوارئ.
 *               - يغلّف (يشفّر) مفتاح البيانات العشوائي DEK الذي تُشفَّر به الخزنة فعلياً.
 *               - يولّد مفتاح الطوارئ العائلي (128 بت) مع خانة تحقق لاكتشاف أخطاء الكتابة.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import type { EncryptedPayload, KdfParams, SealedData, WrappedKey } from '../shared/types.ts';
import { formatTimestampIso } from '../shared/file-helpers.ts';

/**
 * Hint بالعربي: المعاملات الافتراضية الحالية لـ scrypt (N = 2^17) — أقوى بثماني مرات من الإصدار الأول.
 */
export function getDefaultKdfParams(): KdfParams {
  return { algorithm: 'scrypt', N: 131072, r: 8, p: 1 };
}

/** المعاملات القديمة للإصدار الأول (للقراءة فقط) */
const LEGACY_KDF: KdfParams = { algorithm: 'scrypt', N: 16384, r: 8, p: 1 };

/**
 * Hint بالعربي: دالة لاشتقاق مفتاح تشفير طوله 256 بت (32 بايت) من كلمة المرور النصية
 * باستخدام خوارزمية scrypt المقاومة لهجمات التخمين. المعاملات تُحفظ مع البيانات المشفرة.
 */
export function deriveEncryptionKey(masterPassword: string, saltBuffer: Buffer, kdf: KdfParams = getDefaultKdfParams()): Buffer {
  return crypto.scryptSync(masterPassword.normalize('NFC'), saltBuffer, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/**
 * Hint بالعربي: دالة لتشفير بيانات بمفتاح جاهز (32 بايت) بخوارزمية AES-256-GCM مع IV عشوائي وتوقيع مصادقة.
 */
export function sealWithKey(plain: Buffer | string, key: Buffer): SealedData {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plain === 'string' ? Buffer.from(plain, 'utf-8') : plain;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    ivHex: iv.toString('hex'),
    authTagHex: cipher.getAuthTag().toString('hex'),
    cipherTextHex: encrypted.toString('hex'),
  };
}

/**
 * Hint بالعربي: دالة لفك تشفير بيانات مشفرة بمفتاح جاهز؛ ترمي خطأ إذا كان المفتاح خاطئاً أو البيانات معدَّلة.
 */
export function openWithKey(sealed: SealedData, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(sealed.authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.cipherTextHex, 'hex')), decipher.final()]);
}

/**
 * Hint بالعربي: دالة توليد مفتاح بيانات عشوائي (DEK) بطول 256 بت تُشفَّر به الخزنة والنسخ الاحتياطية.
 */
export function generateDataKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Hint بالعربي: دالة تغليف مفتاح البيانات DEK بمفتاح مشتق من كلمة مرور أو مفتاح الطوارئ.
 */
export function wrapDataKey(dataKey: Buffer, secret: string): WrappedKey {
  const kdf = getDefaultKdfParams();
  const salt = crypto.randomBytes(16);
  const kek = deriveEncryptionKey(secret, salt, kdf);
  return { kdf, saltHex: salt.toString('hex'), ...sealWithKey(dataKey, kek) };
}

/**
 * Hint بالعربي: دالة فك تغليف مفتاح البيانات DEK؛ ترمي خطأ إذا كانت كلمة المرور أو مفتاح الطوارئ غير صحيح.
 */
export function unwrapDataKey(wrapped: WrappedKey, secret: string): Buffer {
  const kek = deriveEncryptionKey(secret, Buffer.from(wrapped.saltHex, 'hex'), wrapped.kdf);
  return openWithKey(wrapped, kek);
}

/**
 * Hint بالعربي: دالة لتشفير نص بكلمة مرور مباشرة (AES-256-GCM + scrypt) مع حفظ معاملات الاشتقاق.
 */
export function encryptWithAes256Gcm(plainText: string, masterPassword: string): EncryptedPayload {
  const kdf = getDefaultKdfParams();
  const saltBuffer = crypto.randomBytes(16);
  const keyBuffer = deriveEncryptionKey(masterPassword, saltBuffer, kdf);
  return {
    algorithm: 'aes-256-gcm',
    saltHex: saltBuffer.toString('hex'),
    ...sealWithKey(plainText, keyBuffer),
    createdAt: formatTimestampIso(),
    kdf,
  };
}

/**
 * Hint بالعربي: دالة لفك تشفير حزمة مشفرة بكلمة مرور والتأكد من سلامة البيانات وصحة كلمة المرور.
 */
export function decryptWithAes256Gcm(payload: EncryptedPayload, masterPassword: string): string {
  const keyBuffer = deriveEncryptionKey(masterPassword, Buffer.from(payload.saltHex, 'hex'), payload.kdf ?? LEGACY_KDF);
  return openWithKey(payload, keyBuffer).toString('utf-8');
}

/**
 * Hint بالعربي: دالة لتوليد "مفتاح الطوارئ العائلي" (Emergency Recovery Key) بقوة 128 بت:
 *               SB- ثم 8 مجموعات من 4 خانات، ثم مجموعة تحقق أخيرة تكشف أي خطأ عند كتابته يدوياً.
 */
export function generateEmergencyRecoveryKey(): string {
  const body = crypto.randomBytes(16).toString('hex').toUpperCase();
  const groups = body.match(/.{4}/g) ?? [];
  return ['SB', ...groups, computeEmergencyKeyChecksum(body)].join('-');
}

/**
 * Hint بالعربي: دالة حساب خانة التحقق (4 خانات) لجسم مفتاح الطوارئ.
 */
export function computeEmergencyKeyChecksum(bodyHex: string): string {
  return crypto.createHash('sha256').update(`SB:${bodyHex.toUpperCase()}`).digest('hex').slice(0, 4).toUpperCase();
}

/**
 * Hint بالعربي: دالة توحيد شكل مفتاح الطوارئ المُدخل (حروف كبيرة، بدون مسافات، شرطات صحيحة)
 *               حتى تُقبل الكتابة بأحرف صغيرة أو بمسافات زائدة.
 */
export function normalizeEmergencyKey(input: string): string {
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!compact.startsWith('SB')) return input.trim();
  const rest = compact.slice(2);
  const groups = rest.match(/.{1,4}/g) ?? [];
  return ['SB', ...groups].join('-');
}

/**
 * Hint بالعربي: دالة التحقق من صحة شكل مفتاح الطوارئ وخانة التحقق الخاصة به.
 *               المخرجات: true إذا كان المفتاح مكتوباً بشكل صحيح.
 */
export function isValidEmergencyKey(input: string): boolean {
  const normalized = normalizeEmergencyKey(input);
  const match = normalized.match(/^SB-((?:[0-9A-F]{4}-){8})([0-9A-F]{4})$/);
  if (!match) return false;
  const body = match[1].replace(/-/g, '');
  return computeEmergencyKeyChecksum(body) === match[2];
}
