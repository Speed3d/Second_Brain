/**
 * ============================================================================
 * الملف: src/features/auth/passkey-store.ts
 * القسم: Features -> Auth (الدخول بالبصمة أو رمز الجهاز — التصميم «أ» المعتمد، 3.3.0)
 * Hint بالعربي: Passkey بامتداد PRF يفتح الخزنة بتشفير حقيقي:
 *               - سرّ PRF (32 بايت، لا يخرج إلا بعد التحقق منك) ← HKDF ← مفتاح يلفّ مفتاح البيانات (DEK).
 *               - **الغلاف محلي على هذا الجهاز فقط** (data/passkeys/local-passkeys.json): لا يُزامَن، ولا يدخل
 *                 النسخ، ولا يصل إلى Drive. فحساب Google وحده (حيث قد يُزامَن الـ Passkey) لا يكفي: يلزم الجهاز نفسه.
 *               - التسجيل يحتاج كلمة المرور الرئيسية. والأعمال الحساسة تبقى بكلمة المرور.
 *               - تغيير كلمة المرور (على أي جهاز) يُبطل كل الأغلفة هنا: كل غلاف يحمل بصمة مغلّف القائد وقت التسجيل.
 *               - Passkey بلا PRF (Windows Hello على Windows 10، والهاتف) لا يُقبل (قرار القائد).
 *               - التحديات لمرة واحدة، صالحة 5 دقائق، والتوقيع والأصل ومعرّف الموقع والتحقق من المستخدم إجبارية.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { ensureDirectoryExists, readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { SealedData } from '../../shared/types.ts';
import { commanderWrapFingerprint, hasMainDataKey, unlockVaultWithDataKey, type UnlockedVault } from '../vault/vault-manager.ts';
import {
  coseToPublicKey,
  decodeCbor,
  expectedOrigin,
  parseAuthenticatorData,
  RP_ID,
  verifyAssertionSignature,
  verifyAuthDataFlags,
  verifyClientData,
} from './webauthn.ts';

/** Passkey مسجّل على هذا الجهاز */
export interface LocalPasskey {
  credentialId: string;
  label: string;
  alg: -7 | -257;
  publicKeyPem: string;
  signCount: number;
  prfSalt: string;
  wrap: SealedData;
  wrapFingerprint: string;
  backupEligible: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface StoreFile {
  version: 1;
  passkeys: LocalPasskey[];
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const HKDF_INFO = Buffer.from('second-brain/passkey-prf-wrap/v1');
const B64URL = /^[A-Za-z0-9_-]{1,8192}$/;

/** التحديات المعلّقة (في الذاكرة، لمرة واحدة) */
const pending = new Map<string, { kind: 'register' | 'unlock'; expiresAt: number; getChallenge?: string; prfSalt?: string; label?: string }>();

/**
 * Hint بالعربي: مسار ملف الأغلفة المحلي على هذا الجهاز.
 */
export function resolvePasskeyStoreFile(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'passkeys', 'local-passkeys.json');
}

function readStore(file: string): StoreFile {
  const s = readJsonFileSafe<StoreFile | null>(file, null);
  return s && s.version === 1 && Array.isArray(s.passkeys) ? s : { version: 1, passkeys: [] };
}

function writeStore(file: string, store: StoreFile): void {
  ensureDirectoryExists(path.dirname(file));
  writeFileAtomic(file, JSON.stringify(store, null, 2));
}

function purgeExpired(now: number): void {
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

function newChallenge(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function b64(field: string, value: unknown): Buffer {
  if (typeof value !== 'string' || !B64URL.test(value)) throw new Error(`حقل غير صالح: ${field}`);
  return Buffer.from(value, 'base64url');
}

/**
 * Hint بالعربي: اشتقاق مفتاح التغليف من سرّ PRF (HKDF-SHA256، والملح معرّف الـ Passkey).
 */
export function deriveWrapKey(prfOutput: Buffer, credentialId: Buffer): Buffer {
  if (prfOutput.length !== 32) throw new Error('سرّ PRF يجب أن يكون 32 بايت.');
  return Buffer.from(crypto.hkdfSync('sha256', prfOutput, credentialId, HKDF_INFO, 32));
}

/**
 * Hint بالعربي: قائمة الـ Passkeys المسجّلة على هذا الجهاز (بلا الأغلفة ولا المفاتيح).
 */
export function listLocalPasskeys(file: string = resolvePasskeyStoreFile()): Array<Pick<LocalPasskey, 'credentialId' | 'label' | 'createdAt' | 'lastUsedAt' | 'backupEligible'>> {
  return readStore(file).passkeys.map((p) => ({ credentialId: p.credentialId, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, backupEligible: p.backupEligible }));
}

/**
 * Hint بالعربي: عدد الـ Passkeys الصالحة على هذا الجهاز (لإظهار زر الفتح). تُحذف هنا الأغلفة التي أبطلها تغيير كلمة المرور.
 */
export function countUsablePasskeys(file: string = resolvePasskeyStoreFile(), vaultFilePath?: string): number {
  const store = readStore(file);
  if (!store.passkeys.length) return 0;
  let fp: string;
  try {
    fp = commanderWrapFingerprint(vaultFilePath);
  } catch {
    return 0;
  }
  const valid = store.passkeys.filter((p) => p.wrapFingerprint === fp);
  if (valid.length !== store.passkeys.length) {
    writeStore(file, { version: 1, passkeys: valid });
    logSystemInfo('Passkeys', `أُبطل ${store.passkeys.length - valid.length} Passkey على هذا الجهاز لأن كلمة المرور الرئيسية تغيّرت.`);
  }
  return valid.length;
}

/**
 * Hint بالعربي: حذف Passkey واحد من هذا الجهاز. المخرجات: true إن وُجد.
 */
export function removeLocalPasskey(credentialId: string, file: string = resolvePasskeyStoreFile()): boolean {
  const store = readStore(file);
  const left = store.passkeys.filter((p) => p.credentialId !== credentialId);
  if (left.length === store.passkeys.length) return false;
  writeStore(file, { version: 1, passkeys: left });
  return true;
}

/**
 * Hint بالعربي: حذف كل الـ Passkeys على هذا الجهاز (عند تغيير كلمة المرور هنا). المخرجات: العدد.
 */
export function removeAllLocalPasskeys(file: string = resolvePasskeyStoreFile()): number {
  const n = readStore(file).passkeys.length;
  if (n) writeStore(file, { version: 1, passkeys: [] });
  return n;
}

/**
 * Hint بالعربي: بداية التسجيل (جلسة قائد، وبعد التحقق من كلمة المرور في المسار).
 *               المخرجات: خيارات create و get للمتصفح، مع ملح PRF الخاص بهذا الـ Passkey.
 */
export function beginRegistration(vault: UnlockedVault, label: string, file: string = resolvePasskeyStoreFile(), now: number = Date.now()) {
  if (vault.unlockedBy !== 'commander' || !hasMainDataKey(vault)) throw new Error('التسجيل للقائد فقط، والخزنة مفتوحة بكلمة المرور.');
  const existing = readStore(file).passkeys;
  if (existing.length >= MAX_PASSKEYS) throw new Error(`الحد الأقصى ${MAX_PASSKEYS} Passkeys على الجهاز الواحد. احذف أحدها أولاً.`);
  purgeExpired(now);
  const createChallenge = newChallenge();
  const getChallenge = newChallenge();
  const prfSalt = crypto.randomBytes(32).toString('base64url');
  pending.set(createChallenge, { kind: 'register', expiresAt: now + CHALLENGE_TTL_MS, getChallenge, prfSalt, label: label.trim().slice(0, 80) || 'Passkey' });
  return {
    token: createChallenge,
    rpId: RP_ID,
    createChallenge,
    getChallenge,
    prfSalt,
    userId: crypto.randomBytes(16).toString('base64url'),
    excludeCredentialIds: existing.map((p) => p.credentialId),
  };
}

/** ما يرسله المتصفح بعد التسجيل */
export interface RegistrationResponse {
  token: string;
  attestationObject: string;
  clientDataJSON: string;
  assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
  prfOutput: string;
}

/**
 * Hint بالعربي: إكمال التسجيل: التحقق من الإنشاء ومن توقيع أول دخول بالمفتاح نفسه، ثم لفّ مفتاح البيانات بسرّ PRF
 *               وحفظ الغلاف محلياً. ترمي برسالة عربية عند أي خلل.
 */
export function finishRegistration(vault: UnlockedVault, port: number, body: RegistrationResponse, file: string = resolvePasskeyStoreFile(), now: number = Date.now()) {
  if (vault.unlockedBy !== 'commander' || !hasMainDataKey(vault)) throw new Error('التسجيل للقائد فقط.');
  purgeExpired(now);
  const p = typeof body.token === 'string' ? pending.get(body.token) : undefined;
  if (!p || p.kind !== 'register') throw new Error('انتهت مهلة التسجيل أو استُخدمت. ابدأ من جديد.');
  pending.delete(body.token);
  const origin = expectedOrigin(port);
  // 1) الإنشاء
  verifyClientData(b64('clientDataJSON', body.clientDataJSON), { type: 'webauthn.create', challenge: body.token, origin });
  const att = decodeCbor(b64('attestationObject', body.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('attestationObject غير صالح.');
  const created = parseAuthenticatorData(att.get('authData') as Buffer);
  verifyAuthDataFlags(created);
  if (!created.credentialId || !created.publicKeyCose) throw new Error('لم يُرسل المتصفح مفتاح الـ Passkey.');
  const { key, alg } = coseToPublicKey(created.publicKeyCose);
  const publicKeyPem = key.export({ type: 'spki', format: 'pem' }).toString();
  // 2) أول دخول بالمفتاح نفسه (يثبت امتلاكه، ويعطي سرّ PRF)
  const a = body.assertion ?? ({} as RegistrationResponse['assertion']);
  if (!b64('credentialId', a.credentialId).equals(created.credentialId)) throw new Error('الدخول الأول بمفتاح آخر غير الذي أُنشئ.');
  const getClientData = b64('assertion.clientDataJSON', a.clientDataJSON);
  verifyClientData(getClientData, { type: 'webauthn.get', challenge: p.getChallenge!, origin });
  const authData = b64('authenticatorData', a.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  verifyAuthDataFlags(parsed);
  if (!verifyAssertionSignature(publicKeyPem, alg, authData, getClientData, b64('signature', a.signature))) throw new Error('توقيع الـ Passkey غير صحيح.');
  const prf = typeof body.prfOutput === 'string' && body.prfOutput ? b64('prfOutput', body.prfOutput) : Buffer.alloc(0);
  if (prf.length !== 32) throw new Error('هذا الـ Passkey لا يدعم PRF، فلا يمكنه فتح الخزنة. اختر «مدير كلمات المرور في Google» على Windows، أو Touch ID على الماك.');
  // 3) الغلاف المحلي
  const wrapKey = deriveWrapKey(prf, created.credentialId);
  prf.fill(0);
  const credentialId = created.credentialId.toString('base64url');
  const store = readStore(file);
  const entry: LocalPasskey = {
    credentialId,
    label: p.label ?? 'Passkey',
    alg,
    publicKeyPem,
    signCount: parsed.signCount,
    prfSalt: p.prfSalt!,
    wrap: sealWithKey(vault.dataKey, wrapKey),
    wrapFingerprint: commanderWrapFingerprint(vault.vaultFilePath),
    backupEligible: parsed.flags.backupEligible,
    createdAt: new Date(now).toISOString(),
    lastUsedAt: null,
  };
  wrapKey.fill(0);
  writeStore(file, { version: 1, passkeys: [...store.passkeys.filter((x) => x.credentialId !== credentialId), entry] });
  logSystemInfo('Passkeys', `سُجّل Passkey «${entry.label}» على هذا الجهاز (${alg === -7 ? 'ES256' : 'RS256'}${entry.backupEligible ? '، مُزامَن' : ''}).`);
  return { credentialId, label: entry.label, backupEligible: entry.backupEligible };
}

/**
 * Hint بالعربي: بداية الفتح (بلا جلسة): تحدٍّ لمرة واحدة، والمفاتيح المسموحة، وملح PRF لكل منها.
 */
export function beginUnlock(file: string = resolvePasskeyStoreFile(), now: number = Date.now(), vaultFilePath?: string) {
  if (!countUsablePasskeys(file, vaultFilePath)) throw new Error('لا يوجد Passkey مسجّل على هذا الجهاز.');
  purgeExpired(now);
  const challenge = newChallenge();
  pending.set(challenge, { kind: 'unlock', expiresAt: now + CHALLENGE_TTL_MS });
  const passkeys = readStore(file).passkeys;
  return {
    challenge,
    rpId: RP_ID,
    credentials: passkeys.map((p) => ({ id: p.credentialId, prfSalt: p.prfSalt })),
  };
}

/** ما يرسله المتصفح للفتح */
export interface UnlockResponse {
  challenge: string;
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  prfOutput: string;
}

/**
 * Hint بالعربي: إكمال الفتح: التحقق من التوقيع والتحدي والأصل والعدّاد والتحقق من المستخدم، ثم فكّ مفتاح البيانات بسرّ PRF
 *               وفتح الخزنة به. المخرجات: جلسة قائد كاملة. ترمي برسالة عربية عند أي خلل.
 */
export function finishUnlock(port: number, body: UnlockResponse, file: string = resolvePasskeyStoreFile(), now: number = Date.now(), vaultFilePath?: string): UnlockedVault {
  purgeExpired(now);
  const p = typeof body.challenge === 'string' ? pending.get(body.challenge) : undefined;
  if (!p || p.kind !== 'unlock') throw new Error('انتهت مهلة الطلب أو استُخدم. أعد المحاولة.');
  pending.delete(body.challenge);
  if (!countUsablePasskeys(file, vaultFilePath)) throw new Error('لا يوجد Passkey صالح على هذا الجهاز (ربما تغيّرت كلمة المرور الرئيسية). افتح بكلمة المرور ثم سجّل من جديد.');
  const store = readStore(file);
  const idx = store.passkeys.findIndex((x) => x.credentialId === body.credentialId);
  if (idx < 0) throw new Error('هذا الـ Passkey غير مسجّل على هذا الجهاز.');
  const pk = store.passkeys[idx];
  const clientData = b64('clientDataJSON', body.clientDataJSON);
  verifyClientData(clientData, { type: 'webauthn.get', challenge: body.challenge, origin: expectedOrigin(port) });
  const authData = b64('authenticatorData', body.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  verifyAuthDataFlags(parsed);
  if (!verifyAssertionSignature(pk.publicKeyPem, pk.alg, authData, clientData, b64('signature', body.signature))) throw new Error('توقيع الـ Passkey غير صحيح.');
  // العدّاد: إن كان أحدهما غير صفر فيجب أن يزيد (اكتشاف نسخة مستنسخة). الـ Passkeys المُزامَنة تعطي صفراً دائماً.
  if ((parsed.signCount !== 0 || pk.signCount !== 0) && parsed.signCount <= pk.signCount) throw new Error('عدّاد الـ Passkey لم يتقدّم (قد يكون مستنسخاً). استخدم كلمة المرور.');
  const prf = typeof body.prfOutput === 'string' && body.prfOutput ? b64('prfOutput', body.prfOutput) : Buffer.alloc(0);
  if (prf.length !== 32) throw new Error('لم يُرسل سرّ PRF.');
  const wrapKey = deriveWrapKey(prf, Buffer.from(pk.credentialId, 'base64url'));
  prf.fill(0);
  let dataKey: Buffer;
  try {
    dataKey = openWithKey(pk.wrap, wrapKey);
  } catch {
    throw new Error('سرّ الـ Passkey لا يفتح غلاف هذا الجهاز.');
  } finally {
    wrapKey.fill(0);
  }
  const vault = unlockVaultWithDataKey(dataKey, vaultFilePath);
  dataKey.fill(0);
  store.passkeys[idx] = { ...pk, signCount: parsed.signCount, lastUsedAt: new Date(now).toISOString() };
  writeStore(file, store);
  return vault;
}

/**
 * Hint بالعربي: للاختبارات فقط: مسح التحديات المعلّقة.
 */
export function resetPasskeyChallengesForTests(): void {
  pending.clear();
}
