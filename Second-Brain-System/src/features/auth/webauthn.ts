/**
 * ============================================================================
 * الملف: src/features/auth/webauthn.ts
 * القسم: Features -> Auth (التحقق من Passkeys بلا حزم خارجية، 3.3.0 — المرحلة 2.2 من docs/12)
 * Hint بالعربي: كل ما يحتاجه الخادم ليتحقق من رد المتصفح بنفسه، بمكتبات Node المدمجة فقط:
 *               - قارئ CBOR صغير (يكفي لـ attestationObject ومفتاح COSE).
 *               - قراءة authenticatorData: بصمة rpId، والأعلام (UP، UV، BE، BS، AT)، والعدّاد، وبيانات المفتاح.
 *               - تحويل مفتاح COSE (ES256 على P-256، أو RS256) إلى مفتاح Node، والتحقق من التوقيع.
 *               - التحقق من clientDataJSON: النوع، والتحدي، والأصل (http://localhost:<المنفذ>).
 *               لا نتحقق من شهادة المصنّع (attestation)، فنطلب 'none': يكفينا أن Passkey يوقّع بعد التحقق منك.
 * ============================================================================
 */

import * as crypto from 'node:crypto';

/** معرّف الموقع الوحيد المسموح (ISS-037: العنوان الرقمي مرفوض في WebAuthn) */
export const RP_ID = 'localhost';

// ===================== CBOR =====================

/** قيمة CBOR بعد القراءة */
export type CborValue = number | bigint | string | Buffer | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

/**
 * Hint بالعربي: دالة قراءة عنصر CBOR واحد من بداية المخزن. المخرجات: القيمة، وعدد البايتات المقروءة.
 *               تدعم: الأعداد، والبايتات، والنصوص، والمصفوفات، والخرائط، و true/false/null. وترفض الطول غير المحدد.
 */
export function decodeCbor(buf: Buffer, offset = 0, depth = 0): { value: CborValue; length: number } {
  if (depth > 16) throw new Error('CBOR: تداخل عميق جداً.');
  if (offset >= buf.length) throw new Error('CBOR: نهاية غير متوقعة.');
  const first = buf[offset];
  const major = first >> 5;
  const info = first & 0x1f;
  let pos = offset + 1;
  const readArg = (): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) throw new Error('CBOR: طول غير محدد غير مدعوم.');
    if (pos + size > buf.length) throw new Error('CBOR: نهاية غير متوقعة.');
    let n: number;
    if (size === 8) {
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: عدد كبير جداً.');
      n = Number(big);
    } else n = size === 1 ? buf[pos] : size === 2 ? buf.readUInt16BE(pos) : buf.readUInt32BE(pos);
    pos += size;
    return n;
  };
  if (major === 7) {
    if (info === 20) return { value: false, length: 1 };
    if (info === 21) return { value: true, length: 1 };
    if (info === 22) return { value: null, length: 1 };
    if (info === 23) return { value: undefined, length: 1 };
    throw new Error('CBOR: نوع بسيط غير مدعوم.');
  }
  const arg = readArg();
  switch (major) {
    case 0:
      return { value: arg, length: pos - offset };
    case 1:
      return { value: -1 - arg, length: pos - offset };
    case 2:
    case 3: {
      if (pos + arg > buf.length) throw new Error('CBOR: نهاية غير متوقعة.');
      const bytes = buf.subarray(pos, pos + arg);
      pos += arg;
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), length: pos - offset };
    }
    case 4: {
      if (arg > 1000) throw new Error('CBOR: مصفوفة كبيرة جداً.');
      const arr: CborValue[] = [];
      for (let i = 0; i < arg; i++) {
        const item = decodeCbor(buf, pos, depth + 1);
        arr.push(item.value);
        pos += item.length;
      }
      return { value: arr, length: pos - offset };
    }
    case 5: {
      if (arg > 1000) throw new Error('CBOR: خريطة كبيرة جداً.');
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < arg; i++) {
        const k = decodeCbor(buf, pos, depth + 1);
        pos += k.length;
        const v = decodeCbor(buf, pos, depth + 1);
        pos += v.length;
        map.set(k.value, v.value);
      }
      return { value: map, length: pos - offset };
    }
    default:
      throw new Error('CBOR: نوع غير مدعوم.');
  }
}

// ===================== authenticatorData =====================

/** أعلام authenticatorData */
export interface AuthFlags {
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  attestedCredential: boolean;
}

/** authenticatorData بعد القراءة */
export interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: AuthFlags;
  signCount: number;
  credentialId?: Buffer;
  publicKeyCose?: Buffer;
}

/**
 * Hint بالعربي: دالة قراءة authenticatorData (37 بايت على الأقل، ومعها بيانات المفتاح عند التسجيل).
 */
export function parseAuthenticatorData(data: Buffer): ParsedAuthData {
  if (data.length < 37) throw new Error('authenticatorData قصيرة.');
  const f = data[32];
  const flags: AuthFlags = {
    userPresent: Boolean(f & 0x01),
    userVerified: Boolean(f & 0x04),
    backupEligible: Boolean(f & 0x08),
    backedUp: Boolean(f & 0x10),
    attestedCredential: Boolean(f & 0x40),
  };
  const out: ParsedAuthData = { rpIdHash: data.subarray(0, 32), flags, signCount: data.readUInt32BE(33) };
  if (flags.attestedCredential) {
    if (data.length < 55) throw new Error('بيانات المفتاح ناقصة.');
    const idLen = data.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || data.length < 55 + idLen + 1) throw new Error('معرّف المفتاح غير صالح.');
    out.credentialId = Buffer.from(data.subarray(55, 55 + idLen));
    const keyStart = 55 + idLen;
    const key = decodeCbor(data, keyStart);
    out.publicKeyCose = Buffer.from(data.subarray(keyStart, keyStart + key.length));
  }
  return out;
}

// ===================== مفتاح COSE =====================

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * Hint بالعربي: دالة تحويل مفتاح COSE إلى مفتاح Node. المدعوم: ES256 (-7، EC2 على P-256) و RS256 (-257).
 */
export function coseToPublicKey(cose: Buffer): { key: crypto.KeyObject; alg: -7 | -257 } {
  const m = decodeCbor(cose).value;
  if (!(m instanceof Map)) throw new Error('مفتاح COSE غير صالح.');
  const kty = m.get(1);
  const alg = m.get(3);
  if (kty === 2 && alg === -7) {
    const crv = m.get(-1);
    const x = m.get(-2);
    const y = m.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('مفتاح EC غير مدعوم (P-256 فقط).');
    return { key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' }), alg: -7 };
  }
  if (kty === 3 && alg === -257) {
    const n = m.get(-1);
    const e = m.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw new Error('مفتاح RSA غير مدعوم (2048 بت على الأقل).');
    return { key: crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' }), alg: -257 };
  }
  throw new Error('خوارزمية المفتاح غير مدعومة (ES256 أو RS256 فقط).');
}

/**
 * Hint بالعربي: دالة التحقق من توقيع Passkey على (authenticatorData || SHA-256(clientDataJSON)).
 */
export function verifyAssertionSignature(publicKeyPem: string, alg: -7 | -257, authData: Buffer, clientDataJSON: Buffer, signature: Buffer): boolean {
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const key = crypto.createPublicKey(publicKeyPem);
  try {
    return alg === -7 ? crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature) : crypto.verify('sha256', signed, key, signature);
  } catch {
    return false;
  }
}

// ===================== clientDataJSON =====================

/**
 * Hint بالعربي: دالة التحقق من clientDataJSON: النوع، والتحدي (base64url)، والأصل المسموح. ترمي برسالة عربية.
 */
export function verifyClientData(clientDataJSON: Buffer, expected: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origin: string }): void {
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    cd = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new Error('clientDataJSON غير صالح.');
  }
  if (cd.type !== expected.type) throw new Error('نوع الطلب غير متوقع.');
  const got = Buffer.from(typeof cd.challenge === 'string' ? cd.challenge : '');
  const want = Buffer.from(expected.challenge);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('التحدي غير مطابق.');
  if (cd.origin !== expected.origin) throw new Error(`الأصل غير مسموح: ${String(cd.origin).slice(0, 80)}`);
  if (cd.crossOrigin === true) throw new Error('طلب من إطار خارجي مرفوض.');
}

/**
 * Hint بالعربي: دالة التحقق من authenticatorData لطلب: بصمة rpId، والحضور، والتحقق من المستخدم (إجباري).
 */
export function verifyAuthDataFlags(auth: ParsedAuthData, rpId: string = RP_ID): void {
  const expectedHash = crypto.createHash('sha256').update(rpId).digest();
  if (auth.rpIdHash.length !== 32 || !crypto.timingSafeEqual(auth.rpIdHash, expectedHash)) throw new Error('معرّف الموقع غير مطابق.');
  if (!auth.flags.userPresent) throw new Error('لم يُؤكَّد حضور المستخدم.');
  if (!auth.flags.userVerified) throw new Error('لم يُتحقَّق من المستخدم (وجه أو بصمة أو رمز).');
}

/**
 * Hint بالعربي: الأصل المسموح لهذا الخادم.
 */
export function expectedOrigin(port: number): string {
  return `http://${RP_ID}:${port}`;
}
