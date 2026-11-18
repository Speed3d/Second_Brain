/**
 * ============================================================================
 * الملف: src/shared/totp.ts
 * القسم: Shared (رموز المصادقة الثنائية TOTP بلا حزم، 3.5.0 — المرحلة 2.3 من docs/12)
 * Hint بالعربي: - HOTP (RFC 4226) و TOTP (RFC 6238): HMAC-SHA1، و 30 ثانية، و 6 أرقام (ما يفهمه Google Authenticator).
 *               - Base32 (RFC 4648) لعرض السر وكتابته يدوياً.
 *               - رابط otpauth:// للباركود.
 *               - التحقق بنافذة ±خطوة واحدة (فرق ساعة حتى 30 ثانية)، ويعيد رقم الخطوة لمنع إعادة استخدام الرمز.
 * ============================================================================
 */

import * as crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Hint بالعربي: ترميز Base32 بلا حشو.
 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Hint بالعربي: فك Base32 (يتجاهل المسافات والشرطات والحروف الصغيرة والحشو). يرمي إن وُجد حرف غير صالح.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('نص Base32 غير صالح.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Hint بالعربي: HOTP (RFC 4226): رمز من السر والعدّاد.
 */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** طول الخطوة بالثواني */
export const TOTP_STEP_SECONDS = 30;

/**
 * Hint بالعربي: رقم الخطوة لوقت معيّن (بالمللي ثانية).
 */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Hint بالعربي: TOTP (RFC 6238) لوقت معيّن.
 */
export function totp(secret: Buffer, nowMs: number, digits = 6): string {
  return hotp(secret, totpStep(nowMs), digits);
}

/**
 * Hint بالعربي: التحقق من رمز بنافذة ±window خطوة، مع رفض أي خطوة ≤ آخر خطوة مستخدمة (منع إعادة الاستخدام).
 *               المخرجات: رقم الخطوة المطابقة، أو null.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, options: { window?: number; lastUsedStep?: number } = {}): number | null {
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = totpStep(nowMs);
  const w = options.window ?? 1;
  for (let d = -w; d <= w; d++) {
    const step = now + d;
    if (options.lastUsedStep !== undefined && step <= options.lastUsedStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

/**
 * Hint بالعربي: سرّ جديد (160 بت، كما يوصي RFC 4226).
 */
export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(20);
}

/**
 * Hint بالعربي: رابط otpauth:// لتطبيق المصادقة (يُعرض باركوداً).
 */
export function buildOtpauthUri(secret: Buffer, account: string, issuer = 'Second Brain'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}
