/**
 * ============================================================================
 * الملف: tests/25-log-redaction.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات تنقية السجلات وتدويرها (الإصدار 3.7.0، المرحلة 2.5 من docs/12):
 *               - يتعمّد تسجيل أسرار (مفاتيح API، ومفتاح طوارئ، وكلمة مرور في رابط وفي متغير، و JWT، ومفتاح خاص)
 *                 عبر logSystemInfo و logSystemError، ويتأكد أنها لم تُكتب في runtime.log.
 *               - التدوير: 5MB × 3 ملفات، والنسخ ثم التفريغ لملف تبقيه عملية أخرى مفتوحاً.
 *               - مخرجات الطرفية (server.log) في عملية منفصلة: console.log و stderr وعطل غير متوقع، كلها منقّاة.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { LOG_FILES_KEPT, logSystemError, logSystemInfo, MAX_LOG_BYTES, rotateLogIfLarge } from '../src/core/logger.ts';

/** أسرار وهمية بأشكال حقيقية (لا تعمل في أي مكان) */
const FAKE = {
  anthropic: 'sk-ant-api03-FAKEfakeFAKEfakeFAKEfakeFAKE0123456789',
  google: 'AIzaSyFAKE00000000000000000000000000000',
  github: 'ghp_FAKE0000000000000000000000000000000000',
  emergency: 'SB-0000-1111-2222-3333-4444-5555-6666-7777-AAAA',
  urlPassword: 'FakeDbPass123',
  envPassword: 'FakeEnvPass456',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZXNpZ25hdHVyZWZha2U',
};

/**
 * Hint بالعربي: دالة تشغيل اختبارات تنقية السجلات وإرجاع نتائج الفحص.
 */
export async function runLogRedactionTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const logDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'logs');
  const runtimeLog = path.join(logDir, 'runtime.log');

  // ===================== 1. لا أسرار في runtime.log =====================
  const before = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8').length : 0;
  logSystemInfo('LogTest', `مفاتيح: ${FAKE.anthropic} و ${FAKE.google} و ${FAKE.github} ومفتاح الطوارئ ${FAKE.emergency}`);
  logSystemInfo('LogTest', `قاعدة: postgres://admin:${FAKE.urlPassword}@db.example.test/app و DB_PASSWORD=${FAKE.envPassword} و ${FAKE.jwt}`);
  logSystemError('LogTest', 'فشل الاتصال', new Error(`Authorization failed for key ${FAKE.anthropic}`));
  logSystemInfo('LogTest', '-----BEGIN PRIVATE KEY-----\nMIIEvFAKEFAKEFAKE\n-----END PRIVATE KEY-----');
  const written = fs.readFileSync(runtimeLog, 'utf8').slice(before);
  for (const [name, value] of Object.entries(FAKE)) assert.ok(!written.includes(value), `السر (${name}) لم يُكتب في السجل`);
  assert.ok(!written.includes('MIIEvFAKEFAKEFAKE'), 'المفتاح الخاص لم يُكتب');
  assert.ok((written.match(/محذوف لأنه سر/g) ?? []).length >= 8, 'مكانها علامة الحذف');
  assert.ok(written.includes('postgres://admin:') && written.includes('DB_PASSWORD='), 'السياق يبقى للتشخيص (اسم المستخدم واسم المتغير)');
  assert.ok(written.includes('فشل الاتصال'), 'الرسالة نفسها تبقى');
  passedChecks.push('اختبار تنقية runtime.log (مفاتيح Anthropic و Google و GitHub، ومفتاح الطوارئ، وكلمة مرور في رابط وفي متغير، و JWT، ومفتاح خاص، ورسالة خطأ: لا شيء منها يُكتب، والسياق يبقى) بنجاح.');

  // ===================== 2. التدوير =====================
  const rotDir = path.join(config.paths.rootDir, 'log-rotation-sim');
  fs.mkdirSync(rotDir, { recursive: true });
  const f = path.join(rotDir, 'x.log');
  fs.writeFileSync(f, 'A'.repeat(20));
  assert.equal(rotateLogIfLarge(f, { maxBytes: 50 }), false, 'تحت الحد: لا تدوير');
  fs.writeFileSync(f, 'A'.repeat(60));
  assert.equal(rotateLogIfLarge(f, { maxBytes: 50 }), true);
  assert.ok(!fs.existsSync(f) && fs.readFileSync(`${f}.1`, 'utf8').startsWith('A'));
  fs.writeFileSync(f, 'B'.repeat(60));
  rotateLogIfLarge(f, { maxBytes: 50 });
  fs.writeFileSync(f, 'C'.repeat(60));
  rotateLogIfLarge(f, { maxBytes: 50 });
  assert.ok(fs.readFileSync(`${f}.1`, 'utf8').startsWith('C') && fs.readFileSync(`${f}.2`, 'utf8').startsWith('B'), 'الأحدث في .1');
  assert.ok(!fs.existsSync(`${f}.3`), `${LOG_FILES_KEPT} ملفات على الأكثر، والأقدم يُحذف`);
  const held = path.join(rotDir, 'server.log');
  fs.writeFileSync(held, 'D'.repeat(60));
  const fd = fs.openSync(held, 'a');
  assert.equal(rotateLogIfLarge(held, { maxBytes: 50, copyTruncate: true }), true);
  fs.writeSync(fd, 'E');
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(`${held}.1`, 'utf8'), 'D'.repeat(60), 'النسخ ثم التفريغ يحفظ القديم');
  assert.equal(fs.readFileSync(held, 'utf8'), 'E', 'والعملية الكاتبة تكمل في الملف نفسه');
  assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
  // runtime.log فوق 5MB يُدوَّر عند الكتابة التالية
  fs.writeFileSync(runtimeLog, 'Z'.repeat(MAX_LOG_BYTES + 10));
  logSystemInfo('LogTest', 'بعد التدوير');
  assert.ok(fs.statSync(runtimeLog).size < 1000 && fs.existsSync(`${runtimeLog}.1`), 'runtime.log دُوِّر عند تجاوز 5MB');
  fs.rmSync(`${runtimeLog}.1`, { force: true });
  fs.rmSync(rotDir, { recursive: true, force: true });
  passedChecks.push('اختبار التدوير (لا تدوير تحت الحد، و .1 ثم .2 والأقدم يُحذف، والنسخ ثم التفريغ لملف مفتوح، و runtime.log عند 5MB) بنجاح.');

  // ===================== 3. مخرجات الطرفية (server.log) =====================
  const loggerUrl = new URL('../src/core/logger.ts', import.meta.url).href;
  const script = `
    const { installConsoleRedaction } = await import(${JSON.stringify(loggerUrl)});
    installConsoleRedaction();
    console.log('stdout ${FAKE.anthropic}');
    console.error('stderr ${FAKE.emergency}');
    process.stderr.write(Buffer.from('buffer ${FAKE.github}\\n'));
    setTimeout(() => { throw new Error('crash with ${FAKE.google}'); }, 10);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  const out = `${child.stdout}\n${child.stderr}`;
  assert.ok(out.includes('stdout') && out.includes('stderr') && out.includes('buffer') && out.includes('crash with'), `المخرجات وصلت: ${out.slice(0, 300)}`);
  for (const v of [FAKE.anthropic, FAKE.emergency, FAKE.github, FAKE.google]) assert.ok(!out.includes(v), 'لا سر في مخرجات الطرفية ولا في رسالة العطل');
  assert.notEqual(child.status, 0, 'العطل غير المتوقع ما زال يُنهي العملية (لا نخفي الأعطال)');
  passedChecks.push('اختبار مخرجات الطرفية في عملية منفصلة (console.log و console.error و stderr بايتات، ورسالة عطل غير متوقع: كلها منقّاة، والعطل ما زال يُنهي العملية) بنجاح.');

  return passedChecks;
}
