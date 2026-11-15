/**
 * ============================================================================
 * الملف: tests/14-installer.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المرحلة ب (المثبّت والتشغيل التلقائي): سلامة صياغة سكربتات Windows و macOS،
 *               وأن وضع المعاينة في مثبّت Windows لا يغيّر أي شيء، وأن الأيقونات موجودة وتُخدَم للواجهة،
 *               وأن هوية الجهاز المنقولة من نظام آخر تُستبدل بنسخة احتياطية (في مجلد مؤقت فقط).
 *               لا تُنشئ هذه الاختبارات أي اختصار ولا تشغّل الخادم في الخلفية.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, readAppVersion } from '../src/core/config-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { rawRequest } from './06-security.test.ts';
import { applyDeviceIdentity, planDeviceIdentity } from '../install/device-identity.ts';

const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install');

/**
 * Hint بالعربي: دالة تشغيل اختبارات المثبّت وإرجاع نتائج الفحص.
 */
export async function runInstallerTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // 1. الملفات موجودة، والأيقونة ICO صالحة
  const expected = [
    'second-brain.ico',
    'windows/common.ps1',
    'windows/run-server.ps1',
    'windows/open-app.ps1',
    'windows/install-windows.ps1',
    'windows/uninstall-windows.ps1',
    'windows/start-hidden.vbs',
    'windows/open-app.vbs',
    'macos/install-macos.sh',
    'macos/open-app.sh',
    'macos/uninstall-macos.sh',
    'device-identity.ts',
  ];
  for (const f of expected) assert.ok(fs.existsSync(path.join(INSTALL_DIR, f)), `الملف موجود: ${f}`);
  const ico = fs.readFileSync(path.join(INSTALL_DIR, 'second-brain.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'ملف ICO');
  assert.ok(ico.readUInt16LE(4) >= 4, 'أحجام متعددة للأيقونة');
  passedChecks.push('اختبار وجود ملفات المثبّت لـ Windows و macOS وصلاحية الأيقونة متعددة الأحجام بنجاح.');

  // 2. صياغة السكربتات
  if (process.platform === 'win32') {
    for (const f of expected.filter((x) => x.endsWith('.ps1'))) {
      const file = path.join(INSTALL_DIR, f).replace(/'/g, "''");
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' });
      assert.equal(r.stdout.trim(), '0', `لا أخطاء صياغة في ${f}`);
      assert.deepEqual([...fs.readFileSync(path.join(INSTALL_DIR, f)).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${f} بترميز UTF-8 مع BOM (يتطلبه PowerShell 5.1 للعربية)`);
    }
  }
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status === 0) {
    for (const f of expected.filter((x) => x.endsWith('.sh'))) {
      assert.equal(spawnSync('bash', ['-n', path.join(INSTALL_DIR, f)]).status, 0, `لا أخطاء صياغة في ${f}`);
    }
  }
  assert.match(fs.readFileSync(path.join(INSTALL_DIR, 'macos', 'install-macos.sh'), 'utf8'), /<key>MaterializeDatalessFiles<\/key><true\/>/, 'خادم الماك مسموح له بتنزيل ملفات Google Drive الموجودة في السحابة فقط');
  passedChecks.push('اختبار صياغة سكربتات PowerShell (مع ترميز UTF-8 BOM) وسكربتات bash للماك بنجاح.');

  // 2ب. هوية الجهاز: إنشاء، إبقاء لنفس النظام، واستبدال المنقول من نظام آخر أو التالف مع نسخة احتياطية
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-device-'));
  try {
    const devFile = path.join(devDir, 'data', 'device.json');
    assert.equal(planDeviceIdentity(devFile, 'macos').kind, 'create');
    const created = applyDeviceIdentity(devFile, 'macos', 'Test-Mac');
    assert.equal(created.plan.kind, 'create');
    assert.equal(JSON.parse(fs.readFileSync(devFile, 'utf8')).platform, 'macos');
    const kept = applyDeviceIdentity(devFile, 'macos', 'Other-Name');
    assert.equal(kept.plan.kind, 'keep', 'نفس النظام: تبقى الهوية');
    assert.equal(kept.identity.deviceId, created.identity.deviceId);

    // ملف منقول من Windows (مع BOM كما يكتبه PowerShell أحياناً)
    const windowsIdentity = { deviceId: 'win-id-1', deviceName: 'DESKTOP-TEST', platform: 'windows', createdAt: '2026-01-01T00:00:00Z' };
    fs.writeFileSync(devFile, '\uFEFF' + JSON.stringify(windowsIdentity));
    const cli = path.join(INSTALL_DIR, 'device-identity.ts');
    const preview = spawnSync(process.execPath, [cli, '--file', devFile, '--platform', 'macos', '--name', 'Test-Mac', '--preview'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /DESKTOP-TEST/);
    assert.match(preview.stdout, /device\.windows\.json\.bak/);
    assert.equal(JSON.parse(fs.readFileSync(devFile, 'utf8').replace(/^\uFEFF/, '')).deviceId, 'win-id-1', 'المعاينة لا تغيّر شيئاً');
    const real = spawnSync(process.execPath, [cli, '--file', devFile, '--platform', 'macos', '--name', 'Test-Mac'], { encoding: 'utf8' });
    assert.equal(real.status, 0, real.stderr);
    const fresh = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    assert.equal(fresh.platform, 'macos');
    assert.equal(fresh.deviceName, 'Test-Mac');
    assert.notEqual(fresh.deviceId, 'win-id-1', 'هوية جديدة للجهاز الجديد');
    const backup = path.join(devDir, 'data', 'device.windows.json.bak');
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8').replace(/^\uFEFF/, '')).deviceId, 'win-id-1', 'الهوية القديمة محفوظة لا محذوفة');

    // نسخة احتياطية سابقة لا يُكتب فوقها، والملف التالف يُستبدل
    fs.writeFileSync(devFile, JSON.stringify({ ...windowsIdentity, deviceId: 'win-id-2' }));
    applyDeviceIdentity(devFile, 'macos', 'Test-Mac');
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8').replace(/^\uFEFF/, '')).deviceId, 'win-id-1', 'النسخة الاحتياطية الأولى سليمة');
    assert.equal(fs.readdirSync(path.join(devDir, 'data')).filter((f) => f.startsWith('device.windows.')).length, 2);
    fs.writeFileSync(devFile, '{ not json');
    const broken = applyDeviceIdentity(devFile, 'windows', 'Test-PC');
    assert.equal(broken.plan.kind, 'replace');
    assert.ok(fs.existsSync(path.join(devDir, 'data', 'device.invalid.json.bak')));
    assert.equal(spawnSync(process.execPath, [cli, '--file', devFile], { encoding: 'utf8' }).status, 2, 'معاملات ناقصة تُرفض');
  } finally {
    fs.rmSync(devDir, { recursive: true, force: true });
  }
  passedChecks.push('اختبار هوية الجهاز عند التثبيت (إنشاء، إبقاء لنفس النظام، واستبدال المنقول من نظام آخر أو التالف بنسخة احتياطية دون حذف، والمعاينة لا تغيّر شيئاً) بنجاح.');

  // 3. وضع المعاينة لا يغيّر أي شيء
  if (process.platform === 'win32') {
    const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Second Brain (Background).lnk');
    const before = fs.existsSync(startup);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(INSTALL_DIR, 'windows', 'install-windows.ps1'), '-Preview', '-DeviceName', 'Test-Device'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /وضع المعاينة/);
    assert.equal(fs.existsSync(startup), before, 'المعاينة لا تنشئ اختصار التشغيل التلقائي');
    passedChecks.push('اختبار وضع المعاينة في مثبّت Windows (يعرض الخطوات ولا يغيّر شيئاً) بنجاح.');
  }

  // 4. أيقونة الواجهة تُخدَم
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const icon = await rawRequest(port, { path: '/assets/icon.svg' });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.ok(icon.body.includes('<svg'));
    assert.match((await rawRequest(port, { path: '/' })).body, /rel="icon"[^>]+\/assets\/icon\.svg/);
    assert.equal((await rawRequest(port, { path: '/assets/evil.svg' })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  passedChecks.push('اختبار أيقونة النافذة (تُخدَم للواجهة كـ SVG، والملفات غير المسموحة مرفوضة) بنجاح.');

  // 5. نظام الإصدارات: package.json هو المصدر، ولكل إصدار قسم في CHANGELOG.md
  const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve(INSTALL_DIR, '..', 'package.json'), 'utf8')) as { version: string }).version;
  assert.match(pkgVersion, /^\d+\.\d+\.\d+$/, 'رقم الإصدار بصيغة رئيسي.فرعي.إصلاح');
  assert.equal(readAppVersion(), pkgVersion, 'البرنامج يقرأ الإصدار من package.json');
  assert.equal(loadSystemConfig().version, pkgVersion, 'الإصدار المعروض في الواجهة هو إصدار package.json');
  const changelog = fs.readFileSync(path.resolve(INSTALL_DIR, '..', '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## [${pkgVersion}]`), `يجب توثيق الإصدار ${pkgVersion} في CHANGELOG.md قبل رفعه`);
  const listed = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  assert.equal(listed[0], pkgVersion, 'الإصدار الحالي هو أول قسم في السجل (الأحدث أولاً)');
  passedChecks.push(`اختبار نظام الإصدارات (الإصدار ${pkgVersion} من package.json، وموثّق أولاً في CHANGELOG.md) بنجاح.`);
  return passedChecks;
}
