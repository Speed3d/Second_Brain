/**
 * ============================================================================
 * الملف: tests/18-family-vault.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات الخزنة العائلية v3 (الإصدار 3.0.0، المرحلة 2.1 من docs/12):
 *               - الترقية v2 ← v3: مفتاح طوارئ جديد، والقديم يُرفض، ولا غلاف طوارئ لمفتاح البيانات.
 *               - مفتاح الطوارئ يفتح الخزنة العائلية وحدها: لا أسرار القائد ولا محادثاته ولا الحفظ ولا المزامنة.
 *               - العلامة «يظهر للعائلة» مصدر واحد: التعديل والإلغاء ينعكسان على الخزنة العائلية عند الحفظ.
 *               - محادثات العائلة تنتقل إلى المفتاح العائلي.
 *               - المزامنة بين جهازين: الجهاز الآخر يُرقّى بالمفتاح العائلي نفسه، والخزنة العائلية لا تُفقد
 *                 حتى مع تغيير كلمة مرور متزامن.
 *               - النسخ القديمة التي يفتحها المفتاح القديم تُحصى وتُحذف، والنسخ الجديدة بحمولتين.
 *               - المسارات: الحالة، والصلاحيات، والعلامة عبر الخادم.
 *               كل شيء في البيئة المعزولة ومجلدات مؤقتة، ولا يلمس أي بيانات حقيقية.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { appendConversationTurn, getConversation, listConversations, resealFamilyConversations, resolveConversationsDir } from '../src/features/conversations/conversation-store.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createEncryptedSystemBackup, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { listOldFullAccessCopies, removeOldFullAccessCopies } from '../src/features/family-emergency/old-copies.ts';
import { runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { suggestFamilySecrets } from '../src/features/vault/family-vault.ts';
import {
  changeMasterPassword,
  createLegacyV2VaultForTests,
  migrateVaultToFamilyV3,
  persistVault,
  readVaultFile,
  unlockVault,
  upsertVaultSecret,
  verifyEmergencyKey,
  type UnlockedVault,
} from '../src/features/vault/vault-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, writeFixtureFile } from './test-environment.ts';

const PASS = 'Family-Vault-Test-Pass-01';

function secret(id: string, extra: Partial<Parameters<typeof upsertVaultSecret>[1]> = {}): Parameters<typeof upsertVaultSecret>[1] {
  return { id, category: 'password', title: id, secretValue: `value-${id}`, notesForCommanderAr: `ملاحظة القائد ${id}`, notesForWifeAr: `شرح ${id}`, ...extra };
}

function makeDevice(baseDir: string, name: string, syncRoot: string, vaultSource: string): SyncContext {
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
 * Hint بالعربي: دالة تشغيل اختبارات الخزنة العائلية وإرجاع نتائج الفحص.
 */
export async function runFamilyVaultTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const base = path.join(config.paths.rootDir, 'family-vault-sim');
  fs.mkdirSync(base, { recursive: true });

  // ===================== 1. الترقية v2 ← v3 =====================
  const legacyPath = path.join(base, 'legacy', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const { emergencyRecoveryKey: oldKey } = createLegacyV2VaultForTests(PASS, legacyPath);
  const v2 = unlockVault(PASS, legacyPath);
  upsertVaultSecret(v2, secret('HOST', { title: 'استضافة المتجر', category: 'password', url: 'https://hostinger.example' }));
  upsertVaultSecret(v2, secret('MAIL', { title: 'البريد الرئيسي', category: 'email_account', usernameOrEmail: 'owner@example.test' }));
  upsertVaultSecret(v2, secret('API', { title: 'مفتاح خادم الدفع', category: 'api_key' }));
  upsertVaultSecret(v2, secret('BILL', { title: 'فاتورة السيرفر', category: 'billing' }));
  assert.equal(unlockVault(oldKey, legacyPath).secrets.length, 4, 'قبل الترقية: المفتاح القديم يفتح كل شيء (هذه هي الثغرة)');
  // نسخة طوارئ بالصيغة 2 قبل الترقية (ستُحصى نسخةً قديمة)
  const oldBackupDir = path.join(base, 'old-backups');
  const oldBackup = createEncryptedSystemBackup(v2, { outputDir: oldBackupDir, extraOutputDir: '' });
  assert.equal(JSON.parse(fs.readFileSync(oldBackup.backupFilePath, 'utf8')).version, 2);

  // اقتراحات المعالج
  const sugg = suggestFamilySecrets(v2.secrets);
  const pick = (id: string) => sugg.find((s) => s.id === id)!;
  assert.equal(pick('HOST').suggested, true, 'الاستضافة مقترحة');
  assert.equal(pick('MAIL').suggested, true, 'البريد مقترح');
  assert.equal(pick('BILL').suggested, true, 'الفواتير مقترحة');
  assert.equal(pick('API').suggested, false, 'مفاتيح API لا تُقترح للعائلة');
  passedChecks.push('اختبار اقتراحات «ما تحتاجه العائلة» (الاستضافة والبريد والفواتير مقترحة، ومفاتيح API لا) بنجاح.');

  assert.throws(() => migrateVaultToFamilyV3(v2, 'wrong-password-xx', ['HOST']), /غير صحيحة/);
  const migrated = migrateVaultToFamilyV3(v2, PASS, ['HOST', 'MAIL', 'BILL']);
  assert.equal(migrated.familyCount, 3);
  const v3file = readVaultFile(legacyPath);
  assert.equal(v3file.version, 3);
  assert.equal((v3file as unknown as Record<string, unknown>).emergencyWrap, undefined, 'لا غلاف طوارئ لمفتاح البيانات بعد الترقية');
  assert.throws(() => unlockVault(oldKey, legacyPath), 'المفتاح القديم يُرفض بعد الترقية');
  assert.equal(verifyEmergencyKey(oldKey, legacyPath), false);
  assert.equal(verifyEmergencyKey(migrated.emergencyRecoveryKey, legacyPath), true);
  assert.throws(() => migrateVaultToFamilyV3(v2, PASS, []), /بالفعل/, 'لا ترقية مرتين');
  const wife = unlockVault(migrated.emergencyRecoveryKey, legacyPath);
  assert.equal(wife.unlockedBy, 'wife_emergency');
  assert.equal(wife.dataKey.length, 0, 'جلسة العائلة بلا مفتاح بيانات');
  assert.deepEqual(wife.secrets.map((s) => s.id).sort(), ['BILL', 'HOST', 'MAIL'], 'الخزنة العائلية = المختار فقط');
  assert.ok(wife.secrets.every((s) => s.notesForCommanderAr === ''), 'بلا ملاحظات القائد');
  assert.throws(() => persistVault(wife), /للقراءة فقط/);
  assert.equal(unlockVault(PASS, legacyPath).secrets.length, 4, 'كلمة المرور تفتح كل شيء كما كانت');
  passedChecks.push('اختبار الترقية إلى الخزنة العائلية (مفتاح جديد، القديم يُرفض، لا غلاف طوارئ لمفتاح البيانات، العائلة ترى المختار فقط بلا ملاحظات القائد، ولا تحفظ) بنجاح.');

  // العلامة مصدر واحد: التعديل والإلغاء ينعكسان على الخزنة العائلية
  const host = v2.secrets.find((s) => s.id === 'HOST')!;
  upsertVaultSecret(v2, { ...host, secretValue: 'new-host-pass' });
  upsertVaultSecret(v2, { ...v2.secrets.find((s) => s.id === 'MAIL')!, familyVisible: false });
  upsertVaultSecret(v2, secret('API2', { category: 'api_key', familyVisible: true }));
  const wife2 = unlockVault(migrated.emergencyRecoveryKey, legacyPath);
  assert.equal(wife2.secrets.find((s) => s.id === 'HOST')?.secretValue, 'new-host-pass', 'تعديل السر يصل إلى العائلة');
  assert.ok(!wife2.secrets.some((s) => s.id === 'MAIL'), 'إلغاء العلامة يزيله من الخزنة العائلية');
  assert.ok(wife2.secrets.some((s) => s.id === 'API2'), 'ما يعلّمه القائد يدوياً يظهر (القرار له)');
  assert.equal(readVaultFile(legacyPath).version === 3 && (readVaultFile(legacyPath) as { family: { count: number } }).family.count, 3);
  passedChecks.push('اختبار العلامة «👪 يظهر للعائلة» مصدراً واحداً (التعديل يصل، والإلغاء يزيل، والعدد يتحدّث عند كل حفظ) بنجاح.');

  // ===================== 2. المحادثات =====================
  // المحادثات تُكتب في مجلد البيئة المعزولة، بخزنة الاختبار المشتركة (v3)
  const { vault: shared, emergencyKey: sharedKey } = ensureTestVault();
  const legacyFamily: UnlockedVault = { ...shared, familyKey: null };
  const oldFamilyConv = appendConversationTurn(legacyFamily, { mode: 'family', question: 'سؤال عائلي قديم', answer: 'جواب' });
  const rawOld = JSON.parse(fs.readFileSync(path.join(resolveConversationsDir(), `${oldFamilyConv}.enc.json`), 'utf8'));
  assert.equal(rawOld.keyScope, undefined, 'محادثة قبل الترقية مختومة بمفتاح البيانات');
  const commanderConv = appendConversationTurn(shared, { mode: 'commander', question: 'سؤال خاص بالقائد', answer: 'جواب' });
  const newFamilyConv = appendConversationTurn(shared, { mode: 'family', question: 'سؤال عائلي جديد', answer: 'جواب' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(resolveConversationsDir(), `${newFamilyConv}.enc.json`), 'utf8')).keyScope, 'family');
  const familySession = unlockVault(sharedKey);
  assert.throws(() => getConversation(familySession, oldFamilyConv), 'قبل النقل: محادثة مختومة بمفتاح البيانات لا تفتحها العائلة');
  assert.ok(resealFamilyConversations(shared) >= 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(resolveConversationsDir(), `${oldFamilyConv}.enc.json`), 'utf8')).keyScope, 'family');
  assert.equal(getConversation(familySession, oldFamilyConv)?.messages[0].content, 'سؤال عائلي قديم', 'بعد النقل تفتحها العائلة');
  assert.equal(getConversation(familySession, commanderConv), null, 'محادثة القائد لا تصل إليها العائلة');
  assert.ok(!listConversations(familySession).some((c) => c.id === commanderConv));
  assert.equal(getConversation(shared, newFamilyConv)?.messages.length, 2, 'القائد يقرأ محادثات العائلة أيضاً');
  passedChecks.push('اختبار محادثات العائلة بالمفتاح العائلي (الجديدة تُختم به، والقديمة تُنقل إليه، والعائلة لا تصل إلى محادثات القائد) بنجاح.');

  // ===================== 3. النسخ: الجديدة بحمولتين، والقديمة تُحصى وتُحذف =====================
  const newBackup = createEncryptedSystemBackup(v2, { outputDir: oldBackupDir, extraOutputDir: '' });
  const nb = JSON.parse(fs.readFileSync(newBackup.backupFilePath, 'utf8'));
  assert.equal(nb.version, 3);
  assert.equal(nb.vaultKeys.emergencyWrap, undefined);
  assert.equal(openEncryptedBackup(newBackup.backupFilePath, migrated.emergencyRecoveryKey).scope, 'family');
  assert.throws(() => openEncryptedBackup(newBackup.backupFilePath, oldKey), 'المفتاح القديم لا يفتح النسخة الجديدة');
  assert.equal(openEncryptedBackup(oldBackup.backupFilePath, oldKey).scope, 'full', 'النسخة القديمة ما زال يفتحها المفتاح القديم (لذلك تُعرض)');
  const loc = { vaultFilePath: legacyPath, backupDirs: [oldBackupDir] };
  const old = listOldFullAccessCopies(loc);
  assert.ok(old.some((c) => c.filePath === oldBackup.backupFilePath && c.kind === 'backup'), 'نسخة الطوارئ القديمة محصاة');
  assert.ok(old.some((c) => c.kind === 'vault-backup'), 'النسخ السابقة لملف الخزنة (v2) محصاة');
  assert.ok(!old.some((c) => c.filePath === newBackup.backupFilePath), 'النسخة الجديدة ليست قديمة');
  const removed = removeOldFullAccessCopies(loc);
  assert.equal(removed.removed, old.length);
  assert.equal(listOldFullAccessCopies(loc).length, 0);
  assert.ok(fs.existsSync(newBackup.backupFilePath), 'الجديدة تبقى');
  assert.equal(unlockVault(PASS, legacyPath).secrets.length, 5, 'الخزنة نفسها سليمة بعد الحذف');
  passedChecks.push('اختبار النسخ بعد الترقية (الجديدة بحمولتين ولا يفتحها المفتاح القديم، والقديمة تُحصى وتُحذف وحدها) بنجاح.');

  // ===================== 4. المزامنة بين جهازين =====================
  const syncRoot = path.join(base, 'Drive', 'Second-Brain-Sync');
  fs.mkdirSync(syncRoot, { recursive: true });
  const seedPath = path.join(base, 'seed', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  const { emergencyRecoveryKey: seedOldKey } = createLegacyV2VaultForTests(PASS, seedPath);
  const A = makeDevice(base, 'Asus', syncRoot, seedPath);
  const B = makeDevice(base, 'Mac', syncRoot, seedPath);
  const vA = unlockVault(PASS, A.vaultFile);
  const vB = unlockVault(PASS, B.vaultFile);
  let clock = Date.now();
  const cycle = (ctx: SyncContext, v: UnlockedVault) => runSyncCycle(ctx, v, { now: (clock += 1000) });
  upsertVaultSecret(vA, secret('S-HOST', { title: 'استضافة' }));
  cycle(A, vA);
  cycle(B, vB);
  assert.ok(vB.secrets.some((s) => s.id === 'S-HOST'));
  // محادثة عائلية على الماك قبل وصول المفاتيح (مختومة بمفتاح البيانات)
  const bConvDir = path.join(B.dataDir, 'conversations');
  fs.mkdirSync(bConvDir, { recursive: true });
  const famA = migrateVaultToFamilyV3(vA, PASS, ['S-HOST']);
  // الماك يغيّر كلمة المرور في الوقت نفسه (قبل أن يرى الترقية)، فيصبح سجل المفاتيح متزامناً
  changeMasterPassword(vB, PASS, 'Family-Vault-Test-Pass-02');
  cycle(A, vA); // نشر المفاتيح العائلية
  cycle(B, vB); // الماك: تعديلان متزامنان لسجل المفاتيح
  const fileB = readVaultFile(B.vaultFile);
  assert.equal(fileB.version, 3, 'الجهاز الآخر رُقّي بالمزامنة رغم تغيير كلمة المرور المتزامن');
  assert.ok(vB.familyKey && vA.familyKey && vB.familyKey.equals(vA.familyKey), 'بالمفتاح العائلي نفسه (لم يُولَّد مفتاح ثانٍ)');
  assert.equal(unlockVault(famA.emergencyRecoveryKey, B.vaultFile).secrets[0]?.id, 'S-HOST', 'مفتاح الطوارئ الجديد يفتح الخزنة العائلية على الجهاز الآخر');
  assert.throws(() => unlockVault(seedOldKey, B.vaultFile), 'والمفتاح القديم يُرفض هناك أيضاً');
  cycle(B, vB);
  cycle(A, vA);
  const fileA = readVaultFile(A.vaultFile);
  assert.equal(fileA.version, 3, 'الخزنة العائلية لم تُفقد على الجهاز الذي رقّاها');
  assert.deepEqual(fileA.commanderWrap, readVaultFile(B.vaultFile).commanderWrap, 'كلمة المرور الأحدث وصلت إلى الجهازين');
  assert.ok(unlockVault('Family-Vault-Test-Pass-02', A.vaultFile).secrets.length >= 1);
  assert.equal(verifyEmergencyKey(famA.emergencyRecoveryKey, A.vaultFile), true);
  // جلسة العائلة لا تزامن
  const wifeOnB = unlockVault(famA.emergencyRecoveryKey, B.vaultFile);
  const wifeRun = runSyncCycle(B, wifeOnB, { now: (clock += 1000) });
  assert.equal(wifeRun.published + wifeRun.applied, 0);
  assert.ok(wifeRun.warnings.some((w) => /جلسة العائلة لا تزامن/.test(w)));
  passedChecks.push('اختبار المزامنة مع الخزنة العائلية (الجهاز الآخر يُرقّى بالمفتاح العائلي نفسه، والخزنة العائلية لا تُفقد مع تغيير كلمة مرور متزامن، والمفتاح القديم يُرفض على الجهازين، وجلسة العائلة لا تزامن) بنجاح.');

  // ===================== 5. المسارات =====================
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const cmd = await postJson(port, '/api/vault/unlock', { key: (ensureTestVault()).masterPassword });
    const cmdCookie = String(cmd.headers['set-cookie'] ?? '').split(';')[0];
    const status = JSON.parse((await rawRequest(port, { path: '/api/vault/status', headers: { Cookie: cmdCookie } })).body) as { vaultFormat: number; familyCount: number };
    assert.equal(status.vaultFormat, 3);
    const saved = JSON.parse((await postJson(port, '/api/vault/secrets', { category: 'billing', title: 'فاتورة عبر الخادم', secretValue: 'x-1', familyVisible: true }, cmdCookie)).body) as { secret: { id: string; familyVisible: boolean } };
    assert.equal(saved.secret.familyVisible, true, 'العلامة تُحفظ عبر الخادم');
    const fam = JSON.parse((await rawRequest(port, { path: '/api/vault/family', headers: { Cookie: cmdCookie } })).body) as { vaultFormat: number; suggestions: unknown[] };
    assert.equal(fam.vaultFormat, 3);
    assert.ok(Array.isArray(fam.suggestions));
    assert.equal((await postJson(port, '/api/vault/family/migrate', { masterPassword: 'x', secretIds: [] }, cmdCookie)).status, 400, 'بلا تأكيد «جهاز واحد» مرفوض');
    assert.equal((await postJson(port, '/api/vault/family/migrate', { masterPassword: 'x', secretIds: [], confirmSingleDevice: true }, cmdCookie)).status, 409, 'خزنة مرقّاة لا تُرقّى مرة ثانية');
    resetSessionStateForTests();
    const wifeLogin = await postJson(port, '/api/vault/unlock', { key: sharedKey });
    const wifeCookie = String(wifeLogin.headers['set-cookie'] ?? '').split(';')[0];
    const wifeSecrets = JSON.parse((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: wifeCookie } })).body) as { secrets: Array<{ id: string }> };
    assert.ok(wifeSecrets.secrets.some((s) => s.id === saved.secret.id), 'السر المعلَّم يظهر لجلسة العائلة عبر الخادم');
    assert.equal((await rawRequest(port, { path: '/api/vault/family', headers: { Cookie: wifeCookie } })).status, 403, 'جلسة العائلة لا ترى إدارة الخزنة العائلية');
    assert.equal((await postJson(port, '/api/vault/family/old-copies/delete', { masterPassword: 'x' }, wifeCookie)).status, 403);
    assert.notEqual((await postJson(port, '/api/emergency/backup', {}, wifeCookie)).status, 200, 'جلسة العائلة لا تنشئ نسخة كاملة');
    passedChecks.push('اختبار مسارات الخزنة العائلية (الحالة v3، حفظ العلامة، رفض الترقية المكررة وبلا تأكيد، والعائلة ترى المعلَّم ولا تدير الخزنة ولا تنشئ نسخة كاملة) بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  fs.rmSync(base, { recursive: true, force: true });
  return passedChecks;
}
