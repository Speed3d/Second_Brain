/**
 * ============================================================================
 * الملف: tests/12-claude-subscription.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المرحلة أ٢ (Claude عبر الاشتراك): مزوّد claude-cli عبر محاكي وهمي لـ Claude Code
 *               (بلا تشغيل البرنامج الحقيقي، بلا إنترنت، وبلا استهلاك لحصة الاشتراك):
 *               البحث عن البرنامج، معاملات العزل، إزالة مفاتيح API من البيئة، المجلد المؤقت، البثّ،
 *               إيقاف التشغيل إن حُمّلت أدوات، حالة تسجيل الدخول، حد الاستخدام، ترتيب التراجع، ومسار الاختبار عبر الخادم.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { testProviderConnection } from '../src/features/assistant/provider-tester.ts';
import {
  buildClaudeCliArgs,
  createClaudeCliProvider,
  formatConversationForCli,
  locateClaudeCli,
  resetClaudeCliStatusCache,
} from '../src/features/assistant/providers/claude-cli-provider.ts';
import { buildProviders, runProvidersWithFallback } from '../src/features/assistant/providers/provider-registry.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson } from './06-security.test.ts';
import { startFakeAiServer } from './07-integration.test.ts';
import { writeFixtureFile } from './test-environment.ts';

/** محاكي Claude Code: يقلّد "auth status" ومخرجات stream-json، ويسجّل ما استلمه للتحقق منه */
const FAKE_CLAUDE_SCRIPT = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const log = process.env.FAKE_CLAUDE_LOG;
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = mode !== 'logged-out';
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }));
  process.exit(loggedIn ? 0 : 1);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const sysFile = args[args.indexOf('--system-prompt-file') + 1];
  const mcpFile = args[args.indexOf('--mcp-config') + 1];
  if (log) fs.appendFileSync(log, JSON.stringify({
    args, cwd: process.cwd(), stdin,
    system: fs.readFileSync(sysFile, 'utf8'), mcp: fs.readFileSync(mcpFile, 'utf8'),
    hasApiKey: 'ANTHROPIC_API_KEY' in process.env, hasBaseUrl: 'ANTHROPIC_BASE_URL' in process.env,
  }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: mode === 'leaky' ? ['Bash'] : [], mcp_servers: [] });
  if (mode === 'leaky') { setTimeout(() => {}, 20000); return; }
  if (mode === 'rate') {
    out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage limit reached' }] } });
    out({ type: 'result', is_error: true, result: 'Claude usage limit reached' });
    process.exit(1);
  }
  for (const piece of ['أهلاً ', 'من ', 'الاشتراك']) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  out({ type: 'result', is_error: false, result: 'أهلاً من الاشتراك' });
});
`;

/**
 * Hint بالعربي: دالة تشغيل اختبارات Claude عبر الاشتراك وإرجاع نتائج الفحص.
 */
export async function runClaudeSubscriptionTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const fakeDir = path.join(config.paths.rootDir, 'fake-claude-cli');
  const fakeScript = path.join(fakeDir, 'claude-fake.mjs');
  const logFile = path.join(fakeDir, 'calls.ndjson');
  writeFixtureFile(fakeScript, FAKE_CLAUDE_SCRIPT);

  const savedEnv = {
    cli: process.env.SECOND_BRAIN_CLAUDE_CLI,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  };
  const setMode = (mode: string): void => {
    process.env.FAKE_CLAUDE_MODE = mode;
    resetClaudeCliStatusCache();
  };
  const readCalls = (): Array<Record<string, any>> =>
    fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

  const fake = await startFakeAiServer();
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // 1. البحث عن البرنامج
    assert.equal(locateClaudeCli('', { SECOND_BRAIN_CLAUDE_CLI: 'none', PATH: '' }), null, 'القيمة none تعطّل المزوّد');
    assert.equal(locateClaudeCli('', { SECOND_BRAIN_CLAUDE_CLI: path.join(fakeDir, 'missing.exe') }), null, 'المسار غير الموجود مرفوض');
    const launch = locateClaudeCli('', { SECOND_BRAIN_CLAUDE_CLI: fakeScript });
    assert.ok(launch && launch.command === process.execPath && launch.prefixArgs[0] === fakeScript && launch.source === 'env');
    if (process.platform === 'win32') {
      const notExe = path.join(fakeDir, 'claude.cmd');
      writeFixtureFile(notExe, '@echo off');
      assert.equal(locateClaudeCli(notExe, {}), null, 'على Windows لا يُقبل إلا ملف exe (التشغيل بلا shell)');
    }
    passedChecks.push('اختبار البحث عن Claude Code (التعطيل في الاختبارات، رفض المسار غير الموجود وغير التنفيذي، تشغيل المحاكي) بنجاح.');

    // 2. معاملات العزل وتنسيق المحادثة
    const args = buildClaudeCliArgs('sonnet', 'S.txt', 'M.json');
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    assert.ok(args.includes('-p') && args.includes('--strict-mcp-config') && args.includes('--no-session-persistence') && args.includes('--disable-slash-commands'));
    assert.equal(after('--tools'), '', 'كل الأدوات مطفأة');
    assert.equal(after('--setting-sources'), '', 'لا إعدادات مستخدم أو مشروع');
    assert.equal(after('--mcp-config'), 'M.json');
    assert.equal(after('--output-format'), 'stream-json');
    assert.ok(!args.includes('--bare'), 'وضع bare لا يقبل الاشتراك');
    assert.equal(formatConversationForCli([{ role: 'user', content: 'سؤال' }]), 'سؤال');
    const multi = formatConversationForCli([
      { role: 'user', content: 'الأول' },
      { role: 'assistant', content: 'رد' },
      { role: 'user', content: 'الثاني' },
    ]);
    assert.match(multi, /\[المستخدم\]\nالأول/);
    assert.match(multi, /الرسالة الحالية:\nالثاني$/);
    passedChecks.push('اختبار معاملات العزل (بلا أدوات، بلا MCP، بلا مهارات، بلا إعدادات، بلا حفظ جلسات) وتحويل المحادثة إلى رسالة واحدة بنجاح.');

    // 3. محادثة ناجحة: البثّ، إزالة مفاتيح API من البيئة، المجلد المؤقت يُحذف
    process.env.SECOND_BRAIN_CLAUDE_CLI = fakeScript;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-must-not-leak';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.FAKE_CLAUDE_LOG = logFile;
    setMode('ok');
    const provider = createClaudeCliProvider({ launch: locateClaudeCli(), model: 'sonnet', timeoutMs: 20000 });
    assert.equal(provider.id, 'claude-cli');
    assert.equal((await provider.checkAvailability()).ok, true);
    const pieces: string[] = [];
    const result = await provider.chat(
      { system: 'تعليمات النظام التجريبية', messages: [{ role: 'user', content: 'ما حالة المشروع؟' }], question: 'ما حالة المشروع؟', mode: 'commander' },
      (p) => pieces.push(p)
    );
    assert.equal(result.text, 'أهلاً من الاشتراك');
    assert.equal(result.model, 'claude-sonnet-5-5');
    assert.deepEqual(pieces, ['أهلاً ', 'من ', 'الاشتراك'], 'الرد يُبثّ قطعة قطعة');
    const call = readCalls().pop()!;
    assert.equal(call.hasApiKey, false, 'مفتاح API يُزال من البيئة فلا تتحول الفوترة إليه');
    assert.equal(call.hasBaseUrl, false);
    assert.equal(call.system, 'تعليمات النظام التجريبية');
    assert.equal(call.stdin, 'ما حالة المشروع؟');
    assert.deepEqual(JSON.parse(call.mcp), { mcpServers: {} });
    assert.match(path.basename(call.cwd), /^second-brain-claude-/);
    assert.equal(fs.existsSync(call.cwd), false, 'المجلد المؤقت (وفيه تعليمات النظام) يُحذف بعد الرد');
    passedChecks.push('اختبار محادثة Claude عبر الاشتراك (بثّ تدريجي، إزالة ANTHROPIC_API_KEY من البيئة، إعداد MCP فارغ، حذف المجلد المؤقت) بنجاح.');

    // 4. الحالات الفاشلة: أدوات محمّلة، غير مسجّل الدخول، حد الاستخدام
    setMode('leaky');
    const started = Date.now();
    await assert.rejects(
      provider.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], question: 'x', mode: 'commander' }),
      /أوقف Second Brain/
    );
    assert.ok(Date.now() - started < 15000, 'يُوقف التشغيل فوراً ولا ينتظر');

    setMode('logged-out');
    const loggedOut = await testProviderConnection('claude-cli');
    assert.equal(loggedOut.ok, false);
    assert.match(loggedOut.reasonAr ?? '', /غير مسجّل الدخول/);
    assert.match(loggedOut.hintAr ?? '', /claude auth login/);

    setMode('rate');
    await assert.rejects(
      provider.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], question: 'x', mode: 'commander' }),
      /حد استخدام اشتراك Claude/
    );
    passedChecks.push('اختبار الحالات الفاشلة (إيقاف فوري إن حُمّلت أدوات، غير مسجّل الدخول مع الحل المقترح، بلوغ حد الاشتراك) بنجاح.');

    // 5. ترتيب التراجع الافتراضي: الاشتراك ← Ollama ← المعرفة المحلية
    const hybrid = {
      ...config,
      aiConfig: { ...config.aiConfig, providerOrder: undefined, defaultMode: 'hybrid' as const, apiKeysEnabled: false, ollamaEndpoint: fake.baseUrl, ollamaModel: 'llama3.2' },
    };
    const ctx = { assistantNameAr: 'المساعد', familyTitle: 'العائلة', projects: [], projectReports: [], memoryCount: 0 };
    const request = { system: 's', messages: [{ role: 'user' as const, content: 'مرحبا' }], question: 'مرحبا', mode: 'commander' as const };
    assert.deepEqual(buildProviders(hybrid, {}, ctx).map((p) => p.id), ['claude-cli', 'ollama', 'local']);
    setMode('ok');
    assert.equal((await runProvidersWithFallback(buildProviders(hybrid, {}, ctx), request)).providerUsed, 'claude-cli');
    setMode('logged-out');
    const viaOllama = await runProvidersWithFallback(buildProviders(hybrid, {}, ctx), request);
    assert.equal(viaOllama.providerUsed, 'ollama', 'إن لم يُسجَّل الدخول يُتخطى الاشتراك إلى Ollama');
    assert.equal(viaOllama.attempts[0].skipped, true);
    passedChecks.push('اختبار ترتيب التراجع الافتراضي بلا فواتير (Claude عبر الاشتراك ← Ollama ← المعرفة المحلية، وتخطّي الاشتراك غير المسجّل) بنجاح.');

    // 6. عبر الخادم
    setMode('ok');
    const viaServer = await postJson(port, '/api/assistant/test', { provider: 'claude-cli' });
    assert.equal(viaServer.status, 200);
    const body = JSON.parse(viaServer.body);
    assert.equal(body.ok, true, body.reasonAr);
    assert.equal(body.replyPreview, 'أهلاً من الاشتراك');
    passedChecks.push('اختبار مسار /api/assistant/test لمزوّد claude-cli عبر الخادم بنجاح.');
  } finally {
    process.env.SECOND_BRAIN_CLAUDE_CLI = savedEnv.cli ?? 'none';
    if (savedEnv.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.apiKey;
    if (savedEnv.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedEnv.baseUrl;
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_LOG;
    resetClaudeCliStatusCache();
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  }
  return passedChecks;
}
