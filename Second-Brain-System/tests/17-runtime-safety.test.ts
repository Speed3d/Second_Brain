/**
 * ============================================================================
 * الملف: tests/17-runtime-safety.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: حمايات المرحلة 2 الأولى (docs/12):
 *               ISS-032: الخادم يكشف أن الكود على القرص أحدث منه، فيوقف المزامنة ويطلب إعادة التشغيل،
 *               وزر إعادة التشغيل يخرج برمز 75 فيعيده المشغّل بالكود الجديد.
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
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

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
  passed.push('اختبار إعادة التشغيل من الواجهة (المشغّلان يعيدان الخادم عند الرمز 75، والشريط والزر في الواجهة) بنجاح.');
  return passed;
}
