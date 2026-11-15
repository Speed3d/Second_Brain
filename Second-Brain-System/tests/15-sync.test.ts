/**
 * ============================================================================
 * الملف: tests/15-sync.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المرحلة ج (المزامنة بين الأجهزة) بمحاكاة 3 أجهزة في مجلدات مؤقتة ومجلد Drive وهمي:
 *               قفل الكتابة ونقله وانتهاؤه، النشر والاستيراد والمطابقة التامة، رفض النشر فوق إصدار أحدث،
 *               النسخة الاحتياطية قبل الاستيراد، رفض خزنة مختلفة أو نسخة معدّلة، مسارات المشاريع لكل جهاز،
 *               ووضع القراءة في الخادم (رفض الكتابة 423، عدم حفظ المحادثات) والاستيراد التلقائي عند فتح الخزنة.
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
import { acquireLease, checkWriteAccess, heartbeatLease, LEASE_EXPIRY_MS, readLeaseStatus, readLocalSyncState, releaseLease, type SyncContext } from '../src/features/sync/sync-context.ts';
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
  assert.equal(checkWriteAccess(B).allowed, false);
  assert.match(checkWriteAccess(B).reasonAr ?? '', /وضع القراءة/);
  assert.equal(checkWriteAccess(A).allowed, true);
  assert.equal(heartbeatLease(B), false, 'غير الحامل لا يرسل إشارة حياة');
  const later = Date.now() + LEASE_EXPIRY_MS + 60000;
  assert.equal(readLeaseStatus(B, later).kind, 'other-expired', 'القفل ينتهي بعد 30 دقيقة بلا إشارة حياة');
  acquireLease(B, { now: later });
  assert.equal(readLeaseStatus(A).kind, 'other');
  acquireLease(A, { force: true });
  assert.equal(readLeaseStatus(A).kind, 'mine', 'النقل القسري بتأكيد صريح');
  passedChecks.push('اختبار قفل الكتابة (الأخذ، الرفض لجهاز آخر، وضع القراءة، الانتهاء بعد 30 دقيقة، النقل القسري) بنجاح.');

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

  // 6. الخادم: الإعداد، الاستيراد عند فتح الخزنة، ووضع القراءة
  const serverDrive = path.join(base, 'Server-Drive');
  fs.mkdirSync(serverDrive, { recursive: true });
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const deviceFile = path.join(dataDir, 'device.json');
  writeFixtureFile(deviceFile, JSON.stringify({ deviceId: 'id-this-laptop', deviceName: 'This-Laptop', platform: 'test' }));
  const originalSettings = readRawSettings();
  updateSystemSettings({ sync: { enabled: true, folder: serverDrive } });
  // جهاز آخر ينشر إصداراً بنفس الخزنة
  const Other = makeDevice(base, 'Other-Mac', path.join(serverDrive, 'Second-Brain-Sync'), config.paths.encryptedVaultFile);
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
    const status = JSON.parse((await rawRequest(port, { path: '/api/sync/status' })).body);
    assert.equal(status.ready, true);
    assert.equal(status.canWrite, false);
    assert.equal(status.lease.holder, 'Other-Mac');
    assert.equal(status.newerAvailable, true);

    const unlock = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    assert.equal(unlock.status, 200);
    assert.match(JSON.parse(unlock.body).syncMessageAr ?? '', /استُورد الإصدار 1 من «Other-Mac»/, 'الاستيراد التلقائي عند فتح الخزنة');
    assert.match(read(path.join(dataDir, 'ai-memory-store.json')), /from-mac/);
    const cookie = String(unlock.headers['set-cookie'] ?? '').split(';')[0];

    const blocked = await postJson(port, '/api/projects/add', { name: 'X', path: base }, cookie);
    assert.equal(blocked.status, 423, 'وضع القراءة يرفض الكتابة على البيانات المشتركة');
    assert.match(JSON.parse(blocked.body).error, /الكتابة الآن على «Other-Mac»/);
    const chat = await postJson(port, '/api/assistant/stream', { question: 'سؤال في وضع القراءة', mode: 'commander' }, cookie);
    const done = JSON.parse(/event: done\ndata: (.*)/.exec(chat.body)![1]);
    assert.equal(done.saved, false);
    assert.match(done.saveBlockedAr, /وضع القراءة/, 'المحادثة لا تُحفظ في وضع القراءة، مع السبب');

    const take = await postJson(port, '/api/sync/take-lease', { force: true }, cookie);
    assert.equal(take.status, 200, take.body);
    assert.equal(JSON.parse(take.body).status.canWrite, true);
    const allowed = await postJson(port, '/api/assistant/stream', { question: 'سؤال بعد نقل الكتابة', mode: 'commander' }, cookie);
    assert.equal(JSON.parse(/event: done\ndata: (.*)/.exec(allowed.body)![1]).saved, true);
    const pub = await postJson(port, '/api/sync/publish', {}, cookie);
    assert.match(JSON.parse(pub.body).messageAr, /نُشر الإصدار 2/);
    assert.equal(readManifest(Other)!.device.deviceName, 'This-Laptop');
    passedChecks.push('اختبار المزامنة عبر الخادم (الحالة، الاستيراد عند فتح الخزنة، رفض الكتابة 423 وعدم حفظ المحادثات في وضع القراءة، نقل الكتابة والنشر) بنجاح.');

    // سجل ذاكرة ناقص (ملف تالف أو مستورد) لا يُسقط المحادثة
    const memFile = path.join(dataDir, 'ai-memory-store.json');
    const memBefore = read(memFile);
    fs.writeFileSync(memFile, JSON.stringify([{ id: 'broken', summaryAr: 'بلا حقول' }, ...JSON.parse(memBefore)]));
    const robust = await postJson(port, '/api/assistant/stream', { question: 'هل تعمل؟', mode: 'commander' }, cookie);
    assert.match(robust.body, /event: done/, 'السجل الناقص يُتجاهل ولا يُسقط المساعد');
    fs.writeFileSync(memFile, memBefore);
    passedChecks.push('اختبار تجاهل سجل ذاكرة ناقص الحقول بدل إسقاط المساعد بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    updateSystemSettings({ sync: originalSettings.sync ?? { enabled: false, folder: '' } });
    fs.rmSync(deviceFile, { force: true });
  }
  return passedChecks;
}
