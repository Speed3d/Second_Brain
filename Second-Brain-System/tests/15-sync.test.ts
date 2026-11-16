/**
 * ============================================================================
 * الملف: tests/15-sync.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات صيغة المزامنة القديمة (1.9) التي يعتمد عليها الترحيل إلى 2.0، بمحاكاة 3 أجهزة:
 *               قفل 1.9 (يبقى فقط لإبقاء الأجهزة القديمة في وضع القراءة)، نشر النسخ القديمة واستيرادها،
 *               رفض خزنة مختلفة أو نسخة معدّلة، مسارات المشاريع لكل جهاز، اقتراح مجلد Drive،
 *               ثم الخادم في 2.0: الترحيل التلقائي عند فتح الخزنة، والكتابة بلا قفل، وقفل الأجهزة القديمة.
 *               اختبارات المزامنة متعددة الكتابة نفسها في tests/16-multi-writer-sync.test.ts.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, readDevicePathOverrides, readRawSettings, registerWatchedProject, setDeviceProjectPath, updateSystemSettings } from '../src/core/config-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { detectDriveFolders, DRIVE_APP_FOLDER } from '../src/features/dashboard-app/routes/sync-routes.ts';
import { acquireLease, checkWriteAccess, describeSyncIoError, heartbeatLease, LEASE_EXPIRY_MS, readLeaseStatus, readLocalSyncState, releaseLease, type SyncContext } from '../src/features/sync/sync-context.ts';
import { checkSync, importLatestSnapshot, publishSnapshot, readManifest } from '../src/features/sync/snapshot-sync.ts';
import { createVault, unlockVault } from '../src/features/vault/vault-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

/**
 * Hint بالعربي: دالة إنشاء جهاز وهمي كامل في مجلد مؤقت (خزنة منسوخة، Obsidian، إعدادات) يشارك مجلد مزامنة.
 */
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
  writeFixtureFile(ctx.settingsPath, JSON.stringify({ serverPort: 4777, watchedProjects: [], aiConfig: { ollamaModel: `model-of-${name}` } }));
  return ctx;
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/**
 * Hint بالعربي: دالة تشغيل اختبارات المزامنة وإرجاع نتائج الفحص.
 */
export async function runSyncTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  ensureTestVault();
  const base = path.join(config.paths.rootDir, 'sync-sim');
  const drive = path.join(base, 'Google-Drive');
  const syncRoot = path.join(drive, 'Second-Brain-Sync');
  fs.mkdirSync(drive, { recursive: true });
  const A = makeDevice(base, 'Asus-Windows', syncRoot, config.paths.encryptedVaultFile);
  const B = makeDevice(base, 'MacBook-M5', syncRoot, config.paths.encryptedVaultFile);
  const C = makeDevice(base, 'Desktop-3090', syncRoot, config.paths.encryptedVaultFile);
  const vaultA = unlockVault(TEST_MASTER_PASSWORD, A.vaultFile);
  const vaultB = unlockVault(TEST_MASTER_PASSWORD, B.vaultFile);
  const vaultC = unlockVault(TEST_MASTER_PASSWORD, C.vaultFile);

  // 1. قفل الكتابة
  acquireLease(A);
  assert.equal(readLeaseStatus(A).kind, 'mine');
  assert.equal(readLeaseStatus(B).kind, 'other');
  assert.throws(() => acquireLease(B), /الكتابة الآن على جهاز «Asus-Windows»/);
  // منذ 2.0 لا قفل للكتابة: الحارس يسمح دائماً، وقفل 1.9 يبقى فقط للأجهزة القديمة
  assert.equal(checkWriteAccess(B).allowed, true, '2.0: كل جهاز يكتب');
  assert.equal(checkWriteAccess(A).allowed, true);
  assert.equal(heartbeatLease(B), false, 'غير الحامل لا يرسل إشارة حياة');
  const later = Date.now() + LEASE_EXPIRY_MS + 60000;
  assert.equal(readLeaseStatus(B, later).kind, 'other-expired', 'القفل ينتهي بعد 30 دقيقة بلا إشارة حياة');
  acquireLease(B, { now: later });
  assert.equal(readLeaseStatus(A).kind, 'other');
  acquireLease(A, { force: true });
  assert.equal(readLeaseStatus(A).kind, 'mine', 'النقل القسري بتأكيد صريح');
  passedChecks.push('اختبار قفل 1.9 (للأجهزة القديمة: الأخذ، الرفض، الانتهاء بعد 30 دقيقة، النقل القسري) والحارس في 2.0 يسمح دائماً بنجاح.');

  // 2. النشر والاستيراد والمطابقة التامة
  writeFixtureFile(path.join(A.obsidianDir, '02-Projects', 'App', 'Overview.md'), '# نظرة عامة من الويندوز');
  writeFixtureFile(path.join(A.dataDir, 'conversations', 'conv-aaaa-1111.enc.json'), '{"sealed":"x"}');
  writeFixtureFile(path.join(A.dataDir, 'ai-memory-store.json'), '[{"id":"m1"}]');
  writeFixtureFile(A.settingsPath, JSON.stringify({ watchedProjects: [{ id: 'app', name: 'App', path: 'D:\\Projects\\App' }], aiConfig: { ollamaModel: 'model-of-A' } }));
  const p1 = publishSnapshot(A, vaultA);
  assert.deepEqual(p1, { published: true, version: 1 });
  assert.equal(readManifest(B)?.device.deviceName, 'Asus-Windows');
  const snapFile = path.join(syncRoot, 'snapshots', readManifest(A)!.file);
  assert.ok(!read(snapFile).includes('نظرة عامة'), 'محتوى النسخة مشفّر على Drive');
  assert.equal(publishSnapshot(A, vaultA).published, false, 'لا نشر بلا تغييرات');

  writeFixtureFile(path.join(B.obsidianDir, 'only-on-mac.md'), 'سيُحذف لأنه ليس في النسخة');
  writeFixtureFile(path.join(B.obsidianDir, '.obsidian', 'workspace.json'), '{"local":true}');
  assert.equal(checkSync(B).newerAvailable, true);
  const imp = importLatestSnapshot(B, vaultB);
  assert.equal(imp.imported, true);
  assert.equal(imp.version, 1);
  assert.equal(read(path.join(B.obsidianDir, '02-Projects', 'App', 'Overview.md')), '# نظرة عامة من الويندوز');
  assert.equal(read(path.join(B.dataDir, 'conversations', 'conv-aaaa-1111.enc.json')), '{"sealed":"x"}');
  assert.equal(read(path.join(B.dataDir, 'ai-memory-store.json')), '[{"id":"m1"}]');
  assert.equal(fs.existsSync(path.join(B.obsidianDir, 'only-on-mac.md')), false, 'المطابقة التامة: يُحذف ما ليس في النسخة');
  assert.equal(read(path.join(B.obsidianDir, '.obsidian', 'workspace.json')), '{"local":true}', 'ملفات واجهة Obsidian المحلية لا تُمس');
  const bSettings = JSON.parse(read(B.settingsPath));
  assert.equal(bSettings.watchedProjects[0].id, 'app', 'قائمة المشاريع مشتركة');
  assert.equal(bSettings.aiConfig.ollamaModel, 'model-of-MacBook-M5', 'إعدادات الجهاز الأخرى لا تُزامَن');
  assert.ok(fs.readdirSync(path.join(B.dataDir, 'sync-backups')).some((n) => n.startsWith('pre-import-')), 'نسخة احتياطية محلية قبل الاستيراد');
  assert.equal(readLocalSyncState(B).baseVersion, 1);
  assert.equal(importLatestSnapshot(B, vaultB).imported, false, 'لا استيراد إن لم يوجد أحدث');
  passedChecks.push('اختبار النشر والاستيراد (تشفير المحتوى، المطابقة التامة، حفظ ملفات الواجهة المحلية، إعدادات كل جهاز، نسخة احتياطية قبل الاستيراد) بنجاح.');

  // 3. رفض النشر فوق إصدار أحدث، ثم الحل بالاستيراد
  importLatestSnapshot(C, vaultC);
  writeFixtureFile(path.join(A.obsidianDir, 'decision.md'), 'قرار جديد');
  assert.equal(publishSnapshot(A, vaultA).version, 2);
  acquireLease(C, { force: true });
  writeFixtureFile(path.join(C.obsidianDir, 'stale-edit.md'), 'تعديل على نسخة قديمة');
  assert.throws(() => publishSnapshot(C, vaultC), /إصدار أحدث \(2\) من «Asus-Windows»/);
  const cImp = importLatestSnapshot(C, vaultC);
  assert.equal(cImp.hadLocalChanges, true, 'يُبلَّغ بأن التغييرات المحلية حُفظت احتياطياً');
  assert.equal(publishSnapshot(C, vaultC, { force: true }).version, 3);
  assert.throws(() => publishSnapshot(A, vaultA), /لا يملك هذا الجهاز صلاحية الكتابة/);
  releaseLease(C);
  assert.equal(readLeaseStatus(A).kind, 'none');
  passedChecks.push('اختبار منع التعارض (رفض النشر فوق إصدار أحدث، الاستيراد مع حفظ التغييرات المحلية، رفض النشر بلا صلاحية، ترك القفل) بنجاح.');

  // 3.5 الأرشفة بعد الاستيراد: محادثة أرشفها الجهاز ولم تُنشر تُحذف بالمطابقة، فيُنسى سجلها لتُعاد أرشفتها
  const H = makeDevice(base, 'Harvest-Laptop', syncRoot, config.paths.encryptedVaultFile);
  const keptArchive = path.join(H.obsidianDir, '02-Projects', 'App', 'Overview.md');
  const unpublishedArchive = path.join(H.obsidianDir, '03-AI-Shared-Memory', 'Claude-Code-Sessions', 'Claude-Code-local-only.md');
  writeFixtureFile(unpublishedArchive, '# محادثة مؤرشفة محلياً ولم تُنشر');
  writeFixtureFile(
    path.join(H.dataDir, 'harvest-state.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        'claude-code:published': { modifiedMs: 1, sizeBytes: 1, outFile: keptArchive, archivedAt: '2026-11-15T00:00:00Z' },
        'claude-code:unpublished': { modifiedMs: 1, sizeBytes: 1, outFile: unpublishedArchive, archivedAt: '2026-11-15T00:00:00Z' },
      },
    })
  );
  const hImp = importLatestSnapshot(H, unlockVault(TEST_MASTER_PASSWORD, H.vaultFile));
  assert.equal(hImp.reharvest, 1, 'جلسة واحدة ستُعاد أرشفتها');
  assert.equal(fs.existsSync(unpublishedArchive), false, 'المطابقة حذفت الأرشيف غير المنشور');
  const hState = JSON.parse(read(path.join(H.dataDir, 'harvest-state.json'))).sessions;
  assert.ok(hState['claude-code:published'], 'سجل الأرشيف الموجود في النسخة يبقى');
  assert.equal(hState['claude-code:unpublished'], undefined, 'سجل الأرشيف المحذوف يُنسى فتُعاد أرشفته');
  passedChecks.push('اختبار إعادة الأرشفة بعد الاستيراد (يُنسى سجل المحادثة التي حذفتها المطابقة، ويبقى سجل الموجود) بنجاح.');

  // 4. خزنة مختلفة ونسخة معدّلة وملف لم يصل بعد
  const D = makeDevice(base, 'Stranger', syncRoot, config.paths.encryptedVaultFile);
  fs.rmSync(D.vaultFile);
  createVault('Another-Strong-Pass-2026', D.vaultFile);
  const vaultD = unlockVault('Another-Strong-Pass-2026', D.vaultFile);
  assert.throws(() => importLatestSnapshot(D, vaultD), /مشفرة بخزنة مختلفة/);
  const manifest = readManifest(A)!;
  const snapPath = path.join(syncRoot, 'snapshots', manifest.file);
  const original = read(snapPath);
  fs.writeFileSync(snapPath, original.replace(/"contentHash":"[0-9a-f]+"/, `"contentHash":"${'0'.repeat(64)}"`));
  const E = makeDevice(base, 'Laptop-2', syncRoot, config.paths.encryptedVaultFile);
  assert.throws(() => importLatestSnapshot(E, unlockVault(TEST_MASTER_PASSWORD, E.vaultFile)), /بصمة النسخة لا تطابق/);
  fs.rmSync(snapPath);
  assert.throws(() => importLatestSnapshot(E, unlockVault(TEST_MASTER_PASSWORD, E.vaultFile)), /ما زال Google Drive/);
  fs.writeFileSync(snapPath, original);
  passedChecks.push('اختبار الحماية (رفض نسخة من خزنة مختلفة، رفض نسخة معدّلة البصمة، انتظار ملف لم يُنزَّل بعد من Drive) بنجاح.');

  // 5. مسار المشروع لكل جهاز (في بيئة الاختبار الحقيقية)
  const project = loadSystemConfig().watchedProjects[0];
  const originPath = (readRawSettings().watchedProjects as Array<{ id: string; path: string }>).find((p) => p.id === project.id)!.path;
  const localDir = path.join(base, 'local-copy-of-project');
  fs.mkdirSync(localDir, { recursive: true });
  setDeviceProjectPath(project.id, localDir);
  assert.equal(readDevicePathOverrides(config.paths.rootDir)[project.id], path.resolve(localDir));
  const withOverride = loadSystemConfig().watchedProjects.find((p) => p.id === project.id)!;
  assert.equal(withOverride.path, path.resolve(localDir), 'المسار المحلي يتقدّم على المشترك');
  registerWatchedProject({ ...withOverride, descriptionAr: 'وصف معدّل' });
  const raw = (readRawSettings().watchedProjects as Array<{ id: string; path: string; descriptionAr: string }>).find((p) => p.id === project.id)!;
  assert.equal(raw.path, originPath, 'حفظ المشروع لا يكتب مسار هذا الجهاز فوق المسار المشترك');
  assert.equal(raw.descriptionAr, 'وصف معدّل');
  setDeviceProjectPath(project.id, null);
  assert.equal(loadSystemConfig().watchedProjects.find((p) => p.id === project.id)!.path, project.path);
  passedChecks.push('اختبار مسارات المشاريع لكل جهاز (التحديد المحلي، تقدّمه على المشترك، عدم الكتابة فوق المسار المشترك، الإلغاء) بنجاح.');

  // اقتراح مجلد Google Drive على الماك بكل لغات الواجهة («My Drive»، و«ملفاتي» على الماك العربي)
  const fakeHome = path.join(loadSystemConfig().paths.rootDir, 'fake-mac-home');
  const cloud = path.join(fakeHome, 'Library', 'CloudStorage');
  assert.deepEqual(detectDriveFolders({ platform: 'darwin', homeDir: fakeHome }), [], 'بلا Google Drive لا اقتراحات');
  const arabicRoot = path.join(cloud, 'GoogleDrive-arabic', 'ملفاتي');
  const englishRoot = path.join(cloud, 'GoogleDrive-english', 'My Drive');
  fs.mkdirSync(path.join(arabicRoot, DRIVE_APP_FOLDER), { recursive: true });
  fs.mkdirSync(englishRoot, { recursive: true });
  fs.mkdirSync(path.join(cloud, 'Dropbox', 'My Drive'), { recursive: true });
  const suggested = detectDriveFolders({ platform: 'darwin', homeDir: fakeHome });
  assert.equal(suggested[0], path.join(arabicRoot, DRIVE_APP_FOLDER), 'المجلد المعتمد داخل «ملفاتي» يأتي أولاً');
  assert.ok(suggested.includes(arabicRoot), '«ملفاتي» (الماك بالعربية) يُكتشف');
  assert.ok(suggested.includes(englishRoot), '«My Drive» يُكتشف');
  assert.ok(!suggested.some((p) => p.includes('Dropbox')), 'مجلدات غير Google Drive لا تُقترح');
  fs.rmSync(fakeHome, { recursive: true, force: true });
  passedChecks.push('اختبار اقتراح مجلد Google Drive على الماك («My Drive» و«ملفاتي» بالعربية، والمجلد المعتمد أولاً، وتجاهل غير Google Drive) بنجاح.');

  // 6. الخادم في 2.0: الترحيل التلقائي عند فتح الخزنة، والكتابة بلا قفل، وقفل الأجهزة القديمة
  const serverDrive = path.join(base, 'Server-Drive');
  fs.mkdirSync(serverDrive, { recursive: true });
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const deviceFile = path.join(dataDir, 'device.json');
  writeFixtureFile(deviceFile, JSON.stringify({ deviceId: 'id-this-laptop', deviceName: 'This-Laptop', platform: 'test' }));
  const originalSettings = readRawSettings();
  updateSystemSettings({ sync: { enabled: true, folder: serverDrive } });
  // جهاز آخر بإصدار 1.9 ينشر نسخة قديمة بنفس الخزنة ويحمل قفل 1.9
  const otherRoot = path.join(serverDrive, 'Second-Brain-Sync');
  const Other = makeDevice(base, 'Other-Mac', otherRoot, config.paths.encryptedVaultFile);
  const vaultOther = unlockVault(TEST_MASTER_PASSWORD, Other.vaultFile);
  writeFixtureFile(
    path.join(Other.dataDir, 'ai-memory-store.json'),
    JSON.stringify([{ id: 'from-mac', sourceAI: 'manual', projectId: 'second-brain', title: 'قرار من الماك', summaryAr: 'من الماك', keyDecisionsAr: [], createdAt: new Date().toISOString() }])
  );
  acquireLease(Other);
  publishSnapshot(Other, vaultOther, { force: true });

  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const before = JSON.parse((await rawRequest(port, { path: '/api/sync/status' })).body);
    assert.equal(before.ready, true);
    assert.equal(before.multiWriter, true);
    assert.equal(before.migrated, false, 'قبل فتح الخزنة لم يُرحَّل الجهاز');
    assert.match(before.problemAr ?? '', /افتح الخزنة/);

    // ملف manifest غير مقروء: الترحيل يتوقف دون بناء الفهرس (لا يُعامل كأنه غير موجود — ISS-013)
    const manifestFile = path.join(otherRoot, 'manifest.json');
    const manifestText = read(manifestFile);
    fs.rmSync(manifestFile);
    fs.mkdirSync(manifestFile);
    assert.throws(() => readManifest(Other), /manifest\.json/, 'manifest غير المقروء خطأ، لا «لا يوجد»');
    const failedUnlock = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    assert.equal(failedUnlock.status, 200, 'فشل المزامنة لا يمنع فتح الخزنة');
    assert.match(JSON.parse(failedUnlock.body).syncMessageAr ?? '', /manifest\.json/);
    assert.equal(fs.existsSync(path.join(dataDir, 'sync', 'index.json')), false, 'لم يُبنَ الفهرس على أساس غير معروف');
    fs.rmSync(manifestFile, { recursive: true });
    fs.writeFileSync(manifestFile, manifestText);
    // إغلاق الجلسة دون دورة مزامنة (القفل العادي يُشغّل دورة، فيرحّل الجهاز قبل الفتح التالي)
    resetSessionStateForTests();

    const unlock = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    assert.equal(unlock.status, 200);
    assert.match(JSON.parse(unlock.body).syncMessageAr ?? '', /رُحّل هذا الجهاز إلى المزامنة الجديدة/, 'الترحيل التلقائي عند فتح الخزنة');
    assert.match(read(path.join(dataDir, 'ai-memory-store.json')), /from-mac/, 'الترحيل استورد آخر نسخة قديمة أولاً');
    const cookie = String(unlock.headers['set-cookie'] ?? '').split(';')[0];
    const index = JSON.parse(read(path.join(dataDir, 'sync', 'index.json')));
    assert.equal(index.origin.kind, 'legacy-migration');
    assert.equal(index.origin.legacyVersion, 1);

    // قفل الأجهزة القديمة: جهاز 1.9 يرى الكتابة عند «Second Brain 2.0» ولا تنتهي، فيبقى في وضع القراءة
    const legacyView = readLeaseStatus(Other);
    assert.equal(legacyView.kind, 'other', 'الجهاز القديم في وضع القراءة');
    assert.match(legacyView.kind === 'other' ? legacyView.lease.deviceName : '', /حدّث هذا الجهاز إلى الإصدار 2\.0/);
    assert.equal(readLeaseStatus(Other, Date.now() + 365 * 24 * 3600 * 1000).kind, 'other', 'قفل الأجهزة القديمة لا ينتهي');
    assert.throws(() => publishSnapshot(Other, vaultOther), /لا يملك هذا الجهاز صلاحية الكتابة/);
    assert.equal(JSON.parse(read(manifestFile)).minAppVersion, '2.0.0');

    // الكتابة بلا قفل: إضافة مشروع وحفظ المحادثة يعملان دائماً
    const added = await postJson(port, '/api/projects/add', { name: 'X', path: base }, cookie);
    assert.equal(added.status, 200, added.body);
    const chat = await postJson(port, '/api/assistant/stream', { question: 'سؤال في 2.0', mode: 'commander' }, cookie);
    assert.equal(JSON.parse(/event: done\ndata: (.*)/.exec(chat.body)![1]).saved, true, 'المحادثة تُحفظ على كل جهاز');
    const now1 = await postJson(port, '/api/sync/now', {}, cookie);
    assert.equal(now1.status, 200, now1.body);
    assert.match(JSON.parse(now1.body).messageAr, /نُشر \d+ تغييراً/, 'زامن الآن ينشر التغييرات');
    const changesDir = path.join(otherRoot, 'changes', 'id-this-laptop');
    assert.ok(fs.readdirSync(changesDir).length >= 1, 'دفعة تغييرات في مجلد هذا الجهاز فقط');
    assert.ok(!fs.readdirSync(changesDir).some((n) => read(path.join(changesDir, n)).includes('سؤال في 2.0')), 'الدفعات مشفّرة على Drive');
    const after = JSON.parse((await rawRequest(port, { path: '/api/sync/status' })).body);
    assert.equal(after.migrated, true);
    assert.ok(after.devices.some((d: { deviceName: string; syncFormat: number }) => d.deviceName === 'This-Laptop' && d.syncFormat === 2));
    for (const gone of ['/api/sync/take-lease', '/api/sync/publish', '/api/sync/release']) {
      assert.equal((await postJson(port, gone, {}, cookie)).status, 404, `${gone} أُزيل في 2.0`);
    }
    const appJs = read(path.join(import.meta.dirname, '..', 'src', 'features', 'dashboard-app', 'public', 'app.js'));
    assert.ok(!appJs.includes('sync-take') && !appJs.includes('readonlyBanner'), 'الواجهة بلا أزرار القفل ولا شريط وضع القراءة');
    passedChecks.push('اختبار الخادم في 2.0 (manifest غير مقروء يوقف الترحيل، الترحيل التلقائي عند فتح الخزنة، قفل الأجهزة القديمة على وضع القراءة، الكتابة وحفظ المحادثات بلا قفل، زامن الآن، دفعات مشفّرة، إزالة مسارات القفل) بنجاح.');

    // سجل ذاكرة ناقص (ملف تالف أو مستورد) لا يُسقط المحادثة
    const memFile = path.join(dataDir, 'ai-memory-store.json');
    const memBefore = read(memFile);
    fs.writeFileSync(memFile, JSON.stringify([{ id: 'broken', summaryAr: 'بلا حقول' }, ...JSON.parse(memBefore)]));
    const robust = await postJson(port, '/api/assistant/stream', { question: 'هل تعمل؟', mode: 'commander' }, cookie);
    assert.match(robust.body, /event: done/, 'السجل الناقص يُتجاهل ولا يُسقط المساعد');
    fs.writeFileSync(memFile, memBefore);
    passedChecks.push('اختبار تجاهل سجل ذاكرة ناقص الحقول بدل إسقاط المساعد بنجاح.');

    const deadlock = Object.assign(new Error('Unknown system error -11'), { errno: -11 });
    assert.match(describeSyncIoError(deadlock), /install-macos\.sh.*1\.9\.3/, 'رسالة عربية واضحة لخطأ Google Drive على الماك');
    assert.match(describeSyncIoError(Object.assign(new Error('x'), { code: 'EDEADLK' })), /Google Drive/);
    passedChecks.push('اختبار رسالة EDEADLK (Google Drive على الماك) بالعربية بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    updateSystemSettings({ sync: originalSettings.sync ?? { enabled: false, folder: '' } });
    fs.rmSync(deviceFile, { force: true });
    fs.rmSync(path.join(dataDir, 'sync'), { recursive: true, force: true });
  }
  return passedChecks;
}
