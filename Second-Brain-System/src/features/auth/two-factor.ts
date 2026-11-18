/**
 * ============================================================================
 * الملف: src/features/auth/two-factor.ts
 * القسم: Features -> Auth (المصادقة الثنائية والرموز الاحتياطية، 3.5.0 — المرحلة 2.3 من docs/12)
 * Hint بالعربي: قرارات القائد (`2026-11-18`):
 *               - الرمز (6 أرقام من Google Authenticator) يُطلب عند فتح الخزنة **بكلمة المرور فقط**،
 *                 لا مع الـ Passkey ولا مع مفتاح الطوارئ. والقائد يفعّلها أو يعطّلها بنفسه.
 *               - 10 رموز احتياطية لمرة واحدة، تُطبع في **ورقة منفصلة للقائد** (لا في كتيب العائلة).
 *               الحالة عنصر خاص داخل الخزنة (category = two_factor، المعرّف SB-SYSTEM-2FA): مشفّرة، وتُزامَن بين الأجهزة
 *               (فتطبيق المصادقة نفسه يعمل على الجهازين)، ولا تظهر في القوائم ولا للعائلة.
 *               الرموز الاحتياطية مجزّأة بـ scrypt، ويُشطب الرمز بعد استخدامه. ورمز TOTP لا يُقبل مرتين (آخر خطوة محفوظة).
 *               ⚠️ ملاحظة صادقة: هذه بوابة في الخادم، لا تشفير. من يملك ملفات الخزنة وكلمة المرور معاً يتجاوزها؛
 *               الحماية الحقيقية للبيانات تبقى كلمة المرور والتشفير.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import type { VaultSecretItem } from '../../shared/types.ts';
import { base32Decode, base32Encode, buildOtpauthUri, generateTotpSecret, verifyTotp } from '../../shared/totp.ts';
import { generateQr, qrToSvg } from '../../shared/qr-code.ts';
import { deleteVaultSecret, hasMainDataKey, upsertVaultSecret, type UnlockedVault } from '../vault/vault-manager.ts';

/** معرّف عنصر الحالة داخل الخزنة */
export const TWO_FACTOR_ID = 'SB-SYSTEM-2FA';
/** عدد الرموز الاحتياطية */
export const BACKUP_CODE_COUNT = 10;
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا 0/O و 1/I
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const SETUP_TTL_MS = 10 * 60 * 1000;

interface BackupCodeHash {
  salt: string;
  hash: string;
  usedAt: string | null;
}

/** حالة المصادقة الثنائية (داخل secretValue للعنصر الخاص، مشفّرة مع الخزنة) */
export interface TwoFactorState {
  version: 1;
  secret: string;
  enabledAt: string;
  lastUsedStep: number;
  backupCodes: BackupCodeHash[];
}

/** إعداد معلّق (في الذاكرة) حتى يُثبت القائد أن التطبيق يعطي رموزاً صحيحة */
let pendingSetup: { secret: Buffer; expiresAt: number } | null = null;

/**
 * Hint بالعربي: هل هذا العنصر هو حالة المصادقة الثنائية (لا يظهر في القوائم ولا يُعدَّل من مسار الأسرار)؟
 */
export function isTwoFactorItem(s: Pick<VaultSecretItem, 'id' | 'category'>): boolean {
  return s.category === 'two_factor' || s.id === TWO_FACTOR_ID;
}

/**
 * Hint بالعربي: قراءة الحالة من الخزنة المفتوحة (null إن لم تُفعَّل).
 */
export function readTwoFactor(vault: UnlockedVault): TwoFactorState | null {
  const item = vault.secrets.find((s) => s.id === TWO_FACTOR_ID);
  if (!item) return null;
  try {
    const st = JSON.parse(item.secretValue) as TwoFactorState;
    return st && st.version === 1 && typeof st.secret === 'string' && Array.isArray(st.backupCodes) ? st : null;
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: هل المصادقة الثنائية مفعّلة؟
 */
export function isTwoFactorEnabled(vault: UnlockedVault): boolean {
  return vault.unlockedBy === 'commander' && readTwoFactor(vault) !== null;
}

function writeState(vault: UnlockedVault, st: TwoFactorState): void {
  upsertVaultSecret(vault, {
    id: TWO_FACTOR_ID,
    category: 'two_factor',
    title: 'المصادقة الثنائية (نظام)',
    secretValue: JSON.stringify(st),
    notesForCommanderAr: '',
    notesForWifeAr: '',
    familyVisible: false,
  });
}

function hashBackup(code: string, salt: Buffer): string {
  return crypto.scryptSync(normalizeBackupCode(code), salt, 32, SCRYPT).toString('hex');
}

/**
 * Hint بالعربي: توحيد شكل الرمز الاحتياطي (حروف كبيرة، بلا مسافات ولا شرطات).
 */
export function normalizeBackupCode(code: string): string {
  return String(code).toUpperCase().replace(/[\s-]/g, '');
}

function newBackupCodes(): { codes: string[]; hashes: BackupCodeHash[] } {
  const codes: string[] = [];
  const hashes: BackupCodeHash[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const bytes = crypto.randomBytes(10);
    let raw = '';
    for (const b of bytes) raw += BACKUP_ALPHABET[b % BACKUP_ALPHABET.length];
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    const salt = crypto.randomBytes(16);
    codes.push(code);
    hashes.push({ salt: salt.toString('hex'), hash: hashBackup(code, salt), usedAt: null });
  }
  return { codes, hashes };
}

function assertCommander(vault: UnlockedVault): void {
  if (vault.unlockedBy !== 'commander' || !hasMainDataKey(vault)) throw new Error('المصادقة الثنائية للقائد فقط.');
}

/**
 * Hint بالعربي: بداية التفعيل: سرّ جديد في الذاكرة، ورابط otpauth وباركوده، والسر مكتوباً للإدخال اليدوي.
 */
export function beginTwoFactorSetup(vault: UnlockedVault, account: string, now: number = Date.now()) {
  assertCommander(vault);
  if (readTwoFactor(vault)) throw new Error('المصادقة الثنائية مفعّلة بالفعل. عطّلها أولاً لتغيير التطبيق.');
  const secret = generateTotpSecret();
  pendingSetup = { secret, expiresAt: now + SETUP_TTL_MS };
  const uri = buildOtpauthUri(secret, account || 'commander');
  return { secretBase32: base32Encode(secret).replace(/(.{4})/g, '$1 ').trim(), otpauthUri: uri, qrSvg: qrToSvg(generateQr(uri), { moduleSize: 5, title: 'باركود ربط تطبيق المصادقة' }) };
}

/**
 * Hint بالعربي: إكمال التفعيل: يُقبل فقط إن أعطى التطبيق رمزاً صحيحاً للسر المعلّق. المخرجات: الرموز الاحتياطية (تُعرض مرة واحدة).
 */
export function finishTwoFactorSetup(vault: UnlockedVault, code: string, now: number = Date.now()): string[] {
  assertCommander(vault);
  if (!pendingSetup || pendingSetup.expiresAt < now) throw new Error('انتهت مهلة التفعيل (10 دقائق). ابدأ من جديد.');
  const step = verifyTotp(pendingSetup.secret, code, now);
  if (step === null) throw new Error('الرمز غير صحيح. تأكد أن ساعة الهاتف مضبوطة، واكتب الرمز الحالي من التطبيق.');
  const { codes, hashes } = newBackupCodes();
  writeState(vault, { version: 1, secret: base32Encode(pendingSetup.secret), enabledAt: new Date(now).toISOString(), lastUsedStep: step, backupCodes: hashes });
  pendingSetup = null;
  return codes;
}

/**
 * Hint بالعربي: التحقق من العامل الثاني عند فتح الخزنة بكلمة المرور: رمز التطبيق (6 أرقام) أو رمز احتياطي.
 *               عند النجاح تُحفظ الحالة (آخر خطوة، أو شطب الرمز الاحتياطي). المخرجات: الطريقة، والرموز الاحتياطية الباقية.
 */
export function verifySecondFactor(vault: UnlockedVault, input: string, now: number = Date.now()): { ok: boolean; method?: 'totp' | 'backup'; backupLeft?: number } {
  const st = readTwoFactor(vault);
  if (!st) return { ok: true };
  const clean = String(input ?? '').trim();
  if (!clean) return { ok: false };
  if (/^\d{3}\s?\d{3}$/.test(clean)) {
    const step = verifyTotp(base32Decode(st.secret), clean, now, { lastUsedStep: st.lastUsedStep });
    if (step === null) return { ok: false };
    writeState(vault, { ...st, lastUsedStep: step });
    return { ok: true, method: 'totp', backupLeft: st.backupCodes.filter((b) => !b.usedAt).length };
  }
  const norm = normalizeBackupCode(clean);
  if (!/^[A-Z0-9]{10}$/.test(norm)) return { ok: false };
  for (let i = 0; i < st.backupCodes.length; i++) {
    const b = st.backupCodes[i];
    if (b.usedAt) continue;
    const h = hashBackup(norm, Buffer.from(b.salt, 'hex'));
    if (crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(b.hash, 'hex'))) {
      const backupCodes = st.backupCodes.map((x, j) => (j === i ? { ...x, usedAt: new Date(now).toISOString() } : x));
      writeState(vault, { ...st, backupCodes });
      return { ok: true, method: 'backup', backupLeft: backupCodes.filter((x) => !x.usedAt).length };
    }
  }
  return { ok: false };
}

/**
 * Hint بالعربي: رموز احتياطية جديدة (تُبطل القديمة كلها). المخرجات: الرموز (تُعرض مرة واحدة).
 */
export function regenerateBackupCodes(vault: UnlockedVault): string[] {
  assertCommander(vault);
  const st = readTwoFactor(vault);
  if (!st) throw new Error('المصادقة الثنائية غير مفعّلة.');
  const { codes, hashes } = newBackupCodes();
  writeState(vault, { ...st, backupCodes: hashes });
  return codes;
}

/**
 * Hint بالعربي: تعطيل المصادقة الثنائية (يُحذف العنصر الخاص، وينتقل الحذف إلى الأجهزة الأخرى بالمزامنة).
 */
export function disableTwoFactor(vault: UnlockedVault): boolean {
  assertCommander(vault);
  pendingSetup = null;
  return deleteVaultSecret(vault, TWO_FACTOR_ID);
}

/**
 * Hint بالعربي: حالة للعرض (بلا السر ولا الأجزاء المجزّأة).
 */
export function describeTwoFactor(vault: UnlockedVault): { enabled: boolean; enabledAt: string | null; backupLeft: number } {
  const st = readTwoFactor(vault);
  return { enabled: Boolean(st), enabledAt: st?.enabledAt ?? null, backupLeft: st ? st.backupCodes.filter((b) => !b.usedAt).length : 0 };
}

/**
 * Hint بالعربي: للاختبارات فقط.
 */
export function resetTwoFactorPendingForTests(): void {
  pendingSetup = null;
}
