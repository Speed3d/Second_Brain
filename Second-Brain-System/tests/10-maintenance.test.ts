/**
 * ============================================================================
 * الملف: tests/10-maintenance.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات وضع التطوير (المرحلة أ.4): التصفير إلى السلة (مع عبارة التأكيد وصلاحية الإعدادات)،
 *               ما يُنقل وما لا يُمس، الاسترجاع مع حفظ الحالة الحالية، إفراغ السلة، والاعتماد النهائي الذي
 *               يجعل الخادم يرفض التصفير. يعمل بالكامل داخل البيئة المؤقتة المعزولة، ويعيدها كما كانت في النهاية.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, readRawSettings, resolveDefaultConfigPath, resolveSettingsPath, updateSystemSettings } from '../src/core/config-manager.ts';
import { listTrashBatches, matchesConfirmPhrase, resolveSystemDataDir } from '../src/features/maintenance/reset-service.ts';
import { vaultExists } from '../src/features/vault/vault-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات وضع التطوير والتصفير وإرجاع نتائج الفحص.
 */
export async function runMaintenanceTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  assert.ok(matchesConfirmPhrase('  افراغ   السلة ', 'إفراغ السلة'), 'الهمزات والمسافات لا تُفشل عبارة التأكيد');
  assert.equal(matchesConfirmPhrase('تصفيرر', 'تصفير'), false);

  const config = loadSystemConfig();
  // حماية: هذا الاختبار لا يعمل إلا داخل البيئة المؤقتة المعزولة
  assert.ok(process.env.SECOND_BRAIN_CONFIG_PATH && config.paths.rootDir.includes('second-brain-tests-'), 'اختبار التصفير يعمل في البيئة المعزولة فقط');
  ensureTestVault();
  const profileFile = path.join(config.paths.obsidianVaultDir, '01-Commander-Profile', 'About-Commander.md');
  writeFixtureFile(profileFile, '# ملف القائد (يدوي — لا يُمس)');
  const backupFile = path.join(config.paths.encryptedBackupsDir, 'keep-me.sbbackup');
  writeFixtureFile(backupFile, 'نسخة احتياطية لا تُمس');
  const projectsBefore = config.watchedProjects.length;
  const memoryFile = path.join(resolveSystemDataDir(), 'ai-memory-store.json');
  writeFixtureFile(memoryFile, '[]');

  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie'] ?? '').split(';')[0];
  try {
    // 1. صلاحيات التصفير
    const login = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    const cookie = cookieOf(login);
    assert.equal((await postJson(port, '/api/maintenance/reset', { confirm: 'تصفير' }, cookie)).status, 401, 'الخزنة المفتوحة وحدها لا تكفي للتصفير');
    assert.equal((await postJson(port, '/api/settings/auth', { password: TEST_MASTER_PASSWORD }, cookie)).status, 200);
    const info = JSON.parse((await rawRequest(port, { path: '/api/maintenance', headers: { Cookie: cookie } })).body);
    assert.equal(info.developerMode, true, 'وضع التطوير مفعّل افتراضياً');
    assert.equal((await postJson(port, '/api/maintenance/reset', { confirm: 'نعم' }, cookie)).status, 400, 'عبارة تأكيد خاطئة مرفوضة');
    assert.ok(vaultExists(), 'لا شيء يتغير قبل التأكيد الصحيح');
    passedChecks.push('اختبار حماية التصفير: يتطلب كلمة المرور في قسم الإعدادات وعبارة التأكيد الصحيحة (مع تساهل في الهمزات والمسافات) بنجاح.');

    // 2. التصفير إلى السلة
    const reset = await postJson(port, '/api/maintenance/reset', { confirm: 'تصفير' }, cookie);
    assert.equal(reset.status, 200, reset.body);
    assert.equal(vaultExists(), false, 'نُقلت الخزنة إلى السلة');
    assert.equal(fs.existsSync(memoryFile), false, 'نُقلت الذاكرة إلى السلة');
    assert.equal(fs.existsSync(path.join(config.paths.obsidianVaultDir, '02-Projects')), false, 'نُقلت وثائق المشاريع المولّدة');
    assert.equal(fs.existsSync(resolveDefaultConfigPath()), false, 'نُقل ملف الهوية');
    assert.deepEqual(Object.keys(readRawSettings()).filter((k) => k !== 'serverPort'), ['paths'], 'لا يبقى من الإعدادات إلا مسارات الجهاز ومنفذه');
    assert.equal(loadSystemConfig().paths.rootDir, config.paths.rootDir, 'البرنامج يبقى يعمل في نفس المجلد بعد التصفير');
    assert.equal(loadSystemConfig().watchedProjects.length, 0);
    assert.ok(fs.existsSync(profileFile), 'ملف القائد اليدوي لا يُمس');
    assert.ok(fs.existsSync(backupFile), 'النسخ الاحتياطية المشفرة لا تُمس');
    assert.equal((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: cookie } })).status, 401, 'الجلسة السابقة أُغلقت');
    const batches = listTrashBatches();
    assert.equal(batches.length, 1);
    assert.ok(batches[0].items.length >= 5);
    passedChecks.push('اختبار التصفير: نقل الخزنة والإعدادات والمشاريع والذاكرة وما ولّده البرنامج إلى السلة، مع إبقاء مسارات الجهاز وملف القائد والنسخ الاحتياطية وإغلاق الجلسة بنجاح.');

    // 3. الاسترجاع (بعد التصفير لا توجد خزنة، فالإعدادات مفتوحة كأول تشغيل)
    writeFixtureFile(path.join(resolveSystemDataDir(), 'ai-memory-store.json'), '["حالة جديدة بعد التصفير"]');
    const restored = await postJson(port, '/api/maintenance/restore-last', {});
    assert.equal(restored.status, 200, restored.body);
    assert.ok(vaultExists(), 'عادت الخزنة');
    assert.equal(loadSystemConfig().watchedProjects.length, projectsBefore, 'عادت المشاريع');
    assert.equal(fs.readFileSync(memoryFile, 'utf-8'), '[]', 'عادت الذاكرة الأصلية');
    const afterRestore = listTrashBatches();
    assert.equal(afterRestore.length, 1);
    assert.equal(afterRestore[0].kind, 'before-restore', 'الحالة التي كانت قبل الاسترجاع محفوظة في السلة');
    passedChecks.push('اختبار استرجاع آخر تصفير: تعود الخزنة والإعدادات والمشاريع، وتُحفظ الحالة السابقة في السلة بدلاً من حذفها بنجاح.');

    // 4. إفراغ السلة والاعتماد النهائي
    const auth = await postJson(port, '/api/settings/auth', { password: TEST_MASTER_PASSWORD });
    const authCookie = cookieOf(auth);
    assert.equal((await postJson(port, '/api/maintenance/empty-trash', { confirm: 'تصفير' }, authCookie)).status, 400);
    assert.equal((await postJson(port, '/api/maintenance/empty-trash', { confirm: 'إفراغ السلة' }, authCookie)).status, 200);
    assert.equal(listTrashBatches().length, 0, 'أُفرغت السلة');
    assert.equal((await postJson(port, '/api/maintenance/finalize', { confirm: 'نعم' }, authCookie)).status, 400);
    assert.equal((await postJson(port, '/api/maintenance/finalize', { confirm: 'اعتماد نهائي' }, authCookie)).status, 200);
    assert.equal(loadSystemConfig().developerMode, false);
    assert.equal((await postJson(port, '/api/maintenance/reset', { confirm: 'تصفير' }, authCookie)).status, 403, 'بعد الاعتماد يرفض الخادم التصفير');
    assert.equal((await postJson(port, '/api/maintenance/restore-last', {}, authCookie)).status, 403);
    assert.ok(vaultExists());
    passedChecks.push('اختبار إفراغ السلة بعبارة تأكيد، والاعتماد النهائي الذي يُطفئ وضع التطوير ويجعل الخادم يرفض التصفير والاسترجاع بنجاح.');
  } finally {
    const raw = readRawSettings();
    delete raw.developerMode;
    fs.writeFileSync(resolveSettingsPath(), JSON.stringify(raw, null, 2));
    updateSystemSettings({});
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return passedChecks;
}
