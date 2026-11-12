/**
 * ============================================================================
 * الملف: tests/13-conversations-and-voice.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات حفظ المحادثات المشفّرة (الإنشاء، الإضافة، القائمة، الفتح، الحذف، صلاحيات العائلة،
 *               عدم ظهور النص على القرص، والحفظ التلقائي من مسار البثّ) واختبارات النطق العربي المحلي
 *               عبر محاكي Piper وهمي (الحالة، توليد WAV، النص عبر stdin، الحدود، والتعطيل).
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import {
  appendConversationTurn,
  deleteAllConversations,
  deleteConversation,
  getConversation,
  listConversations,
  resolveConversationsDir,
} from '../src/features/conversations/conversation-store.ts';
import { DASHBOARD_CSP } from '../src/features/dashboard-app/http-utils.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { listResetTargets } from '../src/features/maintenance/reset-service.ts';
import { unlockVault } from '../src/features/vault/vault-manager.ts';
import { detectTtsEngine, PIPER_VOICE_FILE, resetTtsCache } from '../src/features/voice/tts-service.ts';
import { xttsWorker } from '../src/features/voice/xtts-engine.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

/** محاكي Piper: يقرأ النص من stdin ويكتب ملف WAV صغيراً، ويسجّل ما استلمه */
const FAKE_PIPER = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const out = args[args.indexOf('--output_file') + 1];
let text = '';
process.stdin.on('data', (d) => (text += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_PIPER_LOG, JSON.stringify({ text, args }) + '\\n');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + 8, 4); header.write('WAVE', 8);
  fs.writeFileSync(out, Buffer.concat([header, Buffer.alloc(8)]));
});
`;

/** محاكي عامل XTTS: يعلن الجاهزية بعد لحظة، ويكتب WAV لكل طلب ويسجّل النص والصوت */
const FAKE_XTTS_WORKER = `
import fs from 'node:fs';
import readline from 'node:readline';
setTimeout(() => process.stdout.write(JSON.stringify({ ready: true, device: 'cpu', speakers: ['Suad Qasim', 'Damien Black'], loadSeconds: 0.3 }) + '\\n'), 300);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_XTTS_LOG, JSON.stringify({ text: req.text, speaker: req.speaker }) + '\\n');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.write('WAVE', 8);
  fs.writeFileSync(req.out, header);
  process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + '\\n');
});
`;

/**
 * Hint بالعربي: دالة تشغيل اختبارات المحادثات المحفوظة والنطق وإرجاع نتائج الفحص.
 */
export async function runConversationsAndVoiceTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const { emergencyKey } = ensureTestVault();
  const commander = unlockVault(TEST_MASTER_PASSWORD);
  const family = unlockVault(emergencyKey);

  // 1. الحفظ المشفّر والإضافة والقائمة
  const id = appendConversationTurn(commander, { mode: 'commander', question: 'ما حالة مشروع الاختبار السري؟', answer: 'المشروع يعمل.', providerUsed: 'local', model: 'local' });
  const sameId = appendConversationTurn(commander, { conversationId: id, mode: 'commander', question: 'والخطوة التالية؟', answer: 'إضافة الاختبارات.' });
  assert.equal(sameId, id, 'السؤال الثاني يُضاف إلى المحادثة نفسها');
  const conv = getConversation(commander, id)!;
  assert.equal(conv.messages.length, 4);
  assert.equal(conv.title, 'ما حالة مشروع الاختبار السري؟');
  assert.equal(conv.messages[1].providerUsed, 'local');
  const onDisk = fs.readFileSync(path.join(resolveConversationsDir(), `${id}.enc.json`), 'utf8');
  assert.ok(!onDisk.includes('السري') && !onDisk.includes('الاختبارات'), 'العنوان والرسائل لا تظهر نصاً واضحاً على القرص');
  const list = listConversations(commander);
  assert.equal(list[0].id, id);
  assert.equal(list[0].messageCount, 4);
  assert.ok(listResetTargets().some((t) => t.endsWith('conversations')), 'مجلد المحادثات ضمن أداة التصفير');
  passedChecks.push('اختبار حفظ المحادثات مشفّرة بمفتاح الخزنة (الإنشاء، الإضافة لنفس المحادثة، العنوان، القائمة، وعدم ظهور النص على القرص) بنجاح.');

  // 2. صلاحيات العائلة والحذف
  const familyId = appendConversationTurn(family, { mode: 'family', question: 'أين الوثائق؟', answer: 'في الخزنة.' });
  assert.throws(() => appendConversationTurn(family, { mode: 'commander', question: 'x', answer: 'y' }), /صلاحية/);
  assert.deepEqual(listConversations(family).map((c) => c.id), [familyId], 'جلسة الطوارئ ترى محادثات العائلة فقط');
  assert.equal(getConversation(family, id), null);
  assert.equal(deleteConversation(family, id), false, 'لا تحذف جلسة الطوارئ محادثات القائد');
  assert.equal(listConversations(commander).length, 2, 'القائد يرى محادثاته ومحادثات العائلة');
  assert.throws(() => getConversation(commander, '../../etc'), /غير صالح/);
  assert.equal(deleteConversation(commander, familyId), true);
  appendConversationTurn(commander, { mode: 'commander', question: 'ثانية', answer: 'نعم' });
  assert.equal(deleteAllConversations(commander, 'commander'), 2);
  assert.equal(listConversations(commander).length, 0);
  passedChecks.push('اختبار صلاحيات المحادثات (العائلة ترى محادثاتها فقط)، ورفض المعرّف الخطِر، وحذف محادثة واحدة وحذف الكل بنجاح.');

  // 3. عبر الخادم: الحفظ التلقائي من مسار البثّ، والقائمة والحذف
  const fakeVendor = path.join(loadSystemConfig().paths.rootDir, 'fake-vendor');
  const piperLog = path.join(fakeVendor, 'piper-calls.ndjson');
  const savedEnv = { vendor: process.env.SECOND_BRAIN_VENDOR_DIR, tts: process.env.SECOND_BRAIN_TTS, log: process.env.FAKE_PIPER_LOG };
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const unlock = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    const cookie = String(unlock.headers['set-cookie'] ?? '').split(';')[0];
    const first = await postJson(port, '/api/assistant/stream', { question: 'سؤال عبر الواجهة', mode: 'commander' }, cookie);
    const done = JSON.parse(/event: done\ndata: (.*)/.exec(first.body)![1]);
    assert.equal(done.saved, true);
    const second = await postJson(port, '/api/assistant/stream', { question: 'متابعة', mode: 'commander', conversationId: done.conversationId }, cookie);
    assert.equal(JSON.parse(/event: done\ndata: (.*)/.exec(second.body)![1]).conversationId, done.conversationId);
    const listed = JSON.parse((await rawRequest(port, { path: '/api/conversations?mode=commander', headers: { Cookie: cookie } })).body);
    assert.equal(listed.conversations.length, 1);
    assert.equal(listed.conversations[0].messageCount, 4);
    const opened = JSON.parse((await rawRequest(port, { path: `/api/conversations/${done.conversationId}`, headers: { Cookie: cookie } })).body);
    assert.equal(opened.messages[2].content, 'متابعة');
    const locked = await postJson(port, '/api/assistant/stream', { question: 'بلا خزنة', mode: 'commander' });
    assert.equal(JSON.parse(/event: done\ndata: (.*)/.exec(locked.body)![1]).saved, false, 'بلا خزنة مفتوحة لا يُحفظ شيء');
    assert.equal((await rawRequest(port, { path: '/api/conversations' })).status, 401);
    assert.equal((await postJson(port, `/api/conversations/${done.conversationId}/delete`, {}, cookie)).status, 200);
    assert.equal((await rawRequest(port, { path: `/api/conversations/${done.conversationId}`, headers: { Cookie: cookie } })).status, 404);
    assert.equal((await postJson(port, '/api/conversations/delete-all', { mode: 'evil' }, cookie)).status, 400);
    passedChecks.push('اختبار المحادثات عبر الخادم (حفظ تلقائي من البثّ، المتابعة في نفس المحادثة، الفتح، عدم الحفظ والخزنة مقفلة، الحذف) بنجاح.');

    // 4. النطق العربي المحلي عبر محاكي Piper
    process.env.SECOND_BRAIN_VENDOR_DIR = fakeVendor;
    process.env.FAKE_PIPER_LOG = piperLog;
    resetTtsCache();
    assert.equal((await detectTtsEngine()).available, false, 'بلا ملفات الصوت لا يوجد محرك');
    writeFixtureFile(path.join(fakeVendor, 'piper', 'piper.mjs'), FAKE_PIPER);
    writeFixtureFile(path.join(fakeVendor, 'voices', PIPER_VOICE_FILE), 'fake-model');
    writeFixtureFile(path.join(fakeVendor, 'voices', `${PIPER_VOICE_FILE}.json`), '{}');
    resetTtsCache();
    const status = JSON.parse((await rawRequest(port, { path: '/api/tts/status' })).body);
    assert.equal(status.available, true);
    assert.equal(status.engine, 'piper');
    const tts = await postJson(port, '/api/tts', { text: 'مرحباً   بالعالم' });
    assert.equal(tts.status, 200);
    assert.equal(tts.headers['content-type'], 'audio/wav');
    assert.ok(tts.body.startsWith('RIFF'));
    const call = JSON.parse(fs.readFileSync(piperLog, 'utf8').trim().split('\n').pop()!);
    assert.equal(call.text, 'مرحباً بالعالم', 'النص يصل عبر stdin منظّفاً');
    assert.ok(!call.args.includes('مرحباً بالعالم'), 'النص لا يمر عبر سطر الأوامر');
    assert.equal((await postJson(port, '/api/tts', { text: 'ا'.repeat(1501) })).status, 400);
    assert.equal((await postJson(port, '/api/tts', { text: '   ' })).status, 400);
    assert.equal((await postJson(port, '/api/tts/install', {})).status, 401, 'التنزيل يتطلب خزنة مفتوحة للقائد');
    passedChecks.push('اختبار النطق العربي المحلي بمحرك Piper (اكتشاف المحرك، توليد WAV، النص عبر stdin لا سطر الأوامر، حدود الطول، وصلاحية التنزيل) بنجاح.');

    // 5. XTTS-v2 عبر عامل وهمي: Piper أثناء التحميل، ثم XTTS بالصوت المختار، والصوت غير المعتمد يُستبدل بالافتراضي
    const xttsLog = path.join(fakeVendor, 'xtts-calls.ndjson');
    const fakeWorker = path.join(fakeVendor, 'xtts-worker.mjs');
    writeFixtureFile(fakeWorker, FAKE_XTTS_WORKER);
    process.env.SECOND_BRAIN_XTTS_WORKER = fakeWorker;
    process.env.FAKE_XTTS_LOG = xttsLog;
    resetTtsCache();
    const xStatus = JSON.parse((await rawRequest(port, { path: '/api/tts/status' })).body);
    assert.equal(xStatus.engine, 'xtts');
    assert.deepEqual(xStatus.speakers, ['Suad Qasim', 'Damien Black']);
    assert.equal(xStatus.fallbackEngine, 'piper');
    assert.equal(xStatus.maxChars, 160);
    const duringLoad = await postJson(port, '/api/tts', { text: 'جملة أثناء التحميل', speaker: 'Damien Black' });
    assert.equal(duringLoad.headers['x-tts-engine'], 'piper', 'أثناء تحميل XTTS يُستخدم Piper فلا يتأخر الرد');
    while (xttsWorker.state === 'loading') await new Promise((r) => setTimeout(r, 50));
    assert.equal(xttsWorker.state, 'ready');
    const viaXtts = await postJson(port, '/api/tts', { text: 'مرحباً من XTTS', speaker: 'Damien Black' });
    assert.equal(viaXtts.headers['x-tts-engine'], 'xtts');
    assert.ok(viaXtts.body.startsWith('RIFF'));
    await postJson(port, '/api/tts', { text: 'صوت غير معتمد', speaker: '../evil' });
    const xCalls = fs.readFileSync(xttsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(xCalls[0].text, 'مرحباً من XTTS');
    assert.equal(xCalls[0].speaker, 'Damien Black');
    assert.equal(xCalls[1].speaker, 'Suad Qasim', 'الصوت غير المعتمد يُستبدل بالافتراضي');
    xttsWorker.stop();
    delete process.env.SECOND_BRAIN_XTTS_WORKER;
    passedChecks.push('اختبار XTTS-v2 عبر عامل وهمي (Piper أثناء التحميل، ثم XTTS بالصوت المختار، ورفض الصوت غير المعتمد) بنجاح.');

    process.env.SECOND_BRAIN_TTS = 'none';
    resetTtsCache();
    assert.equal((await postJson(port, '/api/tts', { text: 'نص' })).status, 503);
    assert.match(DASHBOARD_CSP, /media-src 'self' blob:/, 'تشغيل الصوت المولّد محلياً مسموح من blob فقط');
    const page = await rawRequest(port, { path: '/' });
    assert.match(String(page.headers['content-security-policy']), /media-src 'self' blob:/, 'الصفحة الرئيسية نفسها تسمح بتشغيل الصوت المولّد');
    passedChecks.push('اختبار تعطيل النطق وسياسة الأمان التي تسمح بتشغيل الصوت المولّد محلياً بنجاح.');
  } finally {
    for (const [key, value] of [
      ['SECOND_BRAIN_VENDOR_DIR', savedEnv.vendor],
      ['SECOND_BRAIN_TTS', savedEnv.tts],
      ['FAKE_PIPER_LOG', savedEnv.log],
      ['SECOND_BRAIN_XTTS_WORKER', undefined],
      ['FAKE_XTTS_LOG', undefined],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    xttsWorker.stop();
    resetTtsCache();
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return passedChecks;
}
