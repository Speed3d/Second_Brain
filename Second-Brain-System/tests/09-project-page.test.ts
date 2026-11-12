/**
 * ============================================================================
 * الملف: tests/09-project-page.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات صفحة المشروع (المرحلة أ.3): جلب تفاصيل المشروع، قراءة المحادثات المؤرشفة
 *               (فقط الملفات المسجّلة، مع رفض محاولات الخروج من المجلد)، توليد الخلاصة بمزوّد وهمي،
 *               رسالة واضحة عند غياب أي مزوّد، تعديل المعلومات، وإيقاف المراقبة بصلاحيات القائد.
 *               لا اتصال حقيقي بأي مزوّد، وكل شيء داخل البيئة المؤقتة المعزولة.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { WatchedProjectConfig } from '../src/shared/types.ts';
import { loadSystemConfig, readRawSettings, registerWatchedProject, updateSystemSettings } from '../src/core/config-manager.ts';
import { syncProjectWithChanges } from '../src/features/project-indexer/obsidian-sync.ts';
import { getProjectObsidianFolder, readRecentChangelog } from '../src/features/project-indexer/project-details.ts';
import { scanAndAnalyzeProject } from '../src/features/project-indexer/project-scanner.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { startFakeAiServer } from './07-integration.test.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات صفحة المشروع وإرجاع نتائج الفحص.
 */
export async function runProjectPageTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-project-page-'));
  const projectDir = path.join(workDir, 'page-project');
  writeFixtureFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'page-project', scripts: { start: 'node app.js', build: 'tsc' } }));
  writeFixtureFile(path.join(projectDir, 'README.md'), '# Page Project\nتطبيق تجريبي لحجز المواعيد.');
  const project: WatchedProjectConfig = {
    id: 'page-project',
    name: 'Page Project',
    path: projectDir,
    descriptionAr: 'مشروع اختبار صفحة المشروع',
    wifeSummaryAr: 'تطبيق مواعيد',
    monthlyIncome: '0',
    billingNotes: '',
  };
  registerWatchedProject(project);
  syncProjectWithChanges(project, scanAndAnalyzeProject(project));
  writeFixtureFile(path.join(projectDir, 'index.ts'), 'export const x = 1;');
  syncProjectWithChanges(project, scanAndAnalyzeProject(project));

  // محادثة مؤرشفة داخل مجلد المشروع في Obsidian، وملف سري خارجه لا يجوز الوصول إليه
  const convDir = path.join(getProjectObsidianFolder(project), 'AI-Conversations');
  writeFixtureFile(path.join(convDir, '2026-11-01-claude.md'), '# جلسة تصميم الواجهة\nمحتوى المحادثة');
  writeFixtureFile(path.join(getProjectObsidianFolder(project), 'outside.md'), 'لا يجوز قراءته من مسار المحادثات');

  const changelog = readRecentChangelog(project);
  assert.ok(changelog.length >= 1, 'سجل التغييرات يُقرأ');

  const originalAi = (readRawSettings().aiConfig ?? loadSystemConfig().aiConfig) as Record<string, unknown>;
  const fake = await startFakeAiServer();
  const { emergencyKey } = ensureTestVault();
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  const get = (p: string, cookie?: string) => rawRequest(port, { path: p, headers: cookie ? { Cookie: cookie } : {} });
  try {
    // 1. التفاصيل
    const details = await get('/api/projects/page-project');
    assert.equal(details.status, 200);
    const d = JSON.parse(details.body);
    assert.equal(d.project.name, 'Page Project');
    assert.equal(d.project.pathExists, true);
    assert.ok(d.report.runCommands.length >= 1, 'أوامر التشغيل موجودة');
    assert.ok(Array.isArray(d.changelog) && d.changelog.length >= 1);
    assert.equal(d.conversations.length, 1);
    assert.equal(d.conversations[0].title, 'جلسة تصميم الواجهة');
    assert.equal((await get('/api/projects/no-such-project')).status, 404);
    assert.equal((await get('/api/projects/Bad..Id')).status, 404, 'معرّف بصيغة غير صالحة لا يطابق أي مسار');
    passedChecks.push('اختبار جلب تفاصيل المشروع (التقرير، الأوامر، سجل التغييرات، قائمة المحادثات) ورفض المشاريع غير الموجودة بنجاح.');

    // 2. المحادثات: تتطلب جلسة القائد، وتقبل فقط الملفات المسجّلة
    const convPath = '/api/projects/page-project/conversations/' + encodeURIComponent('2026-11-01-claude.md');
    assert.equal((await get(convPath)).status, 401, 'قراءة المحادثة تتطلب فتح الخزنة');
    const emergencyLogin = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
    const emergencyCookie = String(emergencyLogin.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await get(convPath, emergencyCookie)).status, 403, 'وضع الطوارئ لا يقرأ محادثات القائد');
    resetSessionStateForTests();
    const login = await postJson(port, '/api/vault/unlock', { key: TEST_MASTER_PASSWORD });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const conv = await get(convPath, cookie);
    assert.equal(conv.status, 200);
    assert.ok(JSON.parse(conv.body).content.includes('محتوى المحادثة'));
    for (const evil of ['..%2Foutside.md', encodeURIComponent('../outside.md'), encodeURIComponent('..\\outside.md'), 'outside.md']) {
      const r = await get('/api/projects/page-project/conversations/' + evil, cookie);
      assert.ok(r.status === 404, `محاولة الخروج من مجلد المحادثات مرفوضة (${evil})`);
    }
    passedChecks.push('اختبار قراءة المحادثات المؤرشفة: تتطلب كلمة المرور الرئيسية، وتُرفض أي محاولة لقراءة ملف خارج قائمة المحادثات بنجاح.');

    // 3. توليد الخلاصة: بلا مزوّد ← رسالة واضحة، وبمزوّد Ollama وهمي ← تُحفظ الخلاصة
    updateSystemSettings({ aiConfig: { ...originalAi, providerOrder: ['local'] } });
    const noProvider = await postJson(port, '/api/projects/page-project/summary', {}, cookie);
    assert.equal(noProvider.status, 400);
    assert.match(JSON.parse(noProvider.body).error, /لا يوجد مزوّد ذكاء/);
    updateSystemSettings({ aiConfig: { ...originalAi, providerOrder: ['ollama'], ollamaEndpoint: fake.baseUrl, ollamaModel: 'llama3.2' } });
    const summary = await postJson(port, '/api/projects/page-project/summary', {}, cookie);
    assert.equal(summary.status, 200, summary.body);
    assert.equal(JSON.parse(summary.body).providerUsed, 'ollama');
    assert.equal(loadSystemConfig().watchedProjects.find((p) => p.id === 'page-project')?.summaryAr, 'أهلاً من Ollama', 'الخلاصة تُحفظ في الإعدادات');
    const chatReq = fake.requests.filter((r) => r.url === '/api/chat').pop();
    assert.ok(JSON.stringify(chatReq?.body).includes('حجز المواعيد'), 'سياق الخلاصة يتضمن محتوى README');
    passedChecks.push('اختبار توليد خلاصة المشروع بمزوّد ذكاء (وهمي) وحفظها، مع رسالة واضحة عند عدم توفر أي مزوّد بنجاح.');

    // 4. التعديل والفتح والإيقاف: للقائد فقط
    assert.equal((await postJson(port, '/api/projects/page-project/update', { descriptionAr: 'x' })).status, 401, 'التعديل يتطلب فتح الخزنة');
    const updated = await postJson(port, '/api/projects/page-project/update', { descriptionAr: 'وصف جديد', wifeSummaryAr: 'شرح جديد', monthlyIncome: '', billingNotes: '', summaryAr: 'خلاصة يدوية' }, cookie);
    assert.equal(updated.status, 200, updated.body);
    const after = loadSystemConfig().watchedProjects.find((p) => p.id === 'page-project');
    assert.equal(after?.descriptionAr, 'وصف جديد');
    assert.equal(after?.summaryAr, 'خلاصة يدوية');
    assert.equal(after?.monthlyIncome, 'غير محدد بعد');
    assert.equal((await postJson(port, '/api/projects/page-project/open', { target: 'folder' })).status, 401, 'فتح المجلد يتطلب فتح الخزنة');
    assert.equal((await postJson(port, '/api/projects/page-project/remove', {})).status, 401, 'إيقاف المراقبة يتطلب فتح الخزنة');
    const removed = await postJson(port, '/api/projects/page-project/remove', {}, cookie);
    assert.equal(removed.status, 200);
    assert.equal(loadSystemConfig().watchedProjects.some((p) => p.id === 'page-project'), false, 'أُزيل المشروع من المراقبة');
    assert.ok(fs.existsSync(getProjectObsidianFolder(project)), 'وثائق Obsidian تبقى بعد إيقاف المراقبة');
    assert.equal((await get('/api/projects/page-project')).status, 404);
    passedChecks.push('اختبار تعديل معلومات المشروع وخلاصته، وإيقاف مراقبته مع بقاء وثائقه، وأن الفتح والتعديل والإيقاف للقائد فقط بنجاح.');
  } finally {
    updateSystemSettings({ aiConfig: originalAi });
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return passedChecks;
}
