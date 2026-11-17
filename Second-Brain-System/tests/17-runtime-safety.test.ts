/**
 * ============================================================================
 * الملف: tests/17-runtime-safety.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: حمايات المرحلة 2 الأولى (docs/12):
 *               ISS-032: الخادم يكشف أن الكود على القرص أحدث منه، فيوقف المزامنة ويطلب إعادة التشغيل،
 *               وزر إعادة التشغيل يخرج برمز 75 فيعيده المشغّل بالكود الجديد.
 *               ISS-028: الحذف الجماعي لا يُنشر ولا يُطبَّق بلا تأكيد، وصيغة التغييرات والحدّ الأدنى للإصدار.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, readRawSettings, updateSystemSettings } from '../src/core/config-manager.ts';
import { describeRestartRequired, getRuntimeVersionStatus, RESTART_EXIT_CODE, setRestartHandlerForTests, setRunningVersionForTests } from '../src/core/runtime-version.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { CHANGE_FORMAT, MASS_DELETE_THRESHOLD, resolveHeldDeletes, runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import { listTrash, readHeldIncoming, readSyncIndex } from '../src/features/sync/sync-store.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { unlockVault, type UnlockedVault } from '../src/features/vault/vault-manager.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

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
 * Hint بالعربي: دالة تشغيل اختبارات حمايات التشغيل.
 */
export async function runRuntimeSafetyTests(): Promise<string[]> {
  const passed: string[] = [];
  const config = loadSystemConfig();
  ensureTestVault();

  // 1. الحالة الطبيعية: الكود الذي يعمل هو الكود على القرص
  const normal = getRuntimeVersionStatus();
  assert.equal(normal.restartRequired, false);
  assert.equal(normal.runningVersion, normal.diskVersion);
  assert.equal(describeRestartRequired(normal), null);
  assert.equal(RESTART_EXIT_CODE, 75);

  // 2. محاكاة خادم بدأ قبل git pull
  setRunningVersionForTests('0.0.1');
  const stale = getRuntimeVersionStatus();
  assert.equal(stale.restartRequired, true);
  assert.match(describeRestartRequired(stale) ?? '', /حُدّث البرنامج على القرص إلى .* بالإصدار 0\.0\.1/);
  passed.push('اختبار كشف الكود القديم في الذاكرة (ISS-032: الإصدار الذي يعمل مقابل إصدار القرص، ورسالة عربية واضحة) بنجاح.');

  // 3. الخادم: /api/health صادق، والمزامنة متوقفة، وزر إعادة التشغيل
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const deviceFile = path.join(dataDir, 'device.json');
  writeFixtureFile(deviceFile, JSON.stringify({ deviceId: 'id-runtime', deviceName: 'Runtime-PC', platform: 'test' }));
  const drive = path.join(config.paths.rootDir, 'runtime-drive');
  fs.mkdirSync(drive, { recursive: true });
  const originalSettings = readRawSettings();
  updateSystemSettings({ sync: { enabled: true, folder: drive } });
  let restartRequested = 0;
  setRestartHandlerForTests(() => {
    restartRequested += 1;
  });
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const health = JSON.parse((await rawRequest(port, { path: '/api/health' })).body);
    assert.equal(health.version, '0.0.1', '/api/health يعرض إصدار الكود الذي يعمل، لا ما على القرص');
    assert.equal(health.diskVersion, stale.diskVersion);
    assert.equal(health.restartRequired, true);

    const status = JSON.parse((await rawRequest(port, { path: '/api/sync/status' })).body);
    assert.equal(status.restartRequired, true);
    assert.match(status.problemAr, /المزامنة متوقفة/);

    const unlock = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    assert.equal(unlock.status, 200, 'فتح الخزنة يعمل');
    assert.match(JSON.parse(unlock.body).syncMessageAr ?? '', /المزامنة متوقفة حتى تعيد تشغيل الخادم/);
    assert.equal(fs.existsSync(path.join(dataDir, 'sync', 'index.json')), false, 'لا ترحيل ولا دورة مزامنة بكود قديم');
    assert.equal(fs.existsSync(path.join(drive, 'Second-Brain-Sync', 'changes')), false, 'ولا نشر');
    const cookie = String(unlock.headers['set-cookie'] ?? '').split(';')[0];
    const now = await postJson(port, '/api/sync/now', {}, cookie);
    assert.notEqual(now.status, 200, '«زامن الآن» يُرفض');
    assert.match(JSON.parse(now.body).error, /أعد تشغيل الخادم/);

    assert.equal((await postJson(port, '/api/system/restart', {})).status, 401, 'إعادة التشغيل تحتاج الخزنة مفتوحة');
    const restart = await postJson(port, '/api/system/restart', {}, cookie);
    assert.equal(restart.status, 200, restart.body);
    assert.equal(restartRequested, 1, 'طُلبت إعادة التشغيل');
    assert.equal(JSON.parse(restart.body).runningVersion, '0.0.1');
    passed.push('اختبار الخادم بكود قديم (ISS-032: /api/health صادق، والمزامنة متوقفة عند فتح الخزنة وفي «زامن الآن»، ولا نشر، وزر إعادة التشغيل للقائد فقط) بنجاح.');
  } finally {
    setRunningVersionForTests(null);
    setRestartHandlerForTests(null);
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    updateSystemSettings({ sync: originalSettings.sync ?? { enabled: false, folder: '' } });
    fs.rmSync(deviceFile, { force: true });
    fs.rmSync(path.join(dataDir, 'sync'), { recursive: true, force: true });
  }
  assert.equal(getRuntimeVersionStatus().restartRequired, false, 'عادت الحالة الطبيعية');

  // 4. المشغّلان يعيدان الخادم عند الرمز 75، والواجهة فيها الشريط والزر
  const root = path.join(import.meta.dirname, '..');
  const runner = fs.readFileSync(path.join(root, 'install', 'windows', 'run-server.ps1'), 'utf8');
  assert.match(runner, /ExitCode -eq 75\) \{ continue \}/, 'مشغّل Windows يعيد التشغيل فوراً عند 75 ولا يعدّه تعطلاً');
  const mac = fs.readFileSync(path.join(root, 'install', 'macos', 'install-macos.sh'), 'utf8');
  assert.match(mac, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/>/, 'LaunchAgent يعيد التشغيل عند أي رمز غير الصفر');
  const appJs = fs.readFileSync(path.join(root, 'src', 'features', 'dashboard-app', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'features', 'dashboard-app', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="restartBanner"/);
  assert.match(appJs, /'restart-server': \(b\) => restartServer\(b\)/);
  assert.match(html, /id="syncHeldCard"/, 'بطاقة الحذف الجماعي المعلّق (ISS-028)');
  assert.match(appJs, /'\/api\/sync\/held\/resolve'/);
  passed.push('اختبار إعادة التشغيل من الواجهة (المشغّلان يعيدان الخادم عند الرمز 75، والشريط والزر في الواجهة) بنجاح.');

  // ===================== ISS-028: حماية الحذف بين الأجهزة =====================
  const base = path.join(config.paths.rootDir, 'iss028-sim');
  const syncRoot = path.join(base, 'Drive', 'Second-Brain-Sync');
  fs.mkdirSync(syncRoot, { recursive: true });
  const A = makeDevice(base, 'Asus', syncRoot, config.paths.encryptedVaultFile);
  const B = makeDevice(base, 'Mac', syncRoot, config.paths.encryptedVaultFile);
  const vA = unlockVault(TEST_MASTER_PASSWORD, A.vaultFile);
  const vB = unlockVault(TEST_MASTER_PASSWORD, B.vaultFile);
  let clock = Date.now();
  const cycle = (ctx: SyncContext, v: UnlockedVault, extra: Parameters<typeof runSyncCycle>[2] = {}) => runSyncCycle(ctx, v, { now: (clock += 1000), ...extra });
  const folder = 'مشروع مهم';
  const files = Array.from({ length: 12 }, (_, i) => `${folder}/ملاحظة-${i + 1}.md`);
  for (const f of files) writeFixtureFile(path.join(A.obsidianDir, f), `محتوى ${f}`);
  for (const f of ['أ', 'ب', 'ج']) writeFixtureFile(path.join(A.obsidianDir, `صغير/${f}.md`), f);
  writeFixtureFile(path.join(A.obsidianDir, 'منفرد-1.md'), '1');
  writeFixtureFile(path.join(A.obsidianDir, 'منفرد-2.md'), '2');
  cycle(A, vA);
  cycle(B, vB);
  cycle(A, vA);
  assert.equal(fs.readdirSync(path.join(B.obsidianDir, folder)).length, 12, 'وصلت الملفات إلى الجهاز الآخر');
  const batchesOf = (ctx: SyncContext): string[] => fs.readdirSync(path.join(syncRoot, 'changes', `id-${ctx.device.deviceName}`)).sort();
  const countIn = (ctx: SyncContext, dir: string): number => (fs.existsSync(path.join(ctx.obsidianDir, dir)) ? fs.readdirSync(path.join(ctx.obsidianDir, dir)).length : 0);

  // 1) حذف عادي (ملفان منفردان): يُنشر بلا سؤال
  fs.unlinkSync(path.join(A.obsidianDir, 'منفرد-1.md'));
  fs.unlinkSync(path.join(A.obsidianDir, 'منفرد-2.md'));
  cycle(A, vA);
  cycle(B, vB);
  assert.equal(fs.existsSync(path.join(B.obsidianDir, 'منفرد-1.md')), false, 'الحذف الصغير يُنشر عادياً');
  assert.equal(readSyncIndex(A)!.heldDeletes, undefined);

  // 2) مجلد كامل (3 ملفات) اختفى: يُعلَّق، و«استرجعها» تعيده
  for (const f of ['أ', 'ب', 'ج']) fs.unlinkSync(path.join(A.obsidianDir, `صغير/${f}.md`));
  const beforeWipe = batchesOf(A).length;
  cycle(A, vA);
  assert.match(readSyncIndex(A)!.heldDeletes?.reasonAr ?? '', /المجلد «صغير» اختفى كاملاً/, 'اختفاء مجلد كامل يُعلَّق');
  assert.equal(batchesOf(A).length, beforeWipe, 'ولا يُنشر شيء');
  resolveHeldDeletes(A, vA, 'outgoing', 'reject');
  assert.equal(fs.readFileSync(path.join(A.obsidianDir, 'صغير/ب.md'), 'utf8'), 'ب', '«لا، استرجعها» يعيدها من الظل');
  cycle(A, vA);
  assert.equal(readSyncIndex(A)!.heldDeletes, undefined);

  // 3) حذف جماعي (12) على الأسوس: يُعلَّق، ثم يؤكّده القائد فيُنشر، ولا يُسأل الجهاز الآخر مرة ثانية
  for (const f of files) fs.unlinkSync(path.join(A.obsidianDir, f));
  cycle(A, vA);
  const held = readSyncIndex(A)!.heldDeletes;
  assert.equal(held?.keys.length, 12);
  cycle(B, vB);
  assert.equal(countIn(B, folder), 12, 'الجهاز الآخر لم يفقد شيئاً قبل التأكيد');
  resolveHeldDeletes(A, vA, 'outgoing', 'confirm');
  cycle(A, vA);
  const bRun = cycle(B, vB);
  assert.equal(countIn(B, folder), 0, 'بعد التأكيد يُحذف من الجهاز الآخر');
  assert.equal(readHeldIncoming(B, vB.dataKey).length, 0, 'ولا يُطلب تأكيد ثانٍ هناك (الحذف موسوم «مؤكَّد»)');
  assert.ok(!bRun.warnings.some((w) => /حذفاً جماعياً/.test(w)));
  assert.ok(listTrash(B, vB.dataKey).filter((t) => t.key.includes(folder)).length >= 12, 'وكلها في سلة الجهاز الآخر');
  passed.push('اختبار حماية نشر الحذف (ISS-028: الحذف الصغير عادي، واختفاء مجلد كامل أو 10 عناصر فأكثر يُعلَّق، «استرجعها» تعيدها، و«نعم» تنشرها فتُحذف من الأجهزة الأخرى بلا سؤال ثانٍ) بنجاح.');

  // 4) حذف جماعي قادم من جهاز قديم بلا حماية: لا يُطبَّق بلا تأكيد، ورفضه يعيد الملفات إلى الجهاز الآخر أيضاً
  const files2 = Array.from({ length: MASS_DELETE_THRESHOLD + 1 }, (_, i) => `أرشيف/ملف-${i + 1}.md`);
  for (const f of files2) writeFixtureFile(path.join(A.obsidianDir, f), `أرشيف ${f}`);
  cycle(A, vA);
  cycle(B, vB);
  for (const f of files2) fs.unlinkSync(path.join(A.obsidianDir, f));
  cycle(A, vA, { unguardedPublishForTests: true }); // يحاكي جهازاً بإصدار 2.0.x بلا حدّ أمان
  const incomingRun = cycle(B, vB);
  assert.ok(incomingRun.warnings.some((w) => /نشر حذفاً جماعياً/.test(w)), 'تنبيه بالحذف الجماعي القادم');
  assert.equal(countIn(B, 'أرشيف'), files2.length, 'لم يُطبَّق الحذف القادم');
  assert.equal(readHeldIncoming(B, vB.dataKey)[0]?.changes.length, files2.length);
  resolveHeldDeletes(B, vB, 'incoming', 'reject');
  cycle(B, vB);
  cycle(A, vA);
  assert.equal(countIn(A, 'أرشيف'), files2.length, '«لا، أبقها» يعيدها إلى الجهاز الذي حذفها أيضاً');
  passed.push('اختبار الحذف الجماعي القادم (ISS-028: من جهاز بلا حماية لا يُطبَّق بلا تأكيد، ورفضه يعيد الملفات إلى الجهاز الآخر) بنجاح.');

  // 5) صيغة أحدث وحدّ أدنى للإصدار
  const futureDir = path.join(syncRoot, 'changes', 'id-Future');
  fs.mkdirSync(futureDir, { recursive: true });
  fs.writeFileSync(
    path.join(futureDir, '009999999999999-000001.enc.json'),
    JSON.stringify({ format: 'second-brain-sync-changes', formatVersion: 1, device: { deviceId: 'id-Future', deviceName: 'Future-PC', platform: 'test' }, createdAt: new Date().toISOString(), batch: 'x', count: 1, changeFormat: CHANGE_FORMAT + 1, appVersion: '9.0.0', payload: { ivHex: '', authTagHex: '', cipherTextHex: '' } })
  );
  const futureRun = cycle(B, vB);
  assert.ok(futureRun.warnings.some((w) => /بصيغة أحدث/.test(w)), 'دفعة بصيغة أحدث لا تُدمج، مع طلب التحديث');
  assert.equal(readSyncIndex(B)!.cursors['id-Future'], undefined, 'والمؤشر لا يتقدّم');
  fs.rmSync(futureDir, { recursive: true, force: true });
  const manifestFile = path.join(syncRoot, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ format: 'second-brain-sync-manifest', latestVersion: 0, minAppVersion: '9.0.0', multiWriter: true }));
  writeFixtureFile(path.join(B.obsidianDir, 'بعد-الحد.md'), 'لن يُنشر');
  const beforeOld = batchesOf(B).length;
  const oldRun = cycle(B, vB, { appVersion: '2.2.0' });
  assert.ok(oldRun.warnings.some((w) => /أقدم من الحدّ الأدنى للمزامنة \(9\.0\.0\)/.test(w)), 'جهاز أقدم من الحد الأدنى يتوقف');
  assert.equal(batchesOf(B).length, beforeOld, 'ولا ينشر');
  fs.rmSync(manifestFile, { force: true });
  passed.push('اختبار حارس الإصدار (ISS-028: دفعة بصيغة أحدث لا تُدمج والمؤشر لا يتقدّم، وجهاز أقدم من الحدّ الأدنى في manifest لا ينشر ولا يدمج) بنجاح.');
  fs.rmSync(base, { recursive: true, force: true });
  return passed;
}
