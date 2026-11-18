/**
 * ============================================================================
 * الملف: tests/21-passkeys.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات الدخول بالبصمة أو رمز الجهاز (الإصدار 3.3.0، التصميم «أ» في docs/15 القسم 8):
 *               مصادق برمجي حقيقي في الاختبار (مفاتيح ES256 و RS256 من node:crypto، و PRF = HMAC بسرّ داخلي)،
 *               يبني attestationObject و authenticatorData و clientDataJSON والتوقيع كما يفعل المتصفح.
 *               - CBOR و authenticatorData.
 *               - التسجيل ثم الفتح: الخزنة نفسها، والغلاف لا يكشف مفتاح البيانات.
 *               - الرفض: أصل 127.0.0.1، ومعرّف موقع آخر، وبلا تحقق من المستخدم، وتوقيع مزوّر، وتحدٍّ مكرر أو منتهٍ،
 *                 وسرّ PRF خاطئ، وعدّاد متراجع، و Passkey بلا PRF، وجلسة العائلة.
 *               - تغيير كلمة المرور يُبطل الأغلفة. والأغلفة لا تُزامَن ولا تدخل النسخ.
 *               - المسارات عبر الخادم: التسجيل بكلمة المرور، والفتح بلا جلسة، والتأخير بعد الفشل، والحذف.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import {
  beginRegistration,
  beginUnlock,
  countUsablePasskeys,
  finishRegistration,
  finishUnlock,
  listLocalPasskeys,
  removeLocalPasskey,
  resetPasskeyChallengesForTests,
  resolvePasskeyStoreFile,
} from '../src/features/auth/passkey-store.ts';
import { decodeCbor, parseAuthenticatorData } from '../src/features/auth/webauthn.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createEncryptedSystemBackup, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { readLocalRecords } from '../src/features/sync/records.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { changeMasterPassword, createVault, unlockVault, upsertVaultSecret } from '../src/features/vault/vault-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const PASS = 'Passkeys-Test-Pass-0001';

// ===================== مشفّر CBOR صغير (للاختبار فقط) =====================
type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
function enc(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(enc(k), enc(val));
  return Buffer.concat(parts);
}

// ===================== مصادق برمجي =====================
interface Soft {
  credId: Buffer;
  privateKey: crypto.KeyObject;
  cose: Buffer;
  alg: -7 | -257;
  prfSecret: Buffer | null;
  counter: number;
}
function makeSoft(alg: -7 | -257 = -7, withPrf = true, counter = 0): Soft {
  let cose: Buffer;
  let privateKey: crypto.KeyObject;
  if (alg === -7) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = kp.privateKey;
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    cose = enc(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  } else {
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = kp.privateKey;
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    cose = enc(new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]));
  }
  return { credId: crypto.randomBytes(32), privateKey, cose, alg, prfSecret: withPrf ? crypto.randomBytes(32) : null, counter };
}
function authData(opts: { rpId?: string; uv?: boolean; up?: boolean; counter: number; attested?: Soft }): Buffer {
  const flags = (opts.up === false ? 0 : 0x01) | (opts.uv === false ? 0 : 0x04) | 0x08 | (opts.attested ? 0x40 : 0);
  const base = Buffer.alloc(37);
  crypto.createHash('sha256').update(opts.rpId ?? 'localhost').digest().copy(base, 0);
  base[32] = flags;
  base.writeUInt32BE(opts.counter, 33);
  if (!opts.attested) return base;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(opts.attested.credId.length);
  return Buffer.concat([base, Buffer.alloc(16), len, opts.attested.credId, opts.attested.cose]);
}
function clientData(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}
const u = (b: Buffer): string => b.toString('base64url');
function prfOf(s: Soft, saltB64: string): Buffer {
  return s.prfSecret ? crypto.createHmac('sha256', s.prfSecret).update(Buffer.from(saltB64, 'base64url')).digest() : Buffer.alloc(0);
}
function sign(s: Soft, ad: Buffer, cd: Buffer): Buffer {
  const data = Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]);
  return s.alg === -7 ? crypto.sign('sha256', data, { key: s.privateKey, dsaEncoding: 'der' }) : crypto.sign('sha256', data, s.privateKey);
}
function assertion(s: Soft, challenge: string, origin: string, salt: string, o: { uv?: boolean; rpId?: string; counter?: number; forgeSig?: boolean } = {}) {
  if (o.counter !== undefined) s.counter = o.counter;
  else if (s.counter > 0) s.counter += 1;
  const ad = authData({ rpId: o.rpId, uv: o.uv, counter: s.counter });
  const cd = clientData('webauthn.get', challenge, origin);
  const sig = sign(s, ad, cd);
  if (o.forgeSig) sig[sig.length - 1] ^= 0xff;
  return { credentialId: u(s.credId), authenticatorData: u(ad), clientDataJSON: u(cd), signature: u(sig), prfOutput: u(prfOf(s, salt)) };
}
function registration(s: Soft, opt: ReturnType<typeof beginRegistration>, origin: string, o: { createOrigin?: string; uv?: boolean } = {}) {
  const ad = authData({ counter: s.counter, attested: s, uv: o.uv });
  const att = enc(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const a = assertion(s, opt.getChallenge, origin, opt.prfSalt);
  return {
    token: opt.token,
    attestationObject: u(att),
    clientDataJSON: u(clientData('webauthn.create', opt.createChallenge, o.createOrigin ?? origin)),
    assertion: { credentialId: a.credentialId, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature },
    prfOutput: a.prfOutput,
  };
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات الدخول بالـ Passkeys وإرجاع نتائج الفحص.
 */
export async function runPasskeysTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const base = path.join(config.paths.rootDir, 'passkeys-sim');
  fs.mkdirSync(base, { recursive: true });
  resetPasskeyChallengesForTests();

  // ===================== 1. CBOR و authenticatorData =====================
  const m = decodeCbor(enc(new Map<Cbor, Cbor>([['a', 1], [-2, Buffer.from([1, 2])], [3, [-7, 'x']]]))).value as Map<unknown, unknown>;
  assert.equal(m.get('a'), 1);
  assert.deepEqual(m.get(-2), Buffer.from([1, 2]));
  assert.deepEqual(m.get(3), [-7, 'x']);
  assert.throws(() => decodeCbor(Buffer.from([0x9f, 0x01, 0xff])), /غير محدد/, 'الطول غير المحدد مرفوض');
  assert.throws(() => decodeCbor(Buffer.from([0x58, 0x05, 0x01])), /نهاية/, 'بايتات ناقصة مرفوضة');
  const soft0 = makeSoft();
  const parsed0 = parseAuthenticatorData(authData({ counter: 7, attested: soft0 }));
  assert.equal(parsed0.signCount, 7);
  assert.ok(parsed0.flags.userVerified && parsed0.flags.userPresent && parsed0.flags.backupEligible);
  assert.deepEqual(parsed0.credentialId, soft0.credId);
  assert.deepEqual(parsed0.publicKeyCose, soft0.cose);
  passedChecks.push('اختبار قارئ CBOR و authenticatorData (الخرائط والأعداد السالبة والبايتات، ورفض الطول غير المحدد والبيانات الناقصة، والأعلام والعدّاد ومفتاح COSE) بنجاح.');

  // ===================== 2. التسجيل ثم الفتح =====================
  const vaultPath = path.join(base, 'vault', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const { vault, emergencyRecoveryKey } = createVault(PASS, vaultPath);
  upsertVaultSecret(vault, { id: 'S1', category: 'password', title: 'حساب تجريبي', secretValue: 'value-S1', notesForCommanderAr: '', notesForWifeAr: '' });
  const store = path.join(base, 'passkeys', 'local-passkeys.json');
  const PORT = 4777;
  const ORIGIN = 'http://localhost:4777';
  const soft = makeSoft(-7);
  const reg = beginRegistration(vault, 'لابتوب — مدير Google', store);
  assert.equal(reg.rpId, 'localhost');
  const saved = finishRegistration(vault, PORT, registration(soft, reg, ORIGIN), store);
  assert.equal(saved.label, 'لابتوب — مدير Google');
  assert.equal(saved.backupEligible, true);
  const raw = fs.readFileSync(store, 'utf8');
  assert.ok(!raw.includes(vault.dataKey.toString('hex')) && !raw.includes(vault.dataKey.toString('base64')), 'مفتاح البيانات لا يظهر في الملف');
  assert.equal(countUsablePasskeys(store, vaultPath), 1);
  let ub = beginUnlock(store, Date.now(), vaultPath);
  assert.deepEqual(ub.credentials.map((c) => c.id), [u(soft.credId)]);
  const opened = finishUnlock(PORT, { challenge: ub.challenge, ...assertion(soft, ub.challenge, ORIGIN, ub.credentials[0].prfSalt) }, store, Date.now(), vaultPath);
  assert.equal(opened.unlockedBy, 'commander');
  assert.ok(opened.dataKey.equals(vault.dataKey), 'المفتاح نفسه');
  assert.equal(opened.secrets.find((s) => s.id === 'S1')?.secretValue, 'value-S1');
  assert.ok(opened.familyKey && opened.familyKey.length === 32, 'ومعه المفتاح العائلي');
  assert.ok(listLocalPasskeys(store)[0].lastUsedAt, 'آخر استخدام يُسجَّل');
  // RS256 أيضاً
  const rsa = makeSoft(-257, true, 5);
  finishRegistration(vault, PORT, registration(rsa, beginRegistration(vault, 'RSA', store), ORIGIN), store);
  ub = beginUnlock(store, Date.now(), vaultPath);
  const rsaSalt = ub.credentials.find((c) => c.id === u(rsa.credId))!.prfSalt;
  assert.ok(finishUnlock(PORT, { challenge: ub.challenge, ...assertion(rsa, ub.challenge, ORIGIN, rsaSalt) }, store, Date.now(), vaultPath).dataKey.equals(vault.dataKey));
  passedChecks.push('اختبار التسجيل ثم الفتح بمصادق برمجي (ES256 و RS256، والخزنة نفسها بمفتاحها العائلي، والغلاف لا يكشف مفتاح البيانات) بنجاح.');

  // ===================== 3. الرفض =====================
  const salt0 = (ch: ReturnType<typeof beginUnlock>) => ch.credentials.find((c) => c.id === u(soft.credId))!.prfSalt;
  const tryUnlock = (o: Parameters<typeof assertion>[4] & { origin?: string; saltOverride?: string; reuse?: string; at?: number } = {}) => {
    const ch = beginUnlock(store, Date.now(), vaultPath);
    const challenge = o.reuse ?? ch.challenge;
    return () => finishUnlock(PORT, { challenge, ...assertion(soft, challenge, o.origin ?? ORIGIN, o.saltOverride ?? salt0(ch), o) }, store, o.at ?? Date.now(), vaultPath);
  };
  assert.throws(tryUnlock({ origin: 'http://127.0.0.1:4777' }), /الأصل غير مسموح/, 'أصل 127.0.0.1 مرفوض');
  assert.throws(tryUnlock({ origin: 'http://evil.example' }), /الأصل غير مسموح/);
  assert.throws(tryUnlock({ rpId: 'evil.example' }), /معرّف الموقع/, 'معرّف موقع آخر مرفوض');
  assert.throws(tryUnlock({ uv: false }), /لم يُتحقَّق من المستخدم/, 'بلا تحقق من المستخدم مرفوض');
  assert.throws(tryUnlock({ forgeSig: true }), /التوقيع|توقيع/, 'توقيع مزوّر مرفوض');
  assert.throws(tryUnlock({ saltOverride: u(crypto.randomBytes(32)) }), /لا يفتح غلاف/, 'سرّ PRF خاطئ لا يفتح الغلاف');
  assert.throws(tryUnlock({ at: Date.now() + 6 * 60 * 1000 }), /انتهت مهلة/, 'التحدي المنتهي مرفوض');
  const used = beginUnlock(store, Date.now(), vaultPath);
  finishUnlock(PORT, { challenge: used.challenge, ...assertion(soft, used.challenge, ORIGIN, salt0(used)) }, store, Date.now(), vaultPath);
  assert.throws(() => finishUnlock(PORT, { challenge: used.challenge, ...assertion(soft, used.challenge, ORIGIN, salt0(used)) }, store, Date.now(), vaultPath), /استُخدم/, 'التحدي لمرة واحدة');
  // العدّاد المتراجع (RSA بدأ بـ 5)
  const rc = beginUnlock(store, Date.now(), vaultPath);
  assert.throws(() => finishUnlock(PORT, { challenge: rc.challenge, ...assertion(rsa, rc.challenge, ORIGIN, rc.credentials.find((c) => c.id === u(rsa.credId))!.prfSalt, { counter: 2 }) }, store, Date.now(), vaultPath), /عدّاد/, 'عدّاد متراجع مرفوض');
  // بلا PRF، وأصل خاطئ عند الإنشاء
  const noPrf = makeSoft(-7, false);
  assert.throws(() => finishRegistration(vault, PORT, registration(noPrf, beginRegistration(vault, 'بلا PRF', store), ORIGIN), store), /لا يدعم PRF/, 'Passkey بلا PRF لا يُسجَّل');
  assert.throws(() => finishRegistration(vault, PORT, registration(makeSoft(), beginRegistration(vault, 'x', store), ORIGIN, { createOrigin: 'http://127.0.0.1:4777' }), store), /الأصل/);
  assert.throws(() => finishRegistration(vault, PORT, registration(makeSoft(), beginRegistration(vault, 'x', store), ORIGIN, { uv: false }), store), /لم يُتحقَّق/);
  assert.equal(listLocalPasskeys(store).length, 2, 'المحاولات المرفوضة لم تُسجَّل شيئاً');
  // جلسة العائلة
  assert.throws(() => beginRegistration(unlockVault(emergencyRecoveryKey, vaultPath), 'x', store), /للقائد/, 'جلسة العائلة لا تسجّل');
  passedChecks.push('اختبار الرفض (أصل 127.0.0.1 أو غريب، ومعرّف موقع آخر، وبلا تحقق من المستخدم، وتوقيع مزوّر، وسرّ PRF خاطئ، وتحدٍّ منتهٍ أو مكرر، وعدّاد متراجع، و Passkey بلا PRF، وجلسة العائلة) بنجاح.');

  // ===================== 4. كلمة المرور، والمزامنة، والنسخ =====================
  changeMasterPassword(vault, PASS, 'Passkeys-Test-Pass-0002');
  assert.equal(countUsablePasskeys(store, vaultPath), 0, 'تغيير كلمة المرور يُبطل الأغلفة');
  assert.equal(listLocalPasskeys(store).length, 0, 'وتُحذف من الملف');
  assert.throws(() => beginUnlock(store, Date.now(), vaultPath), /لا يوجد Passkey/);
  // الأغلفة لا تُزامَن ولا تدخل النسخ (على خزنة البيئة المعزولة ومسار المتجر الافتراضي)
  const { vault: shared } = ensureTestVault();
  const sharedSoft = makeSoft();
  finishRegistration(shared, PORT, registration(sharedSoft, beginRegistration(shared, 'بيئة الاختبار'), ORIGIN));
  assert.ok(fs.existsSync(resolvePasskeyStoreFile()));
  const root = config.paths.rootDir;
  const ctx: SyncContext = {
    device: { deviceId: 'id-t', deviceName: 't', platform: 'test' },
    syncRoot: path.join(base, 'Drive'),
    rootDir: root,
    dataDir: path.join(root, 'Second-Brain-System', 'data'),
    vaultFile: shared.vaultFilePath,
    obsidianDir: config.paths.obsidianVaultDir,
    brandingPath: path.join(base, 'none-branding.json'),
    settingsPath: path.join(base, 'none-settings.json'),
  };
  const keys = [...readLocalRecords(ctx, shared).keys()];
  assert.ok(!keys.some((k) => /passkey/i.test(k)), 'لا سجل مزامنة للأغلفة');
  const backup = createEncryptedSystemBackup(shared, { outputDir: path.join(base, 'backups'), extraOutputDir: '' });
  assert.ok(!Object.keys(openEncryptedBackup(backup.backupFilePath, ensureTestVault().masterPassword).filesMap).some((r) => /passkeys/.test(r)), 'الأغلفة ليست في النسخة الاحتياطية');
  assert.equal(removeLocalPasskey(u(sharedSoft.credId)), true);
  passedChecks.push('اختبار الإبطال والعزل (تغيير كلمة المرور يُبطل الأغلفة ويحذفها، والأغلفة لا تُزامَن ولا تدخل النسخ الاحتياطية) بنجاح.');

  // ===================== 5. المسارات =====================
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  const origin = `http://localhost:${port}`;
  try {
    const { masterPassword, emergencyKey } = ensureTestVault();
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/passkeys/status' })).body).count, 0);
    assert.equal((await postJson(port, '/api/passkeys/unlock/begin', {})).status, 404, 'بلا Passkey: لا فتح');
    const login = await postJson(port, '/api/vault/unlock', { key: masterPassword });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await postJson(port, '/api/passkeys/register/begin', { masterPassword: 'wrong-password-123' }, cookie)).status, 400, 'التسجيل يحتاج كلمة المرور الصحيحة');
    const b = JSON.parse((await postJson(port, '/api/passkeys/register/begin', { masterPassword, label: 'عبر الخادم' }, cookie)).body);
    const s = makeSoft();
    const fin = await postJson(port, '/api/passkeys/register/finish', registration(s, b, origin), cookie);
    assert.equal(fin.status, 200, fin.body);
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/passkeys', headers: { Cookie: cookie } })).body).passkeys.length, 1);
    await postJson(port, '/api/vault/lock', {}, cookie);
    resetSessionStateForTests();
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/passkeys/status' })).body).count, 1);
    // فشل: سرّ خاطئ ← 401 ويُحتسب في التأخير
    for (let i = 0; i < 3; i++) {
      const bad = JSON.parse((await postJson(port, '/api/passkeys/unlock/begin', {})).body);
      const badRes = await postJson(port, '/api/passkeys/unlock/finish', { challenge: bad.challenge, ...assertion(s, bad.challenge, origin, u(crypto.randomBytes(32))) });
      assert.equal(badRes.status, 401);
    }
    assert.equal((await postJson(port, '/api/passkeys/unlock/begin', {})).status, 429, 'التأخير بعد 3 محاولات فاشلة يشمل الـ Passkeys');
    resetSessionStateForTests();
    const ok = JSON.parse((await postJson(port, '/api/passkeys/unlock/begin', {})).body);
    const res = await postJson(port, '/api/passkeys/unlock/finish', { challenge: ok.challenge, ...assertion(s, ok.challenge, origin, ok.credentials[0].prfSalt) });
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).unlockedBy, 'commander');
    const pkCookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: pkCookie } })).status, 200, 'الجلسة تعمل');
    assert.equal((await postJson(port, '/api/vault/rotate-emergency-key', { masterPassword: 'wrong-password-123' }, pkCookie)).status !== 200, true, 'الأعمال الحساسة تبقى بكلمة المرور');
    assert.equal((await postJson(port, '/api/passkeys/delete', { credentialId: u(s.credId) }, pkCookie)).status, 200);
    assert.equal(JSON.parse((await rawRequest(port, { path: '/api/passkeys/status' })).body).count, 0);
    resetSessionStateForTests();
    const wife = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
    const wifeCookie = String(wife.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await postJson(port, '/api/passkeys/register/begin', { masterPassword }, wifeCookie)).status, 403, 'العائلة لا تسجّل');
    passedChecks.push('اختبار مسارات الـ Passkeys (التسجيل بكلمة المرور، والفتح بلا جلسة يعطي جلسة قائد، والفشل يُحتسب في التأخير، والأعمال الحساسة تبقى بكلمة المرور، والحذف، والعائلة لا تسجّل) بنجاح.');
  } finally {
    resetSessionStateForTests();
    resetPasskeyChallengesForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  fs.rmSync(base, { recursive: true, force: true });
  return passedChecks;
}
