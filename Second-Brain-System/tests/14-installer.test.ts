/**
 * ============================================================================
 * الملف: tests/14-installer.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المرحلة ب (المثبّت والتشغيل التلقائي): سلامة صياغة سكربتات Windows و macOS،
 *               وأن وضع المعاينة في مثبّت Windows لا يغيّر أي شيء، وأن الأيقونات موجودة وتُخدَم للواجهة.
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
  passedChecks.push('اختبار صياغة سكربتات PowerShell (مع ترميز UTF-8 BOM) وسكربتات bash للماك بنجاح.');

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
