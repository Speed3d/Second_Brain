/**
 * ============================================================================
 * الملف: tests/26-mcp-controls.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات التحكم في أدوات MCP وسجل عملياتها (الإصدار 3.8.0، المرحلة 2.6 من docs/12):
 *               - الأداة المعطّلة لا تظهر في tools/list وتُرفض في tools/call، وتعود بالتفعيل، بلا إعادة تشغيل.
 *               - السجل: البرنامج المستدعي (من initialize)، والأداة، والمشروع، والنتيجة (نجاح، وخطأ، ومعطّلة، ومعاملات
 *                 غير صالحة، وأداة غير معروفة)، والمدة — **بلا أي محتوى**، والمشروع منقّى من الأسرار.
 *               - عملية خادم MCP حقيقية عبر stdio (كما يشغّلها Claude Code): الردود سليمة، والسجل يُكتب.
 *               - المسارات: للقائد فقط، وأسماء الأدوات والقيم مُتحقَّق منها.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { appendMcpAudit, isMcpToolEnabled, readDisabledMcpTools, readMcpAudit, resolveMcpAuditFile, setMcpToolEnabled } from '../src/features/ai-memory/mcp-controls.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { handleMcpJsonRpcRequest, resetMcpClientForTests } from '../src/tools/mcp-memory-server.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const MCP_SERVER = fileURLToPath(new URL('../src/tools/mcp-memory-server.ts', import.meta.url));
const MARKER = 'CONTENT-MARKER-should-never-be-logged';
const FAKE_KEY = 'sk-ant-api03-FAKEfakeFAKEfakeFAKEfakeFAKE0123456789';

function call(id: number, name: string, args?: unknown): Record<string, unknown> {
  return handleMcpJsonRpcRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })!;
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات أدوات MCP وسجلها وإرجاع نتائج الفحص.
 */
export async function runMcpControlsTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const auditFile = resolveMcpAuditFile();
  fs.rmSync(auditFile, { force: true });
  resetMcpClientForTests();

  // ===================== 1. المفاتيح =====================
  handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '9.9.9' } } });
  const list = (): string[] => ((handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name));
  assert.equal(list().length, 6, 'الأدوات الست مفعّلة افتراضياً');
  setMcpToolEnabled('second_brain_record_shared_memory', false);
  assert.equal(isMcpToolEnabled('second_brain_record_shared_memory'), false);
  assert.ok(!list().includes('second_brain_record_shared_memory'), 'المعطّلة لا تظهر');
  const denied = call(3, 'second_brain_record_shared_memory', { sourceAI: 'claude-code', projectId: 'p1', title: 't', summaryAr: MARKER }) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(denied.result.isError, true, 'وتُرفض');
  assert.match(denied.result.content[0].text, /معطّلة/);
  setMcpToolEnabled('second_brain_get_commander_profile', false);
  assert.deepEqual([...readDisabledMcpTools()].sort(), ['second_brain_get_commander_profile', 'second_brain_record_shared_memory']);
  setMcpToolEnabled('second_brain_record_shared_memory', true);
  setMcpToolEnabled('second_brain_get_commander_profile', true);
  assert.equal(list().length, 6, 'التفعيل يعيدها فوراً');
  passedChecks.push('اختبار مفاتيح الأدوات (الست مفعّلة افتراضياً، والمعطّلة لا تظهر وتُرفض برسالة واضحة، والتفعيل يعيدها فوراً بلا إعادة تشغيل) بنجاح.');

  // ===================== 2. السجل بلا محتوى =====================
  const ok = call(4, 'second_brain_record_shared_memory', { sourceAI: 'claude-code', projectId: `p-${FAKE_KEY}`, title: MARKER, summaryAr: `${MARKER} ${FAKE_KEY}`, keyDecisionsAr: [MARKER] }) as { result: { isError?: boolean } };
  assert.notEqual(ok.result.isError, true);
  call(5, 'second_brain_search_memory', { query: MARKER });
  call(6, 'second_brain_get_project_context', {});
  call(7, 'no_such_tool', {});
  call(8, 'second_brain_get_project_context', [1, 2]);
  const raw = fs.readFileSync(auditFile, 'utf8');
  assert.ok(!raw.includes(MARKER), 'لا محتوى في السجل (لا عنوان ولا ملخص ولا قرارات ولا نص بحث)');
  assert.ok(!raw.includes(FAKE_KEY), 'ولا أسرار');
  const audit = readMcpAudit(20);
  assert.deepEqual(audit.map((a) => a.result), ['invalid', 'unknown_tool', 'invalid', 'ok', 'ok', 'disabled'], 'كل النتائج مسجّلة، الأحدث أولاً');
  assert.ok(audit.every((a) => a.client === 'claude-code' && a.clientVersion === '9.9.9'), 'البرنامج المستدعي من initialize');
  assert.equal(audit[4].tool, 'second_brain_record_shared_memory');
  assert.match(String(audit[4].projectId), /^p-.*محذوف لأنه سر/, 'المشروع منقّى');
  assert.ok(audit.every((a) => typeof a.durationMs === 'number' && a.durationMs >= 0));
  assert.deepEqual(Object.keys(audit[0]).sort(), ['at', 'client', 'clientVersion', 'durationMs', 'projectId', 'result', 'tool'], 'حقول ثابتة فقط');
  appendMcpAudit({ client: 'x\u0000y\nz', tool: 't', result: 'ok', durationMs: 1 });
  assert.equal(readMcpAudit(1)[0].client, 'x y z', 'لا رموز تحكم ولا أسطر جديدة');
  passedChecks.push('اختبار سجل العمليات (النجاح والرفض والخطأ والأداة المجهولة، والبرنامج وإصداره، والمشروع منقّى، والمدة، وحقول ثابتة بلا عنوان ولا ملخص ولا نص بحث ولا أسرار) بنجاح.');

  // ===================== 3. عملية خادم MCP حقيقية =====================
  fs.rmSync(auditFile, { force: true });
  const child = spawn(process.execPath, [MCP_SERVER], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'antigravity', version: '1.0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'second_brain_get_commander_profile', arguments: {} } }) + '\n');
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number });
  assert.deepEqual(replies.map((r) => r.id), [1, 2], 'stdout نظيف: ردّان فقط');
  const procAudit = readMcpAudit(5);
  assert.equal(procAudit.length, 1);
  assert.equal(procAudit[0].client, 'antigravity');
  assert.equal(procAudit[0].result, 'ok');
  passedChecks.push('اختبار عملية خادم MCP حقيقية عبر stdio (ردّان صحيحان فقط على stdout، والسجل يحفظ البرنامج المتصل والنتيجة) بنجاح.');

  // ===================== 4. المسارات =====================
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const { masterPassword, emergencyKey } = ensureTestVault();
    const cookie = String((await postJson(port, '/api/vault/unlock', { key: masterPassword })).headers['set-cookie'] ?? '').split(';')[0];
    const got = JSON.parse((await rawRequest(port, { path: '/api/mcp/tools', headers: { Cookie: cookie } })).body) as { tools: Array<{ name: string; enabled: boolean }>; audit: unknown[] };
    assert.equal(got.tools.length, 6);
    assert.ok(got.tools.every((t) => t.enabled));
    assert.equal(got.audit.length, 1);
    assert.equal((await postJson(port, '/api/mcp/tools', { name: 'second_brain_search_memory', enabled: false }, cookie)).status, 200);
    assert.equal(isMcpToolEnabled('second_brain_search_memory'), false, 'التعطيل عبر الخادم');
    assert.equal((await postJson(port, '/api/mcp/tools', { name: 'evil_tool', enabled: false }, cookie)).status, 400);
    assert.equal((await postJson(port, '/api/mcp/tools', { name: 'second_brain_search_memory', enabled: 'no' }, cookie)).status, 400);
    assert.equal((await postJson(port, '/api/mcp/tools', { name: 'second_brain_search_memory', enabled: true }, cookie)).status, 200);
    resetSessionStateForTests();
    const wife = String((await postJson(port, '/api/vault/unlock', { key: emergencyKey })).headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await rawRequest(port, { path: '/api/mcp/tools', headers: { Cookie: wife } })).status, 403, 'العائلة لا ترى أدوات MCP');
    assert.equal((await postJson(port, '/api/mcp/tools', { name: 'second_brain_search_memory', enabled: false }, wife)).status, 403);
    passedChecks.push('اختبار مسارات أدوات MCP (العرض والتفعيل والتعطيل للقائد، ورفض الأداة المجهولة والقيمة غير المنطقية، والعائلة ممنوعة) بنجاح.');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return passedChecks;
}
