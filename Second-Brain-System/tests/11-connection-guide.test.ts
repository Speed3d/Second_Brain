/**
 * ============================================================================
 * الملف: tests/11-connection-guide.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات دليل الربط (المرحلة أ.5): زر "اختبار الاتصال" لكل مزوّد عبر خادم وهمي محلي
 *               (بلا أي اتصال حقيقي أو تكلفة): النجاح، النموذج غير المثبّت، Ollama المتوقف، المزوّد بلا مفتاح،
 *               رسائل الحل المقترحة، ورفض المزوّد غير المعروف ووضع الطوارئ.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readRawSettings, loadSystemConfig, updateSystemSettings } from '../src/core/config-manager.ts';
import { suggestFixAr, testProviderConnection } from '../src/features/assistant/provider-tester.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { postJson } from './06-security.test.ts';
import { startFakeAiServer } from './07-integration.test.ts';
import { ensureTestVault } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات دليل الربط وإرجاع نتائج الفحص.
 */
export async function runConnectionGuideTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  // مفاتيح البيئة الحقيقية (إن وُجدت) تُخفى أثناء الاختبار حتى لا يحدث أي اتصال حقيقي
  const envKeys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  envKeys.forEach((k) => delete process.env[k]);
  const originalAi = (readRawSettings().aiConfig ?? loadSystemConfig().aiConfig) as Record<string, unknown>;
  const fake = await startFakeAiServer();
  const { emergencyKey } = ensureTestVault();
  resetSessionStateForTests();
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // 1. Ollama: نجاح، ثم نموذج غير مثبّت، ثم خادم متوقف
    updateSystemSettings({ aiConfig: { ...originalAi, ollamaEndpoint: fake.baseUrl, ollamaModel: 'llama3.2' } });
    const ok = await testProviderConnection('ollama');
    assert.equal(ok.ok, true, ok.reasonAr);
    assert.equal(ok.replyPreview, 'أهلاً من Ollama');
    assert.ok(ok.latencyMs >= 0);
    const chatReq = fake.requests.filter((r) => r.url === '/api/chat').pop();
    assert.ok(!JSON.stringify(chatReq?.body).includes(loadSystemConfig().commanderName) || !loadSystemConfig().commanderName, 'رسالة الاختبار لا تحمل معلومات شخصية');

    updateSystemSettings({ aiConfig: { ...originalAi, ollamaEndpoint: fake.baseUrl, ollamaModel: 'missing-model' } });
    const missing = await testProviderConnection('ollama');
    assert.equal(missing.ok, false);
    assert.match(missing.hintAr ?? '', /ollama pull/, 'يقترح أمر تثبيت النموذج');

    updateSystemSettings({ aiConfig: { ...originalAi, ollamaEndpoint: 'http://127.0.0.1:1', ollamaModel: 'llama3.2' } });
    const down = await testProviderConnection('ollama');
    assert.equal(down.ok, false);
    assert.match(down.hintAr ?? '', /ollama serve/, 'يقترح تشغيل Ollama');
    passedChecks.push('اختبار الاتصال بـ Ollama (نجاح مع زمن الاستجابة، نموذج غير مثبّت، خادم متوقف) مع حل مقترح بالعربية بنجاح.');

    // 2. Claude و Gemini بلا مفاتيح
    const claude = await testProviderConnection('claude');
    assert.equal(claude.ok, false);
    assert.match(claude.reasonAr ?? '', /الخزنة مقفلة/);
    assert.match(claude.hintAr ?? '', /مفاتيح الذكاء الاصطناعي/);
    assert.equal((await testProviderConnection('gemini')).ok, false);
    assert.match(suggestFixAr('claude', 'Claude: تم تجاوز حد الاستخدام مؤقتاً (429)'), /الرصيد/);
    passedChecks.push('اختبار Claude و Gemini بلا مفاتيح: رسالة واضحة توجّه إلى الخزنة، دون أي اتصال بالإنترنت بنجاح.');

    // 3. المسار عبر الخادم
    const viaServer = await postJson(port, '/api/assistant/test', { provider: 'claude' });
    assert.equal(viaServer.status, 200);
    assert.equal(JSON.parse(viaServer.body).ok, false);
    assert.equal((await postJson(port, '/api/assistant/test', { provider: 'local' })).status, 400, 'المزوّد غير القابل للاختبار مرفوض');
    assert.equal((await postJson(port, '/api/assistant/test', { provider: 'evil' })).status, 400);
    const emergency = await postJson(port, '/api/vault/unlock', { key: emergencyKey });
    const cookie = String(emergency.headers['set-cookie'] ?? '').split(';')[0];
    assert.equal((await postJson(port, '/api/assistant/test', { provider: 'ollama' }, cookie)).status, 403, 'وضع الطوارئ لا يختبر المزوّدين');
    passedChecks.push('اختبار مسار /api/assistant/test (رفض المزوّد غير المعروف ووضع الطوارئ) بنجاح.');
  } finally {
    updateSystemSettings({ aiConfig: originalAi });
    envKeys.forEach((k) => {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    });
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  }
  return passedChecks;
}
