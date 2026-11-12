/**
 * ============================================================================
 * الملف: tests/05-tools-and-dashboard.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر هذا الملف طبقة الأدوات (Tools): خادم الذاكرة MCP Server،
 *               وأداة فحص وفهرسة الدوال الآلية (Code Registry Scanner)،
 *               بالإضافة إلى خادم واجهة سطح المكتب التفاعلية.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { scanAndGenerateCodeRegistry } from '../src/tools/code-registry-scanner.ts';
import { handleMcpJsonRpcRequest } from '../src/tools/mcp-memory-server.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات خادم MCP، فهرس الدوال الآلي، وخادم واجهة سطح المكتب.
 */
export async function runToolsAndDashboardTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // 1. اختبار خادم MCP للربط مع Google Antigravity و Claude Code
  const initRes = handleMcpJsonRpcRequest({ method: 'initialize', id: 1 });
  assert.ok(initRes.result, 'يجب أن يستجيب خادم MCP لطلب التهيئة initialize');

  const toolsListRes = handleMcpJsonRpcRequest({ method: 'tools/list', id: 2 }) as {
    result: { tools: Array<{ name: string }> };
  };
  assert.equal(toolsListRes.result.tools.length, 6, 'يجب أن يوفر خادم MCP الأدوات الست');

  const callContextRes = handleMcpJsonRpcRequest({
    method: 'tools/call',
    id: 3,
    params: { name: 'second_brain_get_commander_and_projects_context', arguments: {} },
  });
  assert.ok(callContextRes.result, 'يجب أن يعيد خادم MCP سياق القائد والمشاريع بنجاح');
  passedChecks.push('اختبار خادم الذاكرة الموحد (MCP Memory Server) لجميع الأوامر بنجاح.');

  // 2. اختبار خادم واجهة سطح المكتب (HUD + Wife Mode HTTP Server)
  const server = await startSecondBrainDesktopServer(0);
  const address = server.address();
  assert.ok(typeof address === 'object' && address && address.address === '127.0.0.1', 'يجب أن يستمع الخادم على 127.0.0.1 فقط');
  const port = address.port;

  const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
  const healthJson = (await healthRes.json()) as { status: string };
  assert.equal(healthJson.status, 'ok');

  const homeRes = await fetch(`http://127.0.0.1:${port}/`);
  const homeHtml = await homeRes.text();
  const csp = String(homeRes.headers.get('content-security-policy'));
  assert.ok(csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'), 'CSP صارمة بلا unsafe-inline');
  assert.ok(homeHtml.includes('id="coreCanvas"'), 'يجب أن تحتوي الواجهة على النواة المتحركة');
  assert.ok(homeHtml.includes('data-panel="vault"') && homeHtml.includes('data-panel="settings"'), 'يجب أن تحتوي الأقسام الجانبية');
  assert.ok(homeHtml.includes('id="familyShell"'), 'يجب أن تحتوي الواجهة على وضع العائلة');

  for (const [asset, type] of [['app.js', 'text/javascript'], ['hologram.js', 'text/javascript'], ['styles.css', 'text/css']]) {
    const r = await fetch(`http://127.0.0.1:${port}/assets/${asset}`);
    assert.equal(r.status, 200, `يجب خدمة ${asset}`);
    assert.ok(String(r.headers.get('content-type')).startsWith(type));
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/index.html`)).status, 404, 'لا يُخدم إلا الملفات المسموحة');
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/..%2Fdesktop-server.ts`)).status, 404, 'لا يمكن الخروج من مجلد الواجهة');

  const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
  const stateJson = (await stateRes.json()) as { app: { appName: string }; projects: Array<{ name: string }> };
  assert.ok(stateJson.app.appName.length > 0 && stateJson.projects.length >= 1, 'يجب أن تعيد /api/state الهوية والمشاريع');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  passedChecks.push('اختبار خادم وواجهة سطح المكتب (127.0.0.1 فقط، CSP صارمة، الملفات الثابتة المسموحة فقط، بيانات الحالة، وضعا القائد والعائلة) عبر HTTP حقيقي بنجاح.');

  // 3. اختبار أداة الفهرسة الآلية للدوال والأكواد (تطبيقاً للقانون السابع)
  const registryResult = scanAndGenerateCodeRegistry();
  assert.ok(registryResult.entries.length >= 20, 'يجب أن يكتشف ويفهرس كافة دوال النظام');
  assert.ok(fs.existsSync(registryResult.docsIndexPath), 'يجب تحديث ملف الفهرس في docs/');
  assert.ok(fs.existsSync(registryResult.obsidianMirrorPath), 'يجب تحديث نسخة الفهرس في Obsidian');
  passedChecks.push(
    `اختبار أداة الفهرسة الآلية للأكواد وتوثيق (${registryResult.entries.length}) دالة وحالتها بنجاح.`
  );

  return passedChecks;
}
