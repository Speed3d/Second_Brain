/**
 * ============================================================================
 * الملف: tests/08-disaster-recovery.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبار التعافي من الكوارث: يحاكي حرفياً دليل "التشغيل على جهاز جديد" الموجود في دليل العائلة:
 *               جهاز أ (خزنة + حساب + مشروع + نسخة احتياطية) ← فلاشة ← جهاز ب (استعادة إلى مجلد جديد بمفتاح
 *               الطوارئ، نسخ ملفات البرنامج كما في الدليل، تشغيل الخادم الحقيقي، فتح الخزنة، والتحقق من كل البيانات).
 *               كل شيء في مجلدات مؤقتة منفصلة، ولا يلمس أي بيانات حقيقية.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSystemRootDir } from '../src/core/config-manager.ts';

/**
 * Hint بالعربي: دالة نسخ ملفات البرنامج (بدون أي بيانات) إلى مجلد وجهة، كما تُنسخ إلى الفلاشة أو الجهاز الجديد.
 */
export function copyProgramFiles(destRoot: string): void {
  const system = getSystemRootDir();
  const destSystem = path.join(destRoot, 'Second-Brain-System');
  fs.mkdirSync(destSystem, { recursive: true });
  fs.cpSync(path.join(system, 'src'), path.join(destSystem, 'src'), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) fs.copyFileSync(path.join(system, f), path.join(destSystem, f));
  fs.copyFileSync(path.join(system, '..', 'Launch-Second-Brain.bat'), path.join(destRoot, 'Launch-Second-Brain.bat'));
}

/**
 * Hint بالعربي: دالة تشغيل كود داخل نسخة برنامج مستقلة (عملية منفصلة بلا متغيرات بيئة الاختبار)، وإرجاع ناتجها.
 */
export function runInCopy(systemDir: string, code: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: systemDir, env, encoding: 'utf-8', windowsHide: true }).trim();
}

/**
 * Hint بالعربي: دالة تشغيل اختبار التعافي من الكوارث وإرجاع نتائج الفحص.
 */
export async function runDisasterRecoveryTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-disaster-'));
  const env = { ...process.env };
  delete env.SECOND_BRAIN_CONFIG_PATH;
  const machineA = path.join(base, 'MachineA', 'Second Brain');
  const flash = path.join(base, 'USB', 'Second Brain');
  const programOnB = path.join(base, 'MachineB', 'Second Brain');
  const restoredB = path.join(base, 'MachineB', 'Second Brain Restored');

  try {
    // 1. جهاز أ: البرنامج + مشروع + خزنة + حساب + نسخة احتياطية
    copyProgramFiles(machineA);
    const projectDir = path.join(base, 'MachineA', 'Projects', 'MyApp');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"scripts":{"start":"node index.js"}}');
    fs.mkdirSync(path.join(machineA, 'Second-Brain-System', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(machineA, 'Second-Brain-System', 'config', 'settings.json'),
      JSON.stringify({
        watcher: { enabled: false, intervalMinutes: 15, harvestTranscripts: false },
        aiConfig: { providerOrder: ['local'] },
        watchedProjects: [{ id: 'my-app', name: 'MyApp', path: projectDir, descriptionAr: 'تطبيق', wifeSummaryAr: 'تطبيق المتجر', monthlyIncome: '500$', billingNotes: 'السيرفر شهرياً' }],
      })
    );
    fs.mkdirSync(path.join(machineA, 'Obsidian-Vault', '00-Command-Center'), { recursive: true });
    fs.writeFileSync(path.join(machineA, 'Obsidian-Vault', '00-Command-Center', 'note.md'), '# ملاحظة مهمة');

    const created = JSON.parse(
      runInCopy(
        path.join(machineA, 'Second-Brain-System'),
        `const v = await import('./src/features/vault/vault-manager.ts');
         const b = await import('./src/features/family-emergency/backup-service.ts');
         const { emergencyRecoveryKey, vault } = v.createVault('Machine-A-Test-Pass-2026');
         v.upsertVaultSecret(vault, { id: 'S1', category: 'email_account', title: 'إيميل المتجر', usernameOrEmail: 'shop@example.test', secretValue: 'shop-test-value', notesForCommanderAr: '', notesForWifeAr: 'الإيميل الرئيسي' });
         const backup = b.createEncryptedSystemBackup(vault);
         console.log(JSON.stringify({ key: emergencyRecoveryKey, backup: backup.backupFilePath }));`,
        env
      )
    ) as { key: string; backup: string };
    assert.ok(fs.existsSync(created.backup));

    // 2. الفلاشة: نسخة البرنامج + ملف النسخة الاحتياطية فقط (بلا أي بيانات أخرى)
    copyProgramFiles(flash);
    const backupOnFlash = path.join(path.dirname(flash), path.basename(created.backup));
    fs.copyFileSync(created.backup, backupOnFlash);

    // 3. جهاز ب: تشغيل نسخة الفلاشة واستعادة النسخة (معاينة ثم استعادة) بمفتاح الطوارئ مكتوباً بأحرف صغيرة ومسافات
    fs.cpSync(flash, programOnB, { recursive: true });
    const restored = JSON.parse(
      runInCopy(
        path.join(programOnB, 'Second-Brain-System'),
        `const b = await import('./src/features/family-emergency/backup-service.ts');
         const key = ${JSON.stringify(created.key.toLowerCase().replace(/-/g, ' '))};
         const preview = b.restoreEncryptedBackup(${JSON.stringify(backupOnFlash)}, key, ${JSON.stringify(restoredB)}, { dryRun: true });
         const done = b.restoreEncryptedBackup(${JSON.stringify(backupOnFlash)}, key, ${JSON.stringify(restoredB)});
         console.log(JSON.stringify({ preview: preview.written, written: done.written }));`,
        env
      )
    ) as { preview: boolean; written: boolean };
    assert.equal(restored.preview, false);
    assert.equal(restored.written, true);

    // 4. الخطوة 5 من الدليل: نسخ ملفات البرنامج إلى المجلد المستعاد
    fs.copyFileSync(path.join(programOnB, 'Launch-Second-Brain.bat'), path.join(restoredB, 'Launch-Second-Brain.bat'));
    fs.cpSync(path.join(programOnB, 'Second-Brain-System', 'src'), path.join(restoredB, 'Second-Brain-System', 'src'), { recursive: true });
    for (const f of ['package.json', 'tsconfig.json']) {
      fs.copyFileSync(path.join(programOnB, 'Second-Brain-System', f), path.join(restoredB, 'Second-Brain-System', f));
    }

    // 5. تشغيل الخادم الحقيقي من المجلد المستعاد وفتح الخزنة بمفتاح الطوارئ
    const server = spawn(
      process.execPath,
      ['--input-type=module', '-e', `const s = await import('./src/features/dashboard-app/desktop-server.ts'); const srv = await s.startSecondBrainDesktopServer(0); console.log('PORT=' + srv.address().port);`],
      { cwd: path.join(restoredB, 'Second-Brain-System'), env, windowsHide: true }
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('لم يعمل الخادم المستعاد خلال المهلة')), 30000);
        let out = '';
        server.stdout.on('data', (d) => {
          out += d;
          const m = out.match(/PORT=(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        server.on('exit', (code) => reject(new Error(`توقف الخادم المستعاد (${code})`)));
      });
      const url = `http://127.0.0.1:${port}`;
      const unlock = await fetch(`${url}/api/vault/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ key: created.key }),
      });
      assert.equal(unlock.status, 200, 'يجب أن تُفتح الخزنة المستعادة بمفتاح الطوارئ');
      assert.equal(((await unlock.json()) as { unlockedBy: string }).unlockedBy, 'wife_emergency');
      const cookie = String(unlock.headers.get('set-cookie')).split(';')[0];
      const secrets = (await (await fetch(`${url}/api/vault/secrets`, { headers: { Cookie: cookie } })).json()) as { secrets: Array<{ title: string; secretValue: string }> };
      assert.ok(secrets.secrets.some((s) => s.title === 'إيميل المتجر' && s.secretValue === 'shop-test-value'), 'الحساب وكلمة مروره مستعادان');
      const state = (await (await fetch(`${url}/api/state`)).json()) as { projects: Array<{ name: string; monthlyIncome: string }> };
      assert.ok(state.projects.some((p) => p.name === 'MyApp' && p.monthlyIncome === '500$'), 'المشروع ودخله مستعادان');
      assert.ok(fs.existsSync(path.join(restoredB, 'Obsidian-Vault', '00-Command-Center', 'note.md')), 'ملفات Obsidian مستعادة');
    } finally {
      server.kill();
    }
    passedChecks.push('اختبار التعافي من الكوارث: جهاز أ ← فلاشة ← جهاز جديد (استعادة بمفتاح الطوارئ، تشغيل الخادم من المجلد المستعاد، وظهور الحسابات والمشاريع وملفات Obsidian) بنجاح.');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return passedChecks;
}
