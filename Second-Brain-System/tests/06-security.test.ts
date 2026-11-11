/**
 * ============================================================================
 * الملف: tests/06-security.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات الأمان وسلامة البيانات (المرحلة 1): عدم مسح الخزنة، ثبات مفتاح الطوارئ،
 *               تغيير كلمة المرور وتدوير المفتاح، الكتابة الذرّية، الاستعادة الآمنة، منع XSS،
 *               وحماية الخادم (Host، CSRF، الجلسات، الصلاحيات، تحديد المحاولات، حجم الطلب).
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { writeFileAtomic } from '../src/shared/file-helpers.ts';
import { escapeHtml } from '../src/shared/html-helpers.ts';
import { createEncryptedSystemBackup, restoreEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../src/features/family-emergency/emergency-kit-service.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { renderSecondBrainDesktopHTML } from '../src/features/dashboard-app/ui-renderer.ts';
import {
  changeMasterPassword,
  createVault,
  rotateEmergencyKey,
  unlockVault,
  upsertVaultSecret,
} from '../src/features/vault/vault-manager.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD } from './test-environment.ts';

/**
 * Hint بالعربي: دالة إرسال طلب HTTP خام (تسمح بتحديد رأس Host وأي رؤوس أخرى) وإرجاع الحالة والرؤوس والجسم.
 */
export function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: { Host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Hint بالعربي: دالة إرسال طلب POST بصيغة JSON مع كوكي الجلسة (إن وُجد) وأصل الطلب الصحيح.
 */
export function postJson(port: number, pathName: string, payload: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return rawRequest(port, {
    method: 'POST',
    path: pathName,
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      Origin: `http://127.0.0.1:${port}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
  });
}

/**
 * Hint بالعربي: دالة حساب بصمة SHA-256 لملف (للتأكد من أن عملية ما لم تغيّره).
 */
export function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات الأمان وسلامة البيانات وإرجاع قائمة بنتائج الفحص.
 */
export async function runSecurityTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const { vault, emergencyKey } = ensureTestVault();

  // 1. لا يمكن إنشاء خزنة فوق خزنة موجودة، وكلمة المرور القصيرة مرفوضة
  assert.throws(() => createVault('Another-Strong-Pass-1'), /موجودة بالفعل/);
  assert.throws(() => createVault('short', path.join(config.paths.rootDir, 'tmp-vaults', 'short.json')), /10/);
  passedChecks.push('اختبار رفض إنشاء خزنة فوق خزنة موجودة ورفض كلمة المرور القصيرة بنجاح.');

  // 2. الحفظ المتكرر لا يغيّر مفتاح الطوارئ المطبوع
  for (let i = 1; i <= 3; i++) {
    upsertVaultSecret(vault, {
      id: `SEC-STABLE-${i}`,
      category: 'password',
      title: `حساب تجريبي ${i}`,
      secretValue: `value-${i}`,
      notesForCommanderAr: '',
      notesForWifeAr: '',
    });
  }
  const reopened = unlockVault(emergencyKey);
  assert.equal(reopened.unlockedBy, 'wife_emergency');
  assert.ok(reopened.secrets.some((s) => s.id === 'SEC-STABLE-3'), 'مفتاح الطوارئ الأصلي يفتح الخزنة بعد عدة عمليات حفظ');
  passedChecks.push('اختبار ثبات مفتاح الطوارئ بعد عمليات حفظ متعددة بنجاح.');

  // 3. توليد كتيب الطوارئ لا يلمس ملف الخزنة، والنصوص المحقونة تُعرض كنص
  const vaultHashBefore = fileSha256(vault.vaultFilePath);
  const kit = generatePrintableEmergencyKit(emergencyKey, { personalMessageAr: '<img src=x onerror=alert(1)>' });
  assert.equal(fileSha256(vault.vaultFilePath), vaultHashBefore, 'توليد الكتيب يجب ألا يغيّر الخزنة');
  assert.ok(!kit.includes('<img src=x'), 'يجب تحويل الوسوم المحقونة إلى نص');
  passedChecks.push('اختبار أن توليد كتيب الطوارئ لا يمسح الخزنة ولا يسمح بحقن الأكواد بنجاح.');

  // 4. تغيير كلمة المرور وتدوير مفتاح الطوارئ (على خزنة منفصلة)
  const sideVaultPath = path.join(config.paths.rootDir, 'tmp-vaults', 'side-vault.json');
  const side = createVault('Side-Vault-Pass-001', sideVaultPath);
  upsertVaultSecret(side.vault, { id: 'S1', category: 'password', title: 't', secretValue: 'v', notesForCommanderAr: '', notesForWifeAr: '' });
  changeMasterPassword(side.vault, 'Side-Vault-Pass-001', 'Side-Vault-Pass-002');
  assert.throws(() => unlockVault('Side-Vault-Pass-001', sideVaultPath));
  assert.equal(unlockVault('Side-Vault-Pass-002', sideVaultPath).secrets.length, 1);
  assert.equal(unlockVault(side.emergencyRecoveryKey, sideVaultPath).unlockedBy, 'wife_emergency', 'تغيير كلمة المرور لا يُبطل مفتاح الطوارئ');
  assert.throws(() => changeMasterPassword(side.vault, 'wrong-current-pass', 'Side-Vault-Pass-003'));
  const newKey = rotateEmergencyKey(side.vault, 'Side-Vault-Pass-002');
  assert.throws(() => unlockVault(side.emergencyRecoveryKey, sideVaultPath), 'المفتاح القديم يجب أن يُبطل');
  assert.equal(unlockVault(newKey, sideVaultPath).unlockedBy, 'wife_emergency');
  assert.ok(fs.existsSync(`${sideVaultPath}.bak-1`), 'يجب الاحتفاظ بنسخة سابقة من ملف الخزنة');
  passedChecks.push('اختبار تغيير كلمة المرور (دون إبطال مفتاح الطوارئ) وتدوير مفتاح الطوارئ مع النسخ السابقة بنجاح.');

  // 5. الكتابة الذرّية مع النسخ السابقة
  const atomicPath = path.join(config.paths.rootDir, 'tmp-atomic', 'file.json');
  writeFileAtomic(atomicPath, 'v1', 3);
  writeFileAtomic(atomicPath, 'v2', 3);
  writeFileAtomic(atomicPath, 'v3', 3);
  assert.equal(fs.readFileSync(atomicPath, 'utf-8'), 'v3');
  assert.equal(fs.readFileSync(`${atomicPath}.bak-1`, 'utf-8'), 'v2');
  assert.equal(fs.readFileSync(`${atomicPath}.bak-2`, 'utf-8'), 'v1');
  assert.ok(!fs.readdirSync(path.dirname(atomicPath)).some((n) => n.includes('.tmp-')), 'لا تبقى ملفات مؤقتة');
  passedChecks.push('اختبار الكتابة الذرّية والاحتفاظ بالنسخ السابقة بنجاح.');

  // 6. الاستعادة: بمفتاح الطوارئ إلى مجلد جديد فقط، ورفض المفتاح الخاطئ والمجلد غير الفارغ
  const backup = createEncryptedSystemBackup(vault);
  const restoreDir = path.join(config.paths.rootDir, 'restored-copy');
  const preview = restoreEncryptedBackup(backup.backupFilePath, emergencyKey, restoreDir, { dryRun: true });
  assert.equal(preview.written, false);
  assert.ok(!fs.existsSync(restoreDir), 'المعاينة لا تكتب شيئاً');
  const restored = restoreEncryptedBackup(backup.backupFilePath, emergencyKey, restoreDir);
  assert.equal(restored.files.length, backup.filesIncluded);
  const restoredVault = restored.files.find((f) => f.endsWith('vault.aes256.json'));
  assert.ok(restoredVault, 'يجب أن تتضمن الاستعادة ملف الخزنة');
  assert.equal(unlockVault(TEST_MASTER_PASSWORD, path.join(restoreDir, restoredVault)).secrets.length, vault.secrets.length);
  assert.throws(() => restoreEncryptedBackup(backup.backupFilePath, emergencyKey, restoreDir), /فارغ/);
  assert.throws(() => restoreEncryptedBackup(backup.backupFilePath, 'wrong-password-123', path.join(config.paths.rootDir, 'r2')));
  passedChecks.push('اختبار الاستعادة (معاينة، استعادة لمجلد جديد، فتح الخزنة المستعادة، رفض المجلد غير الفارغ والمفتاح الخاطئ) بنجاح.');

  // 7. منع XSS في الواجهة
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  const evilConfig = {
    ...config,
    watchedProjects: [{ ...config.watchedProjects[0], name: '<script>alert(1)</script>', wifeSummaryAr: '<img src=x onerror=alert(2)>' }],
  };
  const html = renderSecondBrainDesktopHTML(
    evilConfig,
    [],
    [{ id: 'M', sourceAI: 'manual', projectId: 'p', title: '<svg onload=alert(3)>', summaryAr: 's', keyDecisionsAr: [], createdAt: '' }]
  );
  assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x') && !html.includes('<svg onload'));
  passedChecks.push('اختبار منع حقن الأكواد (XSS) في الواجهة وفي أسماء المشاريع وسجلات الذاكرة بنجاح.');

  // 8. حماية الخادم عبر HTTP حقيقي
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // Host غريب (DNS Rebinding) ← 403
    assert.equal((await rawRequest(port, { path: '/api/health', headers: { Host: 'evil.example' } })).status, 403);
    // الأسرار بدون جلسة ← 401
    assert.equal((await rawRequest(port, { path: '/api/vault/secrets' })).status, 401);
    // POST من موقع آخر (CSRF) ← 403
    assert.equal((await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD }, undefined, { Origin: 'http://evil.example' })).status, 403);
    // نوع محتوى غير JSON ← 415
    assert.equal(
      (await rawRequest(port, { method: 'POST', path: '/api/vault/unlock', body: 'key=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '5', Origin: `http://127.0.0.1:${port}` } })).status,
      415
    );
    // جسم أكبر من 1MB ← 413
    assert.equal((await postJson(port, '/api/assistant', { question: 'x'.repeat(1024 * 1024 + 10) })).status, 413);
    passedChecks.push('اختبار رفض الخادم لـ Host الغريب، والطلبات بلا جلسة، وطلبات المواقع الأخرى (CSRF)، والمحتوى غير JSON، والطلبات الضخمة بنجاح.');

    // تحديد المحاولات: بعد 3 محاولات خاطئة يُرفض الطلب التالي مؤقتاً (429)
    for (let i = 0; i < 3; i++) {
      assert.equal((await postJson(port, '/api/vault/unlock', { key: 'wrong-password-123' })).status, 401);
    }
    assert.equal((await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD })).status, 429);
    resetSessionStateForTests();
    passedChecks.push('اختبار التأخير المتصاعد بعد محاولات الفتح الخاطئة (429) بنجاح.');

    // جلسة القائد: فتح ← كوكي HttpOnly ← عرض وإضافة ← قفل ← رفض الكوكي القديم
    const unlockRes = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    assert.equal(unlockRes.status, 200);
    const setCookie = String(unlockRes.headers['set-cookie'] ?? '');
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
    const cookie = setCookie.split(';')[0];
    const listRes = await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    assert.ok((JSON.parse(listRes.body) as { secrets: unknown[] }).secrets.length > 0);
    assert.equal(
      (await postJson(port, '/api/vault/secrets', { category: 'password', title: 'من الواجهة', secretValue: 'ui-value' }, cookie)).status,
      200
    );

    // كتيب الطوارئ: مفتاح صحيح ← رابط طباعة لمرة واحدة؛ مفتاح لا يفتح الخزنة ← 400
    const kitRes = await postJson(port, '/api/emergency/kit', { emergencyKey }, cookie);
    assert.equal(kitRes.status, 200);
    const printUrl = (JSON.parse(kitRes.body) as { printUrl: string }).printUrl;
    const printPage = await rawRequest(port, { path: printUrl });
    assert.equal(printPage.status, 200);
    assert.ok(printPage.body.includes(emergencyKey) && String(printPage.headers['content-security-policy']).includes('nonce-'));
    assert.equal((await rawRequest(port, { path: printUrl })).status, 404, 'صفحة الطباعة تُعرض مرة واحدة فقط');
    assert.equal((await postJson(port, '/api/emergency/kit', { emergencyKey: newKey }, cookie)).status, 400);

    await postJson(port, '/api/vault/lock', {}, cookie);
    assert.equal((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: cookie } })).status, 401);
    passedChecks.push('اختبار دورة الجلسة (فتح، كوكي HttpOnly، عرض، إضافة، طباعة لمرة واحدة، قفل وإبطال الكوكي) بنجاح.');

    // جلسة الزوجة: عرض فقط، والإضافة والطباعة للقائد فقط (403)
    const wifeRes = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
    assert.equal((JSON.parse(wifeRes.body) as { unlockedBy: string }).unlockedBy, 'wife_emergency');
    const wifeCookie = String(wifeRes.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await rawRequest(port, { path: '/api/vault/secrets', headers: { Cookie: wifeCookie } })).status, 200);
    assert.equal((await postJson(port, '/api/vault/secrets', { category: 'password', title: 'x', secretValue: 'y' }, wifeCookie)).status, 403);
    passedChecks.push('اختبار صلاحيات وضع العائلة (عرض الحسابات مسموح، والتعديل للقائد فقط) بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return passedChecks;
}
