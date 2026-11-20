/**
 * ============================================================================
 * الملف: tests/28-phase2-security.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: الاختبارات الجامعة للمرحلة 2 (الإصدار 3.9.1، البند 2.8 من docs/12). لا تكرّر فحوص الميزات (18–27)،
 *               بل تفحص ضمانات المرحلة كنظام واحد بعد سيناريو كامل في بيئة معزولة جديدة:
 *               1) جدول الصلاحيات مثبّت: أي مسار جديد مفتوح للعائلة أو بلا جلسة يُفشل الاختبار حتى يُراجَع،
 *                  ثم طلب HTTP حقيقي لكل مسار محمي: بلا جلسة ← 401، وجلسة العائلة ← 403 (ومنه ISS-045).
 *               2) حدود المفاتيح على كل ملف مشفّر في القرص: المفتاح العائلي (ومفتاح الطوارئ) لا يصل إلى أي شيء
 *                  للقائد، ومفتاح الطوارئ لا يفك إلا المفتاح العائلي، والفحص غير فارغ (يجد علامات القائد بمفتاحه).
 *               3) لا نص صريح لأي سرّ في أي ملف: قيم الخزنة، وسرّ المصادقة الثنائية ورموزها الاحتياطية،
 *                  وكلمة المرور، ومفتاح الطوارئ، والمفاتيح نفسها، ونصوص المحادثات وسجل الطوارئ.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { openWithKey, unwrapDataKey } from '../src/core/crypto-engine.ts';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { beginTwoFactorSetup, finishTwoFactorSetup } from '../src/features/auth/two-factor.ts';
import { appendConversationTurn } from '../src/features/conversations/conversation-store.ts';
import { buildRouteTable, matchRoute, startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createEncryptedSystemBackup } from '../src/features/family-emergency/backup-service.ts';
import { appendFamilyLog } from '../src/features/family-emergency/family-portal.ts';
import { runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { unlockVault, upsertVaultSecret } from '../src/features/vault/vault-manager.ts';
import { base32Decode, totp } from '../src/shared/totp.ts';
import type { RouteDefinition } from '../src/features/dashboard-app/http-utils.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, setupIsolatedTestEnvironment, writeFixtureFile } from './test-environment.ts';

/**
 * المسارات المسموحة بلا جلسة. كل إضافة هنا قرار أمني: لماذا لا تحتاج الخزنة؟
 * - الواجهة والحالة والصحة، وفتح الخزنة وإنشاؤها وقفلها، والفتح بالـ Passkey.
 * - محمية بكلمة المرور داخلها: الإعدادات والصيانة (assertSettingsAuth)، والاستعادة والتمرين (المفتاح في الطلب).
 * - صفحات الطباعة لمرة واحدة برمز عشوائي 48 حرفاً.
 * - المساعد وفحص المشاريع والصوت يعملون بلا خزنة بلا أسرار (بيانات المشاريع العامة فقط).
 */
const PUBLIC_ROUTES = [
  'GET /', 'GET RE:assets', 'GET /api/state', 'GET /api/health',
  'POST /api/settings/auth', 'POST /api/settings/lock', 'GET /api/settings', 'POST /api/settings',
  'GET /api/vault/status', 'POST /api/vault/setup', 'POST /api/vault/unlock', 'POST /api/vault/lock',
  'POST /api/projects/rescan', 'GET RE:project',
  'POST /api/assistant', 'POST /api/assistant/stream', 'GET /api/assistant/providers',
  'GET RE:emergency-kit-print', 'GET /api/emergency/backups', 'POST /api/emergency/restore', 'POST /api/emergency/restore-drill',
  'GET /api/passkeys/status', 'POST /api/passkeys/unlock/begin', 'POST /api/passkeys/unlock/finish', 'GET RE:two-factor-print',
  'GET /api/maintenance', 'POST /api/maintenance/reset', 'POST /api/maintenance/restore-last', 'POST /api/maintenance/empty-trash', 'POST /api/maintenance/finalize',
  'GET /api/tts/status', 'POST /api/tts', 'GET /api/sync/status',
];

/** ما تصل إليه جلسة العائلة (مفتاح الطوارئ). كل إضافة هنا قرار: هل تحتاجه الزوجة في الطوارئ؟ */
const FAMILY_ROUTES = [
  'GET /api/vault/secrets', 'POST /api/emergency/backup', 'GET /api/family/portal', 'POST /api/family/log',
  'GET /api/conversations', 'GET RE:conversation', 'POST RE:conversation-delete', 'POST /api/conversations/delete-all',
];

/** أسماء ثابتة للمسارات ذات التعبير النمطي (حتى يبقى الجدول مقروءاً) */
const REGEX_NAMES: Array<[RegExp, string]> = [
  [/assets/, 'assets'],
  [/emergency-kit\\\/print/, 'emergency-kit-print'],
  [/two-factor\\\/print/, 'two-factor-print'],
  [/conversations\\\/\(.*\)\\\/delete\$$/, 'conversation-delete'],
  [/^\^\\\/api\\\/conversations\\\/\([^)]*\)\$$/, 'conversation'],
  [/^\^\\\/api\\\/projects\\\/\([^)]*\)\$$/, 'project'],
];

function routeKey(r: RouteDefinition): string {
  if (typeof r.path === 'string') return `${r.method} ${r.path}`;
  const named = REGEX_NAMES.find(([re]) => re.test(r.path instanceof RegExp ? r.path.source : ''));
  return `${r.method} RE:${named ? named[1] : r.path.source}`;
}

/** مسار مثال يطابق التعبير النمطي (معرّف بحروف وأرقام) */
function samplePath(r: RouteDefinition): string {
  if (typeof r.path === 'string') return r.path;
  if (r.path.source.includes('assets')) return '/assets/app.js';
  const sample = r.path.source
    .replace(/^\^|\$$/g, '')
    .replace(/\((?:\[[^\]]*\]|[^()])*\)/g, (g) => (g.includes('0-9a-f]{48}') ? 'a'.repeat(48) : 'abcd1234'))
    .replace(/\\\//g, '/');
  return sample;
}

/** كل كائن مختوم (ivHex و authTagHex و cipherTextHex) داخل JSON */
function findSealed(node: unknown, where: string, out: Array<{ where: string; sealed: { ivHex: string; authTagHex: string; cipherTextHex: string; saltHex?: string; kdf?: unknown } }>): void {
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o.ivHex === 'string' && typeof o.authTagHex === 'string' && typeof o.cipherTextHex === 'string') {
    out.push({ where, sealed: o as never });
    return;
  }
  for (const [k, v] of Object.entries(o)) findSealed(v, `${where}.${k}`, out);
}

function tryOpen(sealed: { ivHex: string; authTagHex: string; cipherTextHex: string }, key: Buffer): Buffer | null {
  try {
    return openWithKey(sealed, key);
  } catch {
    return null;
  }
}

/** نص قابل للبحث من محتوى مفكوك (مضغوط gzip أو نص) */
function asText(buf: Buffer): string {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf).toString('utf8');
    } catch {
      // ليس gzip
    }
  }
  return buf.toString('utf8');
}

/**
 * Hint بالعربي: يفك كل ما يمكن فكه بالمفاتيح المعطاة، ثم ما بداخله (ختم داخل ختم)، ويعيد النصوص المفكوكة.
 */
function reachableWith(files: Array<{ rel: string; json: unknown }>, keys: Buffer[]): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const queue: Array<{ where: string; node: unknown; depth: number }> = files.map((f) => ({ where: f.rel, node: f.json, depth: 0 }));
  while (queue.length) {
    const { where, node, depth } = queue.shift()!;
    const sealedList: Parameters<typeof findSealed>[2] = [];
    findSealed(node, where, sealedList);
    for (const s of sealedList) {
      if (s.sealed.saltHex) continue; // غلاف مفتاح بكلمة سر (يُفحص وحده)
      for (const key of keys) {
        const plain = tryOpen(s.sealed, key);
        if (!plain) continue;
        const text = asText(plain);
        out.push({ where: s.where, text });
        if (depth < 4) {
          try {
            queue.push({ where: s.where, node: JSON.parse(text), depth: depth + 1 });
          } catch {
            // ليس JSON
          }
        }
        break;
      }
    }
  }
  return out;
}

function listAllFiles(dir: string, skip: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full, skip));
    else out.push(full);
  }
  return out;
}

/**
 * Hint بالعربي: دالة تشغيل الاختبارات الجامعة للمرحلة 2 وإرجاع نتائج الفحص.
 */
export async function runPhase2SecurityTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // ===================== 1. جدول الصلاحيات مثبّت =====================
  const table = buildRouteTable();
  const actualPublic = table.filter((r) => !r.requiresSession && !r.commanderOnly).map(routeKey).sort();
  const actualFamily = table.filter((r) => r.requiresSession && !r.commanderOnly).map(routeKey).sort();
  assert.deepEqual(actualPublic, [...PUBLIC_ROUTES].sort(), 'المسارات بلا جلسة تغيّرت: راجع القرار الأمني ثم حدّث PUBLIC_ROUTES');
  assert.deepEqual(actualFamily, [...FAMILY_ROUTES].sort(), 'مسارات العائلة تغيّرت: راجع القرار الأمني ثم حدّث FAMILY_ROUTES');
  const keys = table.map(routeKey);
  assert.equal(new Set(keys).size, keys.length, 'لا مساران بالمفتاح نفسه');
  const protectedRoutes = table.filter((r) => r.requiresSession || r.commanderOnly);
  const commanderRoutes = table.filter((r) => r.commanderOnly);
  for (const r of table) {
    const m = matchRoute(table, r.method, samplePath(r));
    assert.ok(m && 'route' in m && m.route === r, `المسار المثال يطابق مساره: ${routeKey(r)} ← ${samplePath(r)}`);
  }
  passedChecks.push(`اختبار جدول الصلاحيات المثبّت (${table.length} مساراً: ${actualPublic.length} بلا جلسة، و ${actualFamily.length} للعائلة، و ${commanderRoutes.length} للقائد فقط؛ أي تغيير فيه يُفشل الاختبار حتى يُراجَع) بنجاح.`);

  // ===================== 2. سيناريو كامل في بيئة معزولة جديدة =====================
  const env = setupIsolatedTestEnvironment();
  resetSessionStateForTests();
  const marks = {
    commanderSecret: `CMDR-${crypto.randomBytes(12).toString('hex')}`,
    familySecret: `FAM-${crypto.randomBytes(12).toString('hex')}`,
    commanderChat: `CHATC-${crypto.randomBytes(8).toString('hex')}`,
    familyChat: `CHATF-${crypto.randomBytes(8).toString('hex')}`,
    familyLog: `FLOG-${crypto.randomBytes(8).toString('hex')}`,
  };
  try {
    const config = loadSystemConfig();
    const { vault, emergencyKey, masterPassword } = ensureTestVault();
    assert.ok(vault.familyKey && vault.familyKey.length === 32, 'الخزنة الجديدة v3 بمفتاح عائلي');
    upsertVaultSecret(vault, { id: 'cmdr-api', category: 'api_key', title: 'مفتاح القائد', secretValue: marks.commanderSecret, notesForCommanderAr: 'للقائد', notesForWifeAr: '' } as never);
    upsertVaultSecret(vault, { id: 'fam-host', category: 'password', title: 'الاستضافة', secretValue: marks.familySecret, notesForCommanderAr: '', notesForWifeAr: 'للعائلة', familyVisible: true } as never);

    // المصادقة الثنائية
    const setup = beginTwoFactorSetup(vault, 'phase2-test');
    const totpSecret = setup.secretBase32.replace(/\s+/g, '');
    const backupCodes = finishTwoFactorSetup(vault, totp(base32Decode(totpSecret), Date.now()));
    assert.equal(backupCodes.length, 10);

    // المحادثات وسجل الطوارئ
    appendConversationTurn(vault, { mode: 'commander', question: `سؤال القائد ${marks.commanderChat}`, answer: 'رد' });
    const familyVault = unlockVault(emergencyKey);
    assert.equal(familyVault.unlockedBy, 'wife_emergency');
    appendConversationTurn(familyVault, { mode: 'family', question: `سؤال العائلة ${marks.familyChat}`, answer: 'رد' });
    appendFamilyLog(familyVault, { action: 'note', detailAr: `ملاحظة ${marks.familyLog}`, actor: 'family' });

    // نسخة احتياطية ومزامنة
    createEncryptedSystemBackup(vault);
    const syncRoot = path.join(env.rootDir, 'fake-drive', 'Second-Brain-Sync');
    fs.mkdirSync(syncRoot, { recursive: true });
    const settingsPath = path.join(env.rootDir, 'config', 'settings.json');
    if (!fs.existsSync(settingsPath)) writeFixtureFile(settingsPath, JSON.stringify({ watchedProjects: [] }));
    const ctx: SyncContext = {
      device: { deviceId: 'id-phase2', deviceName: 'phase2', platform: 'test' },
      syncRoot,
      rootDir: env.rootDir,
      dataDir: path.join(env.rootDir, 'Second-Brain-System', 'data'),
      vaultFile: config.paths.encryptedVaultFile,
      obsidianDir: config.paths.obsidianVaultDir,
      brandingPath: path.join(env.rootDir, 'config', 'branding.json'),
      settingsPath,
    };
    const cycle = runSyncCycle(ctx, vault, { now: Date.now() });
    assert.ok(cycle.published > 0 || cycle.migrated, `المزامنة نشرت سجلات: ${JSON.stringify(cycle)}`);

    // ===================== 3. HTTP: كل مسار محمي =====================
    const server = await startSecondBrainDesktopServer(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const send = (r: RouteDefinition, cookie?: string) =>
        r.method === 'GET'
          ? rawRequest(port, { path: samplePath(r), headers: cookie ? { Cookie: cookie } : {} })
          : postJson(port, samplePath(r), {}, cookie);

      for (const r of protectedRoutes) {
        const res = await send(r);
        assert.equal(res.status, 401, `بلا جلسة يُرفض: ${routeKey(r)} ← ${res.status} ${res.body.slice(0, 120)}`);
      }

      // كلمة المرور وحدها لا تكفي، ومفتاح الطوارئ لا يحتاج رمزاً
      const noCode = await postJson(port, '/api/vault/unlock', { key: masterPassword });
      assert.equal(noCode.status, 401);
      assert.equal(JSON.parse(noCode.body).twoFactorRequired, true);
      const fam = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
      assert.equal(fam.status, 200, fam.body);
      const familyCookie = String(fam.headers['set-cookie'] ?? '').split(';')[0];

      for (const r of commanderRoutes) {
        const res = await send(r, familyCookie);
        assert.equal(res.status, 403, `جلسة العائلة تُرفض: ${routeKey(r)} ← ${res.status} ${res.body.slice(0, 120)}`);
      }
      const famSecrets = await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: familyCookie } });
      assert.equal(famSecrets.status, 200);
      assert.ok(!famSecrets.body.includes(marks.commanderSecret) && !famSecrets.body.includes('cmdr-api'), 'العائلة لا ترى سرّ القائد');
      assert.ok(famSecrets.body.includes('fam-host'), 'العائلة ترى المعلَّم لها');
      const famConvs = await rawRequest(port, { path: '/api/conversations', headers: { Cookie: familyCookie } });
      assert.ok(!famConvs.body.includes('سؤال القائد'), 'العائلة لا ترى محادثة القائد');

      const withCode = await postJson(port, '/api/vault/unlock', { key: masterPassword, twoFactorCode: backupCodes[0] });
      assert.equal(withCode.status, 200, withCode.body);
      passedChecks.push(`اختبار كل مسار محمي عبر HTTP حقيقي (${protectedRoutes.length} مساراً بلا جلسة ← 401، ومنها مسارات «للقائد فقط» الأربعة في ISS-045؛ و ${commanderRoutes.length} مساراً بجلسة العائلة ← 403؛ والعائلة لا ترى سرّ القائد ولا محادثته؛ وكلمة المرور وحدها لا تفتح مع المصادقة الثنائية، ومفتاح الطوارئ بلا رمز) بنجاح.`);
    } finally {
      resetSessionStateForTests();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // ===================== 4. حدود المفاتيح على كل ملف مشفّر =====================
    const allFiles = listAllFiles(env.rootDir, new Set(['fixtures']));
    const jsonFiles: Array<{ rel: string; json: unknown }> = [];
    for (const f of allFiles) {
      try {
        jsonFiles.push({ rel: path.relative(env.rootDir, f), json: JSON.parse(fs.readFileSync(f, 'utf8')) });
      } catch {
        // ليس JSON
      }
    }
    const dek = vault.dataKey;
    const fk = vault.familyKey!;
    const byFamily = reachableWith(jsonFiles, [fk]);
    const byCommander = reachableWith(jsonFiles, [dek, fk]);
    const commanderOnlyMarks = [marks.commanderSecret, marks.commanderChat, dek.toString('hex'), totpSecret, 'cmdr-api'];
    for (const r of byFamily) {
      for (const m of commanderOnlyMarks) assert.ok(!r.text.includes(m), `المفتاح العائلي وصل إلى شيء للقائد في ${r.where}`);
    }
    const famText = byFamily.map((r) => r.text).join('\n');
    for (const m of [marks.familySecret, marks.familyChat, marks.familyLog]) assert.ok(famText.includes(m), `المفتاح العائلي يفتح ما للعائلة (${m.slice(0, 5)})`);
    const cmdText = byCommander.map((r) => r.text).join('\n');
    for (const m of [marks.commanderSecret, marks.commanderChat, marks.familySecret]) assert.ok(cmdText.includes(m), `الفحص غير فارغ: مفتاح القائد يجد ${m.slice(0, 5)}`);
    const familyFiles = new Set(byFamily.map((r) => r.where.split('.')[0]));
    assert.ok([...familyFiles].some((f) => /sync|Second-Brain-Sync/.test(f)) || [...familyFiles].some((f) => /backup/i.test(f)), 'المفتاح العائلي يفتح النسخة أو المزامنة العائلية');

    // أغلفة المفاتيح: مفتاح الطوارئ لا يفك إلا المفتاح العائلي
    const wraps: Parameters<typeof findSealed>[2] = [];
    for (const f of jsonFiles) findSealed(f.json, f.rel, wraps);
    let emergencyOpened = 0;
    let passwordOpened = 0;
    for (const w of wraps.filter((x) => x.sealed.saltHex)) {
      try {
        const k = unwrapDataKey(w.sealed as never, emergencyKey);
        assert.ok(k.equals(fk) && !k.equals(dek), `مفتاح الطوارئ فكّ غير المفتاح العائلي في ${w.where}`);
        emergencyOpened++;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
      }
      try {
        unwrapDataKey(w.sealed as never, masterPassword);
        passwordOpened++;
      } catch {
        // غلاف آخر
      }
    }
    assert.ok(emergencyOpened >= 1 && passwordOpened >= 1, `الأغلفة مفحوصة فعلاً (الطوارئ ${emergencyOpened}، وكلمة المرور ${passwordOpened})`);
    passedChecks.push(`اختبار حدود المفاتيح على كل ملف مشفّر في القرص (${jsonFiles.length} ملف JSON، و ${byCommander.length} ختماً يفكه القائد، و ${byFamily.length} يفكه المفتاح العائلي ولا شيء منها للقائد؛ و ${emergencyOpened} غلافاً يفكه مفتاح الطوارئ وكلها المفتاح العائلي، لا مفتاح البيانات أبداً) بنجاح.`);

    // ===================== 5. لا نص صريح لأي سرّ =====================
    const forbidden: Array<[string, string]> = [
      ['سرّ القائد', marks.commanderSecret],
      ['سرّ العائلة', marks.familySecret],
      ['محادثة القائد', marks.commanderChat],
      ['محادثة العائلة', marks.familyChat],
      ['سجل الطوارئ', marks.familyLog],
      ['سرّ المصادقة الثنائية', totpSecret],
      ['كلمة المرور', masterPassword],
      ['مفتاح الطوارئ', emergencyKey],
      ['مفتاح البيانات (hex)', dek.toString('hex')],
      ['مفتاح البيانات (base64)', dek.toString('base64')],
      ['المفتاح العائلي (hex)', fk.toString('hex')],
      ...backupCodes.map((c, i): [string, string] => [`رمز احتياطي ${i + 1}`, c]),
    ];
    let scannedBytes = 0;
    for (const f of allFiles) {
      const buf = fs.readFileSync(f);
      scannedBytes += buf.length;
      const text = buf.toString('utf8');
      for (const [label, value] of forbidden) assert.ok(!text.includes(value), `${label} بنص صريح في ${path.relative(env.rootDir, f)}`);
    }
    passedChecks.push(`اختبار لا نص صريح لأي سرّ في القرص (${allFiles.length} ملفاً، ${Math.round(scannedBytes / 1024)}KB، تشمل الخزنة والمحادثات والنسخ والمزامنة والسجلات: ${forbidden.length} قيمة ممنوعة، ومنها سرّ المصادقة الثنائية والرموز الاحتياطية العشرة والمفاتيح نفسها) بنجاح.`);
  } finally {
    resetSessionStateForTests();
    env.restore();
  }

  return passedChecks;
}
