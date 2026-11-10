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
import { createSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
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
  assert.equal(toolsListRes.result.tools.length, 3, 'يجب أن يوفر خادم MCP الأدوات الثلاث للذاكرة المشتركة');

  const callContextRes = handleMcpJsonRpcRequest({
    method: 'tools/call',
    id: 3,
    params: { name: 'second_brain_get_commander_and_projects_context', arguments: {} },
  });
  assert.ok(callContextRes.result, 'يجب أن يعيد خادم MCP سياق القائد والمشاريع بنجاح');
  passedChecks.push('اختبار خادم الذاكرة الموحد (MCP Memory Server) لجميع الأوامر بنجاح.');

  // 2. اختبار خادم واجهة سطح المكتب (HUD + Wife Mode HTTP Server)
  const server = createSecondBrainDesktopServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
  const healthJson = (await healthRes.json()) as { status: string };
  assert.equal(healthJson.status, 'ok');

  const homeRes = await fetch(`http://127.0.0.1:${port}/`);
  const homeHtml = await homeRes.text();
  assert.ok(homeHtml.includes('secondBrainCoreCanvas'), 'يجب أن تحتوي الواجهة على محرك النواة الهولوغرامية ثلاثية الأبعاد');
  assert.ok(homeHtml.includes('setVisualCoreMode'), 'يجب أن تدعم التبديل بين الأنماط البصرية الأربعة للعقل الثاني');
  assert.ok(homeHtml.includes('وضع العائلة والطوارئ'), 'يجب أن تحتوي الواجهة على وضع العائلة للزوجة');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  passedChecks.push('اختبار خادم وواجهة سطح المكتب (HUD + Wife Mode) عبر اتصال HTTP حقيقي بنجاح.');

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
