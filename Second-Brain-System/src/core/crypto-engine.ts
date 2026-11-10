/**
 * ============================================================================
 * الملف: src/core/crypto-engine.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: محرك التشفير العسكري (Zero-Knowledge AES-256-GCM).
 *               يقوم بتشفير وفك تشفير الإيميلات، الباسووردات، والملفات السرية (.env, keystore)
 *               باستخدام كلمة المرور الرئيسية أو مفتاح الطوارئ الخاص بالزوجة.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import type { EncryptedPayload } from '../shared/types.ts';
import { formatTimestampIso } from '../shared/file-helpers.ts';

/**
 * Hint بالعربي: دالة لاشتقاق مفتاح تشفير طوله 256 بت (32 بايت) من كلمة المرور النصية
 * باستخدام خوارزمية scrypt المقاومة لهجمات التخمين.
 */
export function deriveEncryptionKey(masterPassword: string, saltBuffer: Buffer): Buffer {
  return crypto.scryptSync(masterPassword, saltBuffer, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

/**
 * Hint بالعربي: دالة لتشفير أي نص سري أو بيانات باستخدام خوارزمية AES-256-GCM
 * مع توليد Salt و IV عشوائيين لكل عملية تشفير وتوقيع مصادقة (AuthTag) لمنع أي تلاعب.
 */
export function encryptWithAes256Gcm(plainText: string, masterPassword: string): EncryptedPayload {
  const saltBuffer = crypto.randomBytes(16);
  const ivBuffer = crypto.randomBytes(12);
  const keyBuffer = deriveEncryptionKey(masterPassword, saltBuffer);

  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, ivBuffer);
  const encryptedBuffer = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const authTagBuffer = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    saltHex: saltBuffer.toString('hex'),
    ivHex: ivBuffer.toString('hex'),
    authTagHex: authTagBuffer.toString('hex'),
    cipherTextHex: encryptedBuffer.toString('hex'),
    createdAt: formatTimestampIso(),
  };
}

/**
 * Hint بالعربي: دالة لفك تشفير الحزمة المشفرة بـ AES-256-GCM والتأكد من سلامة البيانات
 * وصحة كلمة المرور الرئيسية أو مفتاح الطوارئ.
 */
export function decryptWithAes256Gcm(payload: EncryptedPayload, masterPassword: string): string {
  const saltBuffer = Buffer.from(payload.saltHex, 'hex');
  const ivBuffer = Buffer.from(payload.ivHex, 'hex');
  const authTagBuffer = Buffer.from(payload.authTagHex, 'hex');
  const cipherTextBuffer = Buffer.from(payload.cipherTextHex, 'hex');

  const keyBuffer = deriveEncryptionKey(masterPassword, saltBuffer);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  const decryptedBuffer = Buffer.concat([decipher.update(cipherTextBuffer), decipher.final()]);
  return decryptedBuffer.toString('utf-8');
}

/**
 * Hint بالعربي: دالة لتوليد "مفتاح طوارئ عائلي" (Emergency Recovery Key) منسق وسهل القراءة
 * ليتم طباعته في وثيقة الطوارئ الخاصة بالزوجة (مثال: SB-XXXX-XXXX-XXXX-XXXX).
 */
export function generateEmergencyRecoveryKey(): string {
  const segments: string[] = ['SB'];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return segments.join('-');
}
