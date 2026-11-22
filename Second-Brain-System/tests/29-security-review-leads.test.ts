/**
 * ============================================================================
 * الملف: tests/29-security-review-leads.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات خيوط المراجعة الأمنية المستقلة للمرحلة 2 (2.9، ISS-046..ISS-053).
 *               كل خيط يُعاد إنتاجه هنا في البيئة المعزولة: إن فشل الفحص قبل الإصلاح صار الخلل مثبتاً،
 *               ويبقى الفحص بعد الإصلاح اختبار انحدار دائماً.
 *               - ISS-046: فحص صلاحيات مجلد البرنامج (مجلد حقيقي يُفتح للحسابات الأخرى ثم يُغلق)، وتحذير /api/health،
 *                 وإعادة فحص مسار Claude Code وعنوان Ollama عند تحميل الإعدادات.
 *               - ISS-047: فتح الإعدادات بكلمة المرور لا يمنح جلسة قائد بلا الرمز الثاني حين تكون 2FA مفعّلة.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, normalizeSystemConfig } from '../src/core/config-manager.ts';
import { checkFolderPermissions, findBroadWindowsWriters, getFolderPermissionStatus, resetFolderPermissionStatusForTests, runStartupFolderPermissionCheck } from '../src/core/folder-permissions.ts';
import { beginTwoFactorSetup, disableTwoFactor, finishTwoFactorSetup, readTwoFactor, resetTwoFactorPendingForTests } from '../src/features/auth/two-factor.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createVault, readVaultFile, rotateEmergencyKey, unlockVault, upsertVaultSecret, type VaultFileV3 } from '../src/features/vault/vault-manager.ts';
import { normalizeEmergencyKey, openWithKey, unwrapDataKey } from '../src/core/crypto-engine.ts';
import { appendConversationTurn, getConversation, resealFamilyConversations, resolveConversationsDir } from '../src/features/conversations/conversation-store.ts';
import { appendFamilyLog, readFamilyLog, resealFamilyLog } from '../src/features/family-emergency/family-portal.ts';
import { createEncryptedSystemBackup, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { listOldFullAccessCopies } from '../src/features/family-emergency/old-copies.ts';
import { base32Decode, totp } from '../src/shared/totp.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, replaceTestEmergencyKey, writeFixtureFile } from './test-environment.ts';
import { runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';

const cookieOf = (headers: Record<string, unknown>): string => String(headers['set-cookie'] ?? '').split(';')[0];

/**
 * Hint بالعربي: ISS-047 — مسار /api/settings/auth كان يفتح جلسة قائد بكلمة المرور وحدها رغم تفعيل 2FA.
 */
async function checkSettingsAuthSecondFactor(passedChecks: string[]): Promise<void> {
  resetSessionStateForTests();
  resetTwoFactorPendingForTests();
  const { vault, masterPassword, emergencyKey } = ensureTestVault();
  const now = Date.now();
  const setup = beginTwoFactorSetup(vault, 'Test', now - 60_000);
  const secret = base32Decode(setup.secretBase32);
  const codes = finishTwoFactorSetup(vault, totp(secret, now - 60_000), now - 60_000);
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // 1. بلا جلسة: كلمة المرور وحدها لا تكفي، ولا كوكي جلسة
    const bare = await postJson(port, '/api/settings/auth', { password: masterPassword });
    assert.equal(bare.status, 401, `ISS-047: كلمة المرور وحدها فتحت جلسة قائد (${bare.status})`);
    assert.equal(JSON.parse(bare.body).twoFactorRequired, true);
    assert.equal(bare.headers['set-cookie'], undefined, 'ISS-047: لا جلسة بلا الرمز الثاني');
    // ولا يمكن تعطيل 2FA عبر هذا الباب
    assert.equal((await postJson(port, '/api/2fa/disable', { masterPassword })).status, 401);
    // 2. رمز خاطئ مرفوض ويُحتسب فشلاً
    const wrong = await postJson(port, '/api/settings/auth', { password: masterPassword, twoFactorCode: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    resetSessionStateForTests();
    // 3. من جلسة عائلية: الترقية إلى القائد تطلب الرمز أيضاً
    const family = cookieOf((await postJson(port, '/api/vault/unlock', { key: emergencyKey })).headers);
    const fromFamily = await postJson(port, '/api/settings/auth', { password: masterPassword }, family);
    assert.equal(fromFamily.status, 401, 'ISS-047: جلسة العائلة ترقّت إلى القائد بكلمة المرور وحدها');
    // 4. مع رمز احتياطي صحيح: تُفتح جلسة قائد والإعدادات
    const ok = await postJson(port, '/api/settings/auth', { password: masterPassword, twoFactorCode: codes[0] });
    assert.equal(ok.status, 200, ok.body);
    const commander = cookieOf(ok.headers);
    assert.ok(commander, 'جلسة جديدة');
    assert.equal((await rawRequest(port, { path: '/api/settings', headers: { Cookie: commander } })).status, 200);
    // 5. جلسة قائد قائمة (فُتحت بالعاملين): إعادة التأكيد بكلمة المرور وحدها كافية، ولا جلسة جديدة
    await postJson(port, '/api/settings/lock', {}, commander);
    const reconfirm = await postJson(port, '/api/settings/auth', { password: masterPassword }, commander);
    assert.equal(reconfirm.status, 200, reconfirm.body);
    assert.equal(reconfirm.headers['set-cookie'], undefined, 'لا جلسة جديدة عند إعادة التأكيد');
    passedChecks.push('ISS-047: فتح الإعدادات بكلمة المرور لا يمنح جلسة قائد بلا الرمز الثاني (بلا جلسة، ومن جلسة العائلة، والرمز الخاطئ مرفوض)، والرمز الاحتياطي يعمل، وإعادة التأكيد داخل جلسة القائد بكلمة المرور وحدها.');
  } finally {
    try {
      const v = unlockVault(masterPassword);
      if (readTwoFactor(v)) disableTwoFactor(v);
    } catch {
      // لا شيء
    }
    resetSessionStateForTests();
    resetTwoFactorPendingForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Hint بالعربي: ISS-046 — مجلد البرنامج كان يرث صلاحية «تعديل لكل مستخدم مسجّل» من القرص بلا أي تحذير،
 *               ومسار Claude Code وعنوان Ollama يُقبلان من ملف الإعدادات بلا فحص عند التحميل.
 */
async function checkFolderPermissionLead(passedChecks: string[]): Promise<void> {
  // 1. تحليل أسطر Windows (بالمعرّفات، فلا تتأثر بلغة النظام)
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-11|1245631|Allow', 'S-1-5-32-545|1179817|Allow', 'S-1-5-18|2032127|Allow']), ['Authenticated Users'], 'Modify لـ Authenticated Users مفتوح، و RX لـ Users ليس كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-32-545|-1610612736|Allow']), [], 'GENERIC_READ|GENERIC_EXECUTE (الموروث IO) ليس كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-1-0|1073741824|Allow']), ['Everyone'], 'GENERIC_WRITE كتابة');
  assert.deepEqual(findBroadWindowsWriters(['S-1-1-0|2032127|Deny']), [], 'سطر المنع لا يُحتسب');
  assert.deepEqual(findBroadWindowsWriters(['S-1-5-21-1-2-3-1001|2032127|Allow', 'S-1-5-32-544|2032127|Allow']), [], 'صاحب المجلد و Administrators ليسا حسابات عامة');

  // 2. مجلد حقيقي على هذا الجهاز: مغلق ← ثم يُفتح للحسابات الأخرى ← يُكشف
  const dir = path.join(loadSystemConfig().paths.rootDir, 'perm-sim');
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (process.platform === 'win32') {
      // مجلد الاختبار المؤقت داخل ملف المستخدم: موروث لصاحبه و SYSTEM و Administrators فقط
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore' });
      const closed = checkFolderPermissions(dir);
      assert.equal(closed.checked, true, closed.detailAr);
      assert.equal(closed.open, false, `مجلد مغلق كُشف مفتوحاً: ${closed.broadWriters.join(',')}`);
      execFileSync('icacls', [dir, '/grant', '*S-1-5-11:(OI)(CI)M'], { stdio: 'ignore' });
    } else {
      fs.chmodSync(dir, 0o700);
      assert.equal(checkFolderPermissions(dir).open, false);
      fs.chmodSync(dir, 0o777);
    }
    const open = checkFolderPermissions(dir);
    assert.equal(open.open, true, 'ISS-046: المجلد المفتوح للحسابات الأخرى لم يُكشف');
    assert.match(open.detailAr, /ISS-046/);
    // فشل القراءة لا يرمي ولا يدّعي الأمان
    const failed = checkFolderPermissions(dir, () => {
      throw new Error('x');
    });
    if (process.platform === 'win32') assert.equal(failed.checked, false);

    // 3. /api/health يحمل التحذير بعد فحص بدء الخادم، ولا يحمله قبل الفحص
    assert.equal(getFolderPermissionStatus(), null, 'لا فحص في الاختبارات إلا بطلب');
    runStartupFolderPermissionCheck(dir);
    const server = await startSecondBrainDesktopServer(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const health = JSON.parse((await rawRequest(port, { path: '/api/health' })).body) as { folderPermissions: { open: boolean; detailAr: string } | null };
      assert.equal(health.folderPermissions?.open, true, '/api/health يحمل التحذير');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    resetFolderPermissionStatusForTests();
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4. إعادة الفحص عند التحميل: ملف الإعدادات قد يُعدَّل خارج الواجهة
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const absExe = path.join(path.parse(process.cwd()).root, 'tools', exe);
  const load = (ai: Record<string, unknown>) => normalizeSystemConfig({ aiConfig: ai });
  const planted = load({ claudeCliPath: path.join(path.parse(process.cwd()).root, 'Users', 'Public', 'evil.exe'), ollamaEndpoint: 'http://evil.example:11434' });
  assert.equal(planted.config.aiConfig.claudeCliPath, '', 'ISS-046: برنامج مزروع باسم آخر لا يُشغَّل كـ Claude Code');
  assert.equal(planted.config.aiConfig.ollamaEndpoint, 'http://127.0.0.1:11434', 'ISS-046: عنوان Ollama خارجي لا يُقبل من الملف');
  assert.equal(planted.warnings.length, 2, planted.warnings.join(' | '));
  assert.equal(load({ claudeCliPath: `relative/${exe}` }).config.aiConfig.claudeCliPath, '', 'مسار نسبي مرفوض');
  assert.equal(load({ claudeCliPath: absExe }).config.aiConfig.claudeCliPath, absExe, 'المسار الصحيح يبقى');
  assert.equal(load({ ollamaEndpoint: 'http://localhost:11500/x' }).config.aiConfig.ollamaEndpoint, 'http://localhost:11500');
  assert.equal(load({ ollamaEndpoint: 'https://127.0.0.1:11434' }).config.aiConfig.ollamaEndpoint, 'http://127.0.0.1:11434', 'https مرفوض كما في مسار الحفظ');

  passedChecks.push('ISS-046: فحص صلاحيات مجلد البرنامج (أقنعة NTFS بالمعرّفات، ومجلد حقيقي مغلق ثم مفتوح للحسابات الأخرى يُكشف، وفشل القراءة لا يدّعي الأمان)، وتحذير /api/health، وإعادة فحص مسار Claude Code وعنوان Ollama عند تحميل الإعدادات.');
}

/**
 * Hint بالعربي: ISS-048 — تدوير مفتاح الطوارئ كان يعيد لفّ المفتاح العائلي نفسه (FK). فالمفتاح القديم مع أي
 *               نسخة قديمة (.bak-N، نسخة طوارئ، لقطة مزامنة) يفكّ FK ويفتح الخزنة العائلية الحالية وكل ما يُكتب بعدها.
 */
async function checkEmergencyRotationRotatesFamilyKey(passedChecks: string[]): Promise<void> {
  const base = path.join(loadSystemConfig().paths.rootDir, 'rotate-fk-sim');
  const vaultPath = path.join(base, 'vault', 'vault.aes256.json');
  const logDir = path.join(base, 'family-log');
  const backupDir = path.join(base, 'backups');
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const PASS = 'Rotate-Family-Key-Pass-01';
  const { vault, emergencyRecoveryKey: oldKey } = createVault(PASS, vaultPath);
  upsertVaultSecret(vault, { id: 'FAM1', category: 'password', title: 'عائلي قبل التدوير', secretValue: 'before-rotation', notesForCommanderAr: '', notesForWifeAr: '', familyVisible: true });
  const familyConv = appendConversationTurn(vault, { mode: 'family', question: 'سؤال عائلي قبل التدوير', answer: 'جواب' });
  appendFamilyLog(vault, { action: 'family_unlock' }, logDir);
  const oldBackup = createEncryptedSystemBackup(vault, { outputDir: backupDir, extraOutputDir: '' });
  try {
    const oldFile = readVaultFile(vaultPath) as VaultFileV3;
    const oldFk = unwrapDataKey(oldFile.family.fkByEmergency, normalizeEmergencyKey(oldKey));

    const rotated = rotateEmergencyKey(vault, PASS);
    const newKey = rotated.emergencyRecoveryKey;
    resealFamilyConversations(vault, undefined, rotated.previousFamilyKey);
    resealFamilyLog(vault, rotated.previousFamilyKey, logDir);
    upsertVaultSecret(vault, { id: 'FAM2', category: 'password', title: 'عائلي بعد التدوير', secretValue: 'after-rotation', notesForCommanderAr: '', notesForWifeAr: '', familyVisible: true });

    // 1. جوهر الخيط: FK القديم (من .bak-1 أو النسخة القديمة) لا يفتح القسم العائلي الحالي
    const current = readVaultFile(vaultPath) as VaultFileV3;
    assert.ok(fs.existsSync(`${vaultPath}.bak-1`), 'النسخة السابقة موجودة (هي مصدر الخطر)');
    assert.throws(() => openWithKey(current.family.data, oldFk), 'ISS-048: المفتاح العائلي القديم ما زال يفتح الخزنة العائلية الحالية');
    assert.throws(() => unlockVault(oldKey, vaultPath), 'المفتاح القديم لا يفتح الملف الحالي');
    // 2. العائلة بالمفتاح الجديد ترى كل شيء، والقائد كذلك
    const wife = unlockVault(newKey, vaultPath);
    assert.deepEqual(wife.secrets.map((s) => s.id).sort(), ['FAM1', 'FAM2']);
    assert.equal(getConversation(wife, familyConv)?.messages[0].content, 'سؤال عائلي قبل التدوير', 'المحادثة العائلية نُقلت إلى المفتاح الجديد');
    assert.equal(readFamilyLog(wife, logDir).entries.length, 1, 'سجل الطوارئ نُقل إلى المفتاح الجديد');
    assert.equal(readFamilyLog(wife, logDir).unreadable, 0);
    const commander = unlockVault(PASS, vaultPath);
    assert.ok(commander.familyKey && !commander.familyKey.equals(oldFk), 'القائد يفكّ FK الجديد');
    // 3. المحادثة والسجل لم يعودا يُفتحان بـ FK القديم
    const convFile = JSON.parse(fs.readFileSync(path.join(resolveConversationsDir(), `${familyConv}.enc.json`), 'utf8'));
    assert.throws(() => openWithKey(convFile.sealed, oldFk), 'المحادثة العائلية ما زالت بالمفتاح القديم');
    // 4. النسخة القديمة يفتحها المفتاح القديم (بياناتها القديمة فقط)، فتُعرض في «النسخ القديمة» لتُحذف بموافقة القائد
    assert.equal(openEncryptedBackup(oldBackup.backupFilePath, oldKey).scope, 'family');
    const loc = { vaultFilePath: vaultPath, backupDirs: [backupDir] };
    const old = listOldFullAccessCopies(loc);
    assert.ok(old.some((c) => c.filePath === oldBackup.backupFilePath), 'ISS-048: نسخة v3 القديمة لا تُعرض في النسخ القديمة');
    assert.ok(old.some((c) => c.kind === 'vault-backup'), 'ISS-048: .bak-N بمفتاح الطوارئ القديم لا يُعرض');
    const fresh = createEncryptedSystemBackup(commander, { outputDir: backupDir, extraOutputDir: '' });
    assert.ok(!listOldFullAccessCopies(loc).some((c) => c.filePath === fresh.backupFilePath), 'النسخة الجديدة ليست قديمة');

    // 5. جهازان: التدوير على أ يصل إلى ب بالمزامنة، فيعتمد ب FK الجديد وينقل سجله العائلي إليه
    const syncRoot = path.join(base, 'Drive', 'Second-Brain-Sync');
    fs.mkdirSync(syncRoot, { recursive: true });
    const seed = path.join(base, 'seed', 'vault.aes256.json');
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    const { emergencyRecoveryKey: seedKey } = createVault(PASS, seed);
    const A = makeSyncDevice(base, 'Asus', syncRoot, seed);
    const B = makeSyncDevice(base, 'Mac', syncRoot, seed);
    const vA = unlockVault(PASS, A.vaultFile);
    const vB = unlockVault(PASS, B.vaultFile);
    let clock = Date.now();
    const cycle = (ctx: SyncContext, v: typeof vA) => runSyncCycle(ctx, v, { now: (clock += 1000) });
    upsertVaultSecret(vA, { id: 'SYNC-FAM', category: 'password', title: 'عائلي متزامن', secretValue: 'x', notesForCommanderAr: '', notesForWifeAr: '', familyVisible: true });
    cycle(A, vA);
    cycle(B, vB);
    const bLog = path.join(B.dataDir, 'family-log');
    appendFamilyLog(vB, { action: 'family_unlock' }, bLog);
    const seedFk = Buffer.from(vB.familyKey!);
    const rotA = rotateEmergencyKey(vA, PASS);
    cycle(A, vA);
    cycle(B, vB);
    assert.ok(vB.familyKey && vA.familyKey && vB.familyKey.equals(vA.familyKey), 'ب اعتمد FK الجديد');
    assert.ok(!vB.familyKey!.equals(seedFk));
    assert.equal(unlockVault(rotA.emergencyRecoveryKey, B.vaultFile).secrets[0]?.id, 'SYNC-FAM', 'المفتاح الجديد يفتح الخزنة العائلية على ب');
    assert.throws(() => unlockVault(seedKey, B.vaultFile), 'والقديم يُرفض على ب');
    assert.throws(() => openWithKey((readVaultFile(B.vaultFile) as VaultFileV3).family.data, seedFk), 'FK القديم لا يفتح القسم العائلي على ب');
    assert.equal(readFamilyLog(unlockVault(rotA.emergencyRecoveryKey, B.vaultFile), bLog).unreadable, 0, 'سجل ب نُقل إلى FK الجديد');
    passedChecks.push('ISS-048: تدوير مفتاح الطوارئ يولّد مفتاحاً عائلياً جديداً (FK القديم من .bak-N لا يفتح القسم العائلي الحالي ولا ما يُكتب بعده)، وتُنقل المحادثات العائلية وسجل الطوارئ إليه، والنسخ القديمة بالصيغة 3 تُعرض للحذف، والجهاز الآخر يعتمد FK الجديد بالمزامنة.');
  } finally {
    fs.rmSync(path.join(resolveConversationsDir(), `${familyConv}.enc.json`), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }

  // 6. عبر الخادم (خزنة الاختبار المشتركة): المسار يدوّر FK وينقل المحادثة العائلية، والمفتاح القديم يُرفض
  resetSessionStateForTests();
  const shared = ensureTestVault();
  const sharedOldFk = Buffer.from(unlockVault(shared.emergencyKey).familyKey!);
  const conv = appendConversationTurn(shared.vault, { mode: 'family', question: 'سؤال عائلي عبر الخادم', answer: 'جواب' });
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const cookie = cookieOf((await postJson(port, '/api/vault/unlock', { key: shared.masterPassword })).headers);
    assert.equal((await postJson(port, '/api/vault/rotate-emergency-key', { masterPassword: 'wrong-password-123' }, cookie)).status, 400, 'كلمة مرور خاطئة ← 400');
    const res = await postJson(port, '/api/vault/rotate-emergency-key', { masterPassword: shared.masterPassword }, cookie);
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body) as { emergencyRecoveryKey: string; oldCopiesCount: number; messageAr: string };
    replaceTestEmergencyKey(body.emergencyRecoveryKey);
    assert.match(body.messageAr, /نُقلت [1-9]\d* محادثة عائلية/, body.messageAr);
    assert.ok(body.oldCopiesCount >= 1, 'نسخ .bak-N بالغلاف السابق تُعدّ');
    assert.throws(() => unlockVault(shared.emergencyKey), 'المفتاح القديم يُرفض');
    const wife = unlockVault(body.emergencyRecoveryKey);
    assert.ok(!wife.familyKey!.equals(sharedOldFk), 'FK تغيّر عبر الخادم');
    assert.equal(getConversation(wife, conv)?.messages[0].content, 'سؤال عائلي عبر الخادم');
    passedChecks.push('ISS-048 عبر الخادم: مسار تدوير مفتاح الطوارئ يرفض كلمة المرور الخاطئة، ويدوّر المفتاح العائلي، وينقل المحادثات العائلية، ويعدّ النسخ القديمة.');
  } finally {
    fs.rmSync(path.join(resolveConversationsDir(), `${conv}.enc.json`), { force: true });
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Hint بالعربي: جهاز وهمي للمزامنة (نفس بنية tests/18): نسخة من الخزنة، ومجلداته داخل مجلد الاختبار.
 */
function makeSyncDevice(baseDir: string, name: string, syncRoot: string, vaultSource: string): SyncContext {
  const rootDir = path.join(baseDir, name);
  const dataDir = path.join(rootDir, 'Second-Brain-System', 'data');
  const vaultFile = path.join(dataDir, 'encrypted-vault', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
  fs.copyFileSync(vaultSource, vaultFile);
  const ctx: SyncContext = {
    device: { deviceId: `id-${name}`, deviceName: name, platform: 'test' },
    syncRoot,
    rootDir,
    dataDir,
    vaultFile,
    obsidianDir: path.join(rootDir, 'Obsidian-Vault'),
    brandingPath: path.join(rootDir, 'config', 'branding.json'),
    settingsPath: path.join(rootDir, 'config', 'settings.json'),
  };
  writeFixtureFile(ctx.brandingPath, JSON.stringify({ appName: 'Second Brain' }));
  writeFixtureFile(ctx.settingsPath, JSON.stringify({ watchedProjects: [] }));
  fs.mkdirSync(ctx.obsidianDir, { recursive: true });
  return ctx;
}

/**
 * Hint بالعربي: معرّف حساب المستخدم الحالي على Windows (لاختبار مجلد مغلق لصاحبه).
 */
function currentUserSid(): string {
  const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf-8' });
  const sid = out.match(/S-1-5-[\d-]+/);
  if (!sid) throw new Error('تعذّر قراءة معرّف المستخدم.');
  return sid[0];
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات خيوط المراجعة الأمنية وإرجاع نتائج الفحص.
 */
export async function runSecurityReviewLeadsTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  await checkFolderPermissionLead(passedChecks);
  await checkSettingsAuthSecondFactor(passedChecks);
  await checkEmergencyRotationRotatesFamilyKey(passedChecks);
  return passedChecks;
}
