/**
 * ============================================================================
 * الملف: tests/07-integration.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المرحلة 2 (الربط الفعلي والمرونة):
 *               ترحيل الإعدادات والتحقق منها، مزوّدو الذكاء (Claude / Gemini / Ollama) عبر خادم وهمي محلي
 *               (بلا أي اتصال حقيقي أو تكلفة)، ترتيب التراجع، بروتوكول MCP عبر stdio فعلي، فحص Git،
 *               سجل التغييرات عند التغيّر فقط، حماية الملاحظات اليدوية، تنقية الأسرار، والبثّ عبر الخادم.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { getSystemRootDir, loadSystemConfig, migrateLegacyConfig, normalizeSystemConfig } from '../src/core/config-manager.ts';
import { redactSecrets } from '../src/shared/secret-redaction.ts';
import { toSafeFileName } from '../src/shared/file-helpers.ts';
import { buildClaudeRequestBody, createClaudeProvider } from '../src/features/assistant/providers/claude-provider.ts';
import { createGeminiProvider } from '../src/features/assistant/providers/gemini-provider.ts';
import { createLocalKnowledgeProvider } from '../src/features/assistant/providers/local-knowledge-provider.ts';
import { createOllamaProvider } from '../src/features/assistant/providers/ollama-provider.ts';
import { resolveProviderOrder, runProvidersWithFallback } from '../src/features/assistant/providers/provider-registry.ts';
import type { ProviderChatRequest } from '../src/features/assistant/providers/provider-types.ts';
import { matchSessionToProject } from '../src/features/ai-memory/transcript-harvester.ts';
import { AUTO_END, AUTO_START, syncProjectWithChanges } from '../src/features/project-indexer/obsidian-sync.ts';
import { scanAndAnalyzeProject } from '../src/features/project-indexer/project-scanner.ts';
import { rescanAllProjects, startProjectWatcher } from '../src/features/project-indexer/project-watcher.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { handleMcpJsonRpcRequest, processMcpLine, SUPPORTED_MCP_VERSIONS } from '../src/tools/mcp-memory-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, FAKE_SECRETS, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

const SAMPLE_REQUEST: ProviderChatRequest = {
  system: 'تعليمات اختبار',
  messages: [{ role: 'user', content: 'مرحبا' }],
  question: 'مرحبا',
  mode: 'commander',
};

/**
 * Hint بالعربي: دالة كتابة حدث SSE من الخادم الوهمي.
 */
export function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Hint بالعربي: دالة تشغيل خادم وهمي يحاكي واجهات Claude و Gemini و Ollama ويسجّل الطلبات الواردة.
 */
export async function startFakeAiServer(): Promise<{ baseUrl: string; requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }>; close: () => Promise<void> }> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url ?? '';
      requests.push({ url, headers: req.headers, body });

      if (url.endsWith('/v1/messages')) {
        if (req.headers['x-api-key'] === 'bad-key') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, 'message_start', { type: 'message_start', message: { model: body.model } });
        if (url.startsWith('/broken')) {
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'نص جزئي' } });
          sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
          res.end();
          return;
        }
        if (url.startsWith('/refuse')) {
          sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' } });
          res.end();
          return;
        }
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'أهلاً ' } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'من Claude' } });
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }
      if (url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'أهلاً ' }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'من Gemini' }] }, finishReason: 'STOP' }] })}\n\n`);
        res.end();
        return;
      }
      if (url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }));
        return;
      }
      if (url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'أهلاً ' }, done: false }) + '\n');
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'من Ollama' }, done: false }) + '\n');
        res.end(JSON.stringify({ done: true }) + '\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * Hint بالعربي: دالة تشغيل أمر git داخل مستودع الاختبار (بهوية اختبار محلية، دون توقيع).
 */
export function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=test@example.test', '-c', 'user.name=Second Brain Test', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات المرحلة 2 وإرجاع قائمة بنتائج الفحص.
 */
export async function runIntegrationTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const root = config.paths.rootDir;

  // 1. ترحيل الإعدادات القديمة + التحقق من القيم + المسارات النسبية
  const legacyDir = path.join(root, 'legacy-config');
  const legacyPath = path.join(legacyDir, 'branding.json');
  writeFixtureFile(
    legacyPath,
    JSON.stringify({
      appName: 'Second Brain',
      assistantNameAr: 'العقل الثاني',
      serverPort: 4777,
      paths: { rootDir: path.resolve(getSystemRootDir(), '..'), docsDir: 'D:\\Custom\\Docs' },
      aiConfig: { defaultMode: 'hybrid', cloudProvider: 'gemini', claudeModel: 'claude-3-7-sonnet-latest', geminiModel: 'gemini-2.5-pro' },
      watchedProjects: [{ id: 'p1', name: 'P1', path: 'D:\\P1' }],
    })
  );
  assert.equal(migrateLegacyConfig(legacyPath), true);
  assert.equal(migrateLegacyConfig(legacyPath), false, 'الترحيل يحدث مرة واحدة فقط');
  const migratedBranding = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
  const migratedSettings = JSON.parse(fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf-8'));
  assert.deepEqual(Object.keys(migratedBranding).sort(), ['appName', 'assistantNameAr']);
  assert.equal(migratedSettings.paths.rootDir, undefined, 'المسار المطابق للافتراضي لا يُكتب');
  assert.equal(migratedSettings.paths.docsDir, 'D:\\Custom\\Docs', 'المسار المخصص يُحفظ');
  assert.ok(fs.existsSync(`${legacyPath}.bak-1`), 'يجب حفظ نسخة من الملف القديم');
  const migratedConfig = loadSystemConfig(legacyPath);
  assert.equal(migratedConfig.aiConfig.claudeModel, 'claude-opus-5-5', 'النموذج المتقادم يُستبدل بالموصى به');
  assert.equal(migratedConfig.aiConfig.geminiModel, 'gemini-3.8-flash');
  assert.equal(migratedConfig.aiConfig.cloudProvider, 'gemini', 'اختيار المستخدم للمزوّد يبقى كما هو');

  const normalized = normalizeSystemConfig({ serverPort: 80, paths: { obsidianVaultDir: 'Vault-X' }, aiConfig: { providerOrder: ['claude', 'magic'] } });
  assert.equal(normalized.config.serverPort, 4777);
  assert.equal(normalized.config.paths.obsidianVaultDir, path.resolve(normalized.config.paths.rootDir, 'Vault-X'));
  assert.deepEqual(normalized.config.aiConfig.providerOrder, ['claude']);
  assert.equal(normalized.warnings.length, 2, 'يجب التحذير من المنفذ والمزوّد غير المعروف');
  passedChecks.push('اختبار ترحيل الإعدادات (فصل الهوية، حذف المسارات الافتراضية، استبدال النماذج المتقادمة) والتحقق من القيم والمسارات النسبية بنجاح.');

  // 2. ترتيب المزوّدين
  const ai = config.aiConfig;
  assert.deepEqual(resolveProviderOrder({ ...ai, providerOrder: undefined, defaultMode: 'hybrid', cloudProvider: 'claude' }), ['claude', 'gemini', 'ollama', 'local']);
  assert.deepEqual(resolveProviderOrder({ ...ai, providerOrder: undefined, defaultMode: 'local' }), ['ollama', 'local']);
  assert.deepEqual(resolveProviderOrder({ ...ai, providerOrder: ['gemini', 'local', 'gemini'] }), ['gemini', 'local']);
  passedChecks.push('اختبار تحديد ترتيب مزوّدي الذكاء (الوضع الهجين والمحلي والترتيب المخصص، والمحلي آخراً دائماً) بنجاح.');

  // 3. المزوّدون عبر خادم وهمي
  const fake = await startFakeAiServer();
  try {
    const deltas: string[] = [];
    const claude = createClaudeProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', timeoutMs: 10000, baseUrl: fake.baseUrl });
    const claudeResult = await claude.chat(SAMPLE_REQUEST, (d) => deltas.push(d));
    assert.equal(claudeResult.text, 'أهلاً من Claude');
    assert.deepEqual(deltas, ['أهلاً ', 'من Claude']);
    const sent = fake.requests.find((r) => r.url === '/v1/messages')!;
    assert.equal(sent.headers['anthropic-version'], '2026-10-21');
    assert.equal(sent.headers['x-api-key'], 'test-key');
    assert.ok(String(sent.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'));
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.fallbacks, 'default');
    assert.deepEqual(sent.body.output_config, { effort: 'medium' });
    assert.equal(sent.body.system, 'تعليمات اختبار');
    const haikuBody = buildClaudeRequestBody({ apiKey: 'k', model: 'claude-haiku-4-5', effort: 'medium', timeoutMs: 1000 }, SAMPLE_REQUEST).body;
    assert.equal(haikuBody.fallbacks, undefined);
    assert.equal(haikuBody.output_config, undefined);
    await assert.rejects(createClaudeProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', timeoutMs: 10000, baseUrl: `${fake.baseUrl}/refuse` }).chat(SAMPLE_REQUEST), /رفض/);
    await assert.rejects(createClaudeProvider({ apiKey: 'bad-key', model: 'claude-opus-5-5', timeoutMs: 10000, baseUrl: fake.baseUrl }).chat(SAMPLE_REQUEST), /مفتاح API/);
    passedChecks.push('اختبار مزوّد Claude (الرؤوس والإصدار 2026-10-21، البثّ، الجهد، البديل عند الرفض، ومعالجة الرفض والمفتاح الخاطئ) بنجاح.');

    const gemini = createGeminiProvider({ apiKey: 'g-key', model: 'gemini-3.8-flash', timeoutMs: 10000, baseUrl: fake.baseUrl });
    assert.equal((await gemini.chat(SAMPLE_REQUEST)).text, 'أهلاً من Gemini');
    const gReq = fake.requests.find((r) => r.url.includes(':streamGenerateContent'))!;
    assert.ok(gReq.url.includes('alt=sse') && !gReq.url.includes('key='), 'المفتاح لا يوضع في الرابط');
    assert.equal(gReq.headers['x-goog-api-key'], 'g-key');
    assert.equal(gReq.body.systemInstruction.parts[0].text, 'تعليمات اختبار');

    const ollama = createOllamaProvider({ endpoint: fake.baseUrl, model: 'llama3.2', timeoutMs: 10000 });
    assert.equal((await ollama.checkAvailability()).ok, true);
    assert.equal((await createOllamaProvider({ endpoint: fake.baseUrl, model: 'missing-model', timeoutMs: 10000 }).checkAvailability()).ok, false);
    assert.equal((await ollama.chat(SAMPLE_REQUEST)).text, 'أهلاً من Ollama');
    passedChecks.push('اختبار مزوّدَي Gemini (المفتاح في الرأس لا الرابط) و Ollama (التحقق من تثبيت النموذج والبثّ سطراً بسطر) بنجاح.');

    // التراجع: Claude بمفتاح خاطئ ← Gemini غير مهيّأ ← المحلي
    const local = createLocalKnowledgeProvider({ assistantNameAr: 'العقل الثاني', familyTitle: 'العائلة', projects: [], projectReports: [], memoryCount: 0 });
    const fallback = await runProvidersWithFallback(
      [createClaudeProvider({ apiKey: 'bad-key', model: 'claude-opus-5-5', timeoutMs: 10000, baseUrl: fake.baseUrl }), createGeminiProvider({ apiKey: undefined, model: 'x', timeoutMs: 1000 }), local],
      SAMPLE_REQUEST
    );
    assert.equal(fallback.providerUsed, 'local');
    assert.deepEqual(fallback.attempts.map((a) => [a.providerId, a.ok, Boolean(a.skipped)]), [['claude', false, false], ['gemini', false, true], ['local', true, false]]);
    // انقطاع بعد بدء البثّ ← مسح النص الجزئي ثم مزوّد آخر
    let resets = 0;
    const recovered = await runProvidersWithFallback(
      [createClaudeProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', timeoutMs: 10000, baseUrl: `${fake.baseUrl}/broken` }), ollama],
      SAMPLE_REQUEST,
      { onReset: () => resets++ }
    );
    assert.equal(recovered.providerUsed, 'ollama');
    assert.equal(resets, 1, 'يجب مسح النص الجزئي قبل المزوّد التالي');
    passedChecks.push('اختبار التراجع بين المزوّدين (تخطي غير المهيّأ، الانتقال عند الخطأ، ومسح النص الجزئي عند الانقطاع أثناء البثّ) بنجاح.');
  } finally {
    await fake.close();
  }

  // 4. بروتوكول MCP
  assert.equal(handleMcpJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'لا رد على الإشعارات');
  assert.equal(JSON.parse(processMcpLine('not json')!).error.code, -32700);
  const init = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as any;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const initUnknown = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as any;
  assert.equal(initUnknown.result.protocolVersion, SUPPORTED_MCP_VERSIONS[0]);
  assert.deepEqual((handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 3, method: 'ping' }) as any).result, {});
  assert.equal((handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }) as any).error.code, -32602);
  const badRecord = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'second_brain_record_shared_memory', arguments: { sourceAI: 'claude-code', projectId: 'x', title: 't' } } }) as any;
  assert.equal(badRecord.error.code, -32602, 'المعامل الإلزامي الناقص يعيد -32602');
  const search = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'second_brain_search_memory', arguments: { query: 'MCP' } } }) as any;
  assert.ok(JSON.parse(search.result.content[0].text).length >= 1, 'البحث يجد سجلات الذاكرة');
  const projectCtx = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'second_brain_get_project_context', arguments: { projectId: config.watchedProjects[0].id } } }) as any;
  assert.ok(projectCtx.result.content[0].text.includes(config.watchedProjects[0].name));

  // تشغيل حقيقي عبر stdio: كل ما يخرج على stdout رسائل JSON-RPC فقط، ولا رد على الإشعار
  const child = spawn(process.execPath, [path.join(getSystemRootDir(), 'src', 'tools', 'mcp-memory-server.ts')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('انتهت مهلة خادم MCP')), 20000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const lines = stdout.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2, 'ردّان فقط (initialize و tools/list) ولا رد على الإشعار');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((p) => p.id), [1, 2]);
  assert.equal(parsed[1].result.tools.length, 6);
  passedChecks.push('اختبار بروتوكول MCP (الإشعارات، ping، التفاوض على الإصدار، رموز الأخطاء، البحث، وتشغيل فعلي عبر stdio بمخرجات نظيفة) بنجاح.');

  // 5. Git + سجل التغييرات عند التغيّر فقط + حماية الملاحظات اليدوية
  const repo = path.join(root, 'git-fixture');
  writeFixtureFile(path.join(repo, 'README.md'), '# Repo');
  writeFixtureFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }));
  writeFixtureFile(path.join(repo, '.env'), 'TOKEN=test-only\n');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '.']);
  gitIn(repo, ['commit', '-q', '-m', 'first commit']);
  const gitProject = { id: 'git-fixture', name: 'Git-Fixture', path: repo, descriptionAr: 'مستودع اختبار', wifeSummaryAr: 'اختبار', monthlyIncome: '—', billingNotes: '—' };
  const report1 = scanAndAnalyzeProject(gitProject);
  assert.equal(report1.gitBranch, 'main');
  assert.equal(report1.lastCommitMessage, 'first commit');
  assert.deepEqual(report1.criticalFilesTrackedByGit, ['.env'], 'يجب اكتشاف الملف الحساس المرفوع على Git');
  assert.ok(report1.updateCommands.includes('git pull'));

  const first = syncProjectWithChanges(gitProject, report1);
  assert.ok(first.changes[0].includes('أول فحص'));
  const changelog = path.join(first.projectFolder, '05-Auto-Changelog.md');
  const changelogAfterFirst = fs.readFileSync(changelog, 'utf-8');
  assert.deepEqual(syncProjectWithChanges(gitProject, scanAndAnalyzeProject(gitProject)).changes, [], 'لا تغيير = لا سطر جديد');
  assert.equal(fs.readFileSync(changelog, 'utf-8'), changelogAfterFirst);

  const overview = path.join(first.projectFolder, '01-Overview.md');
  fs.appendFileSync(overview, '\nملاحظة يدوية مهمة لا يجب أن تضيع\n', 'utf-8');
  writeFixtureFile(path.join(repo, 'index.js'), 'console.log(1)');
  gitIn(repo, ['add', 'index.js']);
  gitIn(repo, ['commit', '-q', '-m', 'second commit']);
  const third = syncProjectWithChanges(gitProject, scanAndAnalyzeProject(gitProject));
  assert.ok(third.changes.some((c) => c.includes('commit جديد') && c.includes('second commit')));
  const overviewText = fs.readFileSync(overview, 'utf-8');
  assert.ok(overviewText.includes('ملاحظة يدوية مهمة لا يجب أن تضيع'), 'الملاحظات اليدوية تبقى بعد التحديث');
  assert.ok(overviewText.includes('second commit') && overviewText.includes(AUTO_START) && overviewText.includes(AUTO_END));

  const customFile = path.join(first.projectFolder, '04-Infra-And-Billing.md');
  fs.writeFileSync(customFile, 'ملف كتبته بيدي بالكامل\n', 'utf-8');
  syncProjectWithChanges(gitProject, scanAndAnalyzeProject(gitProject));
  assert.ok(fs.readFileSync(customFile, 'utf-8').includes('ملف كتبته بيدي بالكامل'), 'الملف اليدوي القديم لا يُحذف');
  passedChecks.push('اختبار فحص Git (الفرع، آخر commit، الملف الحساس المرفوع) وسجل التغييرات عند التغيّر فقط وحماية الملاحظات اليدوية بنجاح.');

  // 5.أ اسم مشروع يحتوي رموزاً ممنوعة في أسماء المجلدات (Windows / روابط Obsidian) لا يعطّل التوثيق
  const oddProject = { ...gitProject, id: 'odd', name: 'App: <Beta> | "v2"?*' };
  const odd = syncProjectWithChanges(oddProject, scanAndAnalyzeProject(oddProject));
  assert.ok(fs.existsSync(path.join(odd.projectFolder, '01-Overview.md')));
  assert.equal(path.basename(odd.projectFolder), 'App- -Beta- - -v2-');
  assert.equal(toSafeFileName('CON'), 'CON-project', 'الأسماء المحجوزة في Windows تُعدَّل');
  passedChecks.push('اختبار أسماء المشاريع ذات الرموز الممنوعة في أسماء المجلدات (توثيق آمن دون أخطاء) بنجاح.');

  // 5.ب ربط الجلسات بالمشاريع من مجلد العمل
  const pA = { ...gitProject, id: 'a', name: 'A', path: path.join(root, 'ws', 'A') };
  const pB = { ...gitProject, id: 'b', name: 'B', path: path.join(root, 'ws2', 'B') };
  const pC = { ...gitProject, id: 'c', name: 'C', path: path.join(root, 'ws2', 'C') };
  const fakeSession = (cwd: string) => ({ ref: { connectorId: 'claude-code', sessionId: 's', filePath: '', modifiedMs: 0, sizeBytes: 0 }, cwd, messages: [] });
  assert.equal(matchSessionToProject(fakeSession(path.join(pA.path, 'src')), [pA, pB, pC])?.id, 'a', 'مجلد فرعي داخل المشروع');
  assert.equal(matchSessionToProject(fakeSession(path.join(root, 'ws')), [pA, pB, pC])?.id, 'a', 'مجلد أب يحتوي مشروعاً واحداً');
  assert.equal(matchSessionToProject(fakeSession(path.join(root, 'ws2')), [pA, pB, pC]), undefined, 'مجلد أب يحتوي عدة مشاريع لا يُنسب لأحدها');
  assert.equal(matchSessionToProject(fakeSession(path.parse(root).root), [pA]), undefined, 'جذر القرص لا يُنسب لأي مشروع');
  passedChecks.push('اختبار ربط جلسات المحادثة بالمشاريع من مجلد العمل (الفرعي، الأب بمشروع واحد، ورفض الحالات الغامضة) بنجاح.');

  // 6. المراقب وإعادة الفحص الشاملة
  assert.equal(startProjectWatcher(() => null).intervalMinutes, 0, 'المراقب معطّل في بيئة الاختبار');
  const summary = rescanAllProjects(null);
  assert.equal(summary.length, config.watchedProjects.length);
  assert.ok(summary.every((s) => !s.error));
  passedChecks.push('اختبار إعادة الفحص الشاملة واحترام إعداد تعطيل المراقب الدوري بنجاح.');

  // 7. تنقية الأسرار
  const dbPassword = ['not', 'a', 'real', 'pass'].join('-');
  const sample = [
    `key ${FAKE_SECRETS.anthropicKey}`,
    FAKE_SECRETS.googleKey,
    `DATABASE_URL=postgres://admin:${dbPassword}@db.example.test:5432/app`,
    `export GITHUB_TOKEN="${FAKE_SECRETS.githubToken}"`,
    FAKE_SECRETS.privateKey,
    'مفتاح الطوارئ SB-1111-2222-3333-4444-5555-6666-7777-8888-ABCD',
  ].join('\n');
  const cleaned = redactSecrets(sample);
  for (const secret of [FAKE_SECRETS.anthropicKey, FAKE_SECRETS.googleKey, dbPassword, FAKE_SECRETS.githubToken, 'FAKEKEYBODY', 'SB-1111']) {
    assert.ok(!cleaned.text.includes(secret), `يجب حذف: ${secret.slice(0, 12)}…`);
  }
  assert.ok(cleaned.text.includes('postgres://admin:') && cleaned.text.includes('GITHUB_TOKEN'), 'يبقى السياق المفيد (اسم المستخدم واسم المتغير)');
  assert.equal(redactSecrets('شرح طريقة إعادة تعيين كلمة المرور للمستخدم').redactions, 0, 'النص العادي لا يتغيّر');
  passedChecks.push('اختبار تنقية الأسرار (مفاتيح API، روابط قواعد البيانات، الرموز، المفاتيح الخاصة، مفتاح الطوارئ) مع إبقاء النص العادي كما هو بنجاح.');

  // 8. البثّ عبر الخادم + حالة المزوّدين
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const streamRes = await postJson(port, '/api/assistant/stream', { question: 'ما الفواتير المهمة؟', mode: 'wife_emergency', history: [{ role: 'assistant', content: 'تُحذف لأنها أول رسالة' }] });
    assert.equal(streamRes.status, 200);
    assert.ok(String(streamRes.headers['content-type']).startsWith('text/event-stream'));
    assert.ok(streamRes.body.includes('event: delta') && streamRes.body.includes('event: done'));
    const done = streamRes.body.split('\n\n').find((b) => b.startsWith('event: done'))!;
    assert.equal(JSON.parse(done.split('data: ')[1]).providerUsed, 'local');
    const providersRes = await fetch(`http://127.0.0.1:${port}/api/assistant/providers`);
    const providers = (await providersRes.json()) as { providers: Array<{ id: string; available: boolean }> };
    assert.deepEqual(providers.providers.map((p) => [p.id, p.available]), [['local', true]]);

    // الإعدادات: القراءة والحفظ تتطلبان إعادة إدخال كلمة المرور الرئيسية (مفتاح الطوارئ لا يكفي)
    resetSessionStateForTests();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 401, 'قراءة الإعدادات دون كلمة المرور مرفوضة');
    const login = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    const cmdCookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const getSettings = () => rawRequest(port, { path: '/api/settings', headers: { Cookie: cmdCookie } });
    assert.equal((await getSettings()).status, 401, 'الخزنة المفتوحة وحدها لا تفتح الإعدادات');
    const ekey = ensureTestVault().emergencyKey;
    assert.equal((await postJson(port, '/api/settings/auth', { password: ekey }, cmdCookie)).status, 401, 'مفتاح الطوارئ لا يفتح الإعدادات');
    assert.equal((await postJson(port, '/api/settings/auth', { password: TEST_MASTER_PASSWORD }, cmdCookie)).status, 200);
    const settings = JSON.parse((await getSettings()).body) as Record<string, any>;
    assert.ok(settings.identity.appName && settings.ai.claudeModel && settings.readOnly.paths.rootDir);
    await postJson(port, '/api/settings/lock', {}, cmdCookie);
    assert.equal((await getSettings()).status, 401, 'مغادرة الإعدادات تلغي الصلاحية فوراً');
    resetSessionStateForTests();
    // كلمة المرور في نافذة الإعدادات تفتح الخزنة المقفلة أيضاً (جلسة جديدة)
    const authLocked = await postJson(port, '/api/settings/auth', { password: TEST_MASTER_PASSWORD });
    assert.equal(authLocked.status, 200);
    assert.ok(String(authLocked.headers['set-cookie'] ?? '').includes('HttpOnly'));
    resetSessionStateForTests();
    const relog = await postJson(port, '/api/settings/auth', { password: TEST_MASTER_PASSWORD });
    const settingsCookie = String(relog.headers['set-cookie'] ?? '').split(';')[0];
    const edited = structuredClone(settings);
    delete edited.readOnly;
    edited.identity.assistantNameAr = 'العقل الثاني المعدّل';
    assert.equal((await postJson(port, '/api/settings', edited)).status, 401, 'الحفظ دون جلسة مرفوض');
    const remote = structuredClone(edited);
    remote.ai.ollamaEndpoint = 'http://evil.example:11434';
    assert.equal((await postJson(port, '/api/settings', remote, settingsCookie)).status, 400, 'عنوان Ollama خارجي مرفوض');
    const badModel = structuredClone(edited);
    badModel.ai.claudeModel = 'model; rm -rf /';
    assert.equal((await postJson(port, '/api/settings', badModel, settingsCookie)).status, 400, 'اسم نموذج غير صالح مرفوض');
    const saved = await postJson(port, '/api/settings', edited, settingsCookie);
    assert.equal(saved.status, 200);
    assert.equal(loadSystemConfig().assistantNameAr, 'العقل الثاني المعدّل', 'التعديل يُحفظ فعلاً');
    assert.deepEqual(loadSystemConfig().aiConfig.providerOrder, ['local'], 'ترتيب المزوّدين غير المعروض في النموذج يبقى كما هو');
    resetSessionStateForTests();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  passedChecks.push('اختبار البثّ التدريجي عبر الخادم (SSE) وحالة المزوّدين وحماية الإعدادات بكلمة المرور في كل مرة (لا تكفي الخزنة المفتوحة ولا مفتاح الطوارئ) والتحقق من القيم بنجاح.');

  return passedChecks;
}
