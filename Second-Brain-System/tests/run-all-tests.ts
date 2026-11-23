/**
 * ============================================================================
 * الملف: tests/run-all-tests.ts
 * القسم: Tests (المشغل الشامل للاختبارات الدائمة — القانون الثامن)
 * Hint بالعربي: يقوم هذا الملف بتشغيل جميع حزم الاختبارات في المشروع،
 *               ويتحقق من عمل كل دالة وميزة بنسبة 100%، ثم يولد تقريراً مفصلاً
 *               ودائماً في docs/05-TESTS-ARCHIVE-REPORT.md ويحدث فهرس الأكواد.
 * ============================================================================
 */

import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { formatTimestampIso, writeTextFileSafe } from '../src/shared/file-helpers.ts';
import { scanAndGenerateCodeRegistry } from '../src/tools/code-registry-scanner.ts';
import { runCoreAndVaultTests } from './01-core-and-vault.test.ts';
import { runProjectIndexerTests } from './02-project-indexer.test.ts';
import { runAISharedMemoryTests } from './03-ai-shared-memory.test.ts';
import { runFamilyEmergencyTests } from './04-family-emergency.test.ts';
import { runToolsAndDashboardTests } from './05-tools-and-dashboard.test.ts';
import { runSecurityTests } from './06-security.test.ts';
import { runIntegrationTests } from './07-integration.test.ts';
import { runDisasterRecoveryTests } from './08-disaster-recovery.test.ts';
import { runProjectPageTests } from './09-project-page.test.ts';
import { runMaintenanceTests } from './10-maintenance.test.ts';
import { runConnectionGuideTests } from './11-connection-guide.test.ts';
import { runClaudeSubscriptionTests } from './12-claude-subscription.test.ts';
import { runConversationsAndVoiceTests } from './13-conversations-and-voice.test.ts';
import { runInstallerTests } from './14-installer.test.ts';
import { runSyncTests } from './15-sync.test.ts';
import { runMultiWriterSyncTests } from './16-multi-writer-sync.test.ts';
import { runRuntimeSafetyTests } from './17-runtime-safety.test.ts';
import { runFamilyVaultTests } from './18-family-vault.test.ts';
import { runFamilyPortalTests } from './19-family-portal.test.ts';
import { runPasskeyProbeTests } from './20-passkey-probe.test.ts';
import { runPasskeysTests } from './21-passkeys.test.ts';
import { runQrCodeTests } from './22-qr-code.test.ts';
import { runTwoFactorTests } from './23-two-factor.test.ts';
import { runPromptInjectionTests } from './24-prompt-injection.test.ts';
import { runLogRedactionTests } from './25-log-redaction.test.ts';
import { runRedactionPatternTests } from './27-redaction-patterns.test.ts';
import { runPhase2SecurityTests } from './28-phase2-security.test.ts';
import { runMcpControlsTests } from './26-mcp-controls.test.ts';
import { runSecurityReviewLeadsTests } from './29-security-review-leads.test.ts';
import { runKnowledgeBaseTests } from './30-knowledge-base.test.ts';
import { runKnowledgeMcpReviewTests } from './31-knowledge-mcp-review.test.ts';
import { runKnowledgeExtractionTests } from './32-knowledge-extraction.test.ts';
import { runKnowledgeObsidianExportTests } from './33-knowledge-obsidian-export.test.ts';
import { runKnowledgeAssistantTests } from './34-knowledge-assistant.test.ts';
import { setupIsolatedTestEnvironment } from './test-environment.ts';

/**
 * Hint بالعربي: الدالة الرئيسية لتشغيل كافة الاختبارات وتوثيق نتائجها داخل المشروع بشكل دائم.
 */
export async function executeAllSystemTests(): Promise<void> {
  console.log('====================================================================');
  console.log('🛡️ بدء الفحص والتحليل والاختبار الشامل لنظام Second Brain');
  console.log('====================================================================\n');

  const suites: Array<{ name: string; file: string; runner: () => Promise<string[]> }> = [
    {
      name: '1. اختبارات النواة والتشفير والخزنة المزدوجة (Core & AES-256 Vault)',
      file: 'tests/01-core-and-vault.test.ts',
      runner: runCoreAndVaultTests,
    },
    {
      name: '2. اختبارات تشريح المشاريع وصيد الملفات الحرجة ومزامنة Obsidian',
      file: 'tests/02-project-indexer.test.ts',
      runner: runProjectIndexerTests,
    },
    {
      name: '3. اختبارات الذاكرة المشتركة وسحب سجلات Antigravity & Claude Code',
      file: 'tests/03-ai-shared-memory.test.ts',
      runner: runAISharedMemoryTests,
    },
    {
      name: '4. اختبارات المساعد الذكي وبوابة طوارئ الزوجة والنسخ الاحتياطي المشفر',
      file: 'tests/04-family-emergency.test.ts',
      runner: runFamilyEmergencyTests,
    },
    {
      name: '5. اختبارات خادم MCP وفهرس الدوال الآلي وواجهة سطح المكتب',
      file: 'tests/05-tools-and-dashboard.test.ts',
      runner: runToolsAndDashboardTests,
    },
    {
      name: '6. اختبارات الأمان وسلامة البيانات (الخزنة v2، الجلسات، CSRF، XSS، النسخ والاستعادة)',
      file: 'tests/06-security.test.ts',
      runner: runSecurityTests,
    },
    {
      name: '7. اختبارات الربط والمرونة (الإعدادات، مزوّدو الذكاء، MCP، Git، سجل التغييرات، تنقية الأسرار، البثّ)',
      file: 'tests/07-integration.test.ts',
      runner: runIntegrationTests,
    },
    {
      name: '8. اختبار التعافي من الكوارث (محاكاة دليل التشغيل على جهاز جديد من البداية للنهاية)',
      file: 'tests/08-disaster-recovery.test.ts',
      runner: runDisasterRecoveryTests,
    },
    {
      name: '9. اختبارات صفحة المشروع (التفاصيل، المحادثات المؤرشفة، توليد الخلاصة، التعديل وإيقاف المراقبة)',
      file: 'tests/09-project-page.test.ts',
      runner: runProjectPageTests,
    },
    {
      name: '10. اختبارات وضع التطوير (التصفير إلى السلة، الاسترجاع، إفراغ السلة، الاعتماد النهائي)',
      file: 'tests/10-maintenance.test.ts',
      runner: runMaintenanceTests,
    },
    {
      name: '11. اختبارات دليل الربط (اختبار الاتصال بكل مزوّد، الحلول المقترحة، الصلاحيات)',
      file: 'tests/11-connection-guide.test.ts',
      runner: runConnectionGuideTests,
    },
    {
      name: '12. اختبارات Claude عبر الاشتراك (مزوّد Claude Code المعزول، بلا فواتير API، ترتيب التراجع)',
      file: 'tests/12-claude-subscription.test.ts',
      runner: runClaudeSubscriptionTests,
    },
    {
      name: '13. اختبارات المحادثات المحفوظة المشفّرة والنطق العربي المحلي (الحفظ، الحذف، الصلاحيات، Piper)',
      file: 'tests/13-conversations-and-voice.test.ts',
      runner: runConversationsAndVoiceTests,
    },
    {
      name: '14. اختبارات المثبّت والتشغيل التلقائي (سكربتات Windows و macOS، وضع المعاينة، الأيقونة)',
      file: 'tests/14-installer.test.ts',
      runner: runInstallerTests,
    },
    {
      name: '15. اختبارات صيغة المزامنة القديمة والترحيل إلى 2.0 (قفل الأجهزة القديمة، الترحيل عند فتح الخزنة، الكتابة بلا قفل)',
      file: 'tests/15-sync.test.ts',
      runner: runSyncTests,
    },
    {
      name: '16. اختبارات المزامنة متعددة الكتابة (3 أجهزة: تعارضات، أسرار، حذف مقابل تعديل، ساعة متقدمة، فشل الدمج، Drive متأخر، السلة، كلمة المرور، جهاز جديد، تمرين الاستعادة)',
      file: 'tests/16-multi-writer-sync.test.ts',
      runner: runMultiWriterSyncTests,
    },
    {
      name: '17. اختبارات حمايات التشغيل (ISS-032: كشف الكود القديم في الذاكرة، وإيقاف المزامنة، وإعادة التشغيل)',
      file: 'tests/17-runtime-safety.test.ts',
      runner: runRuntimeSafetyTests,
    },
    {
      name: '18. اختبارات الخزنة العائلية v3 (الترقية، مفتاح الطوارئ للعائلة وحدها، العلامة، المحادثات، المزامنة بين جهازين، النسخ القديمة، المسارات)',
      file: 'tests/18-family-vault.test.ts',
      runner: runFamilyVaultTests,
    },
    {
      name: '19. اختبارات بوابة العائلة (جهات الاتصال والتعليمات، والفواتير المتكررة، وسجل خطوات الطوارئ بالمفتاح العائلي، والمزامنة، والنسخ وتمرين الاستعادة، والمساعد العائلي، والمسارات)',
      file: 'tests/19-family-portal.test.ts',
      runner: runFamilyPortalTests,
    },
    {
      name: '20. اختبارات قياس دعم Passkeys و PRF (التصنيف، والتقرير بلا أسرار، والمسارات، والمشغّلات على localhost)',
      file: 'tests/20-passkey-probe.test.ts',
      runner: runPasskeyProbeTests,
    },
    {
      name: '21. اختبارات الدخول بالبصمة أو رمز الجهاز (Passkeys بامتداد PRF: CBOR، والتسجيل والفتح بمصادق برمجي ES256 و RS256، والرفض، والإبطال، والعزل، والمسارات)',
      file: 'tests/21-passkeys.test.ts',
      runner: runPasskeysTests,
    },
    {
      name: '22. اختبارات مولّد باركود QR (متجهات المعيار، والسعة الرسمية، والقارئ العكسي لكل الإصدارات والأقنعة، والكتيب)',
      file: 'tests/22-qr-code.test.ts',
      runner: runQrCodeTests,
    },
    {
      name: '23. اختبارات المصادقة الثنائية والرموز الاحتياطية (متجهات RFC، والحالة داخل الخزنة، والمسارات وبوابة الفتح بكلمة المرور)',
      file: 'tests/23-two-factor.test.ts',
      runner: runTwoFactorTests,
    },
    {
      name: '24. اختبارات الحماية من التعليمات المدسوسة (التنقية، ووسوم البيانات غير الموثوقة في وضعي القائد والعائلة وملخص المشروع، والعزل بلا أدوات)',
      file: 'tests/24-prompt-injection.test.ts',
      runner: runPromptInjectionTests,
    },
    {
      name: '25. اختبارات تنقية السجلات وتدويرها (أسرار متعمّدة في runtime.log، والتدوير 5MB × 3، ومخرجات الطرفية ورسائل الأعطال)',
      file: 'tests/25-log-redaction.test.ts',
      runner: runLogRedactionTests,
    },
    {
      name: '26. اختبارات أدوات MCP وسجل عملياتها (مفتاح لكل أداة، وسجل بلا محتوى، وعملية خادم حقيقية عبر stdio، والمسارات)',
      file: 'tests/26-mcp-controls.test.ts',
      runner: runMcpControlsTests,
    },
    {
      name: '27. اختبارات أنماط التنقيح الجديدة وحالات الفشل الصعبة (Cloudflare وسلاسل الاتصال و .env، وسرّ مقسوم على سطرين أو داخل JSON أو كتلة كود، والحذف الخاطئ، وصياغة الأعداد)',
      file: 'tests/27-redaction-patterns.test.ts',
      runner: runRedactionPatternTests,
    },
    {
      name: '28. الاختبارات الجامعة للمرحلة 2 (جدول الصلاحيات المثبّت وكل مسار محمي عبر HTTP، وحدود المفاتيح على كل ملف مشفّر، ولا نص صريح لأي سرّ في القرص)',
      file: 'tests/28-phase2-security.test.ts',
      runner: runPhase2SecurityTests,
    },
    {
      name: '29. اختبارات خيوط المراجعة الأمنية المستقلة (ISS-046..ISS-053: كل خيط يُعاد إنتاجه في البيئة المعزولة ثم يبقى اختبار انحدار)',
      file: 'tests/29-security-review-leads.test.ts',
      runner: runSecurityReviewLeadsTests,
    },
    {
      name: '30. اختبارات أساس المعرفة (الأنواع والتحقق، ومفتاح المعرفة المشتق، والتخزين المشفّر، والترحيل من الذاكرة المشتركة، والاستعلامات، والمزامنة بين جهازين، والنسخ الاحتياطية)',
      file: 'tests/30-knowledge-base.test.ts',
      runner: runKnowledgeBaseTests,
    },
    {
      name: '31. اختبارات المعرفة مع MCP وقائمة المراجعة (النسخة المحلية من المفتاح، والاقتراحات والاعتماد والرفض، وأدوات MCP الجديدة، والمسارات، ومزامنة القرار)',
      file: 'tests/31-knowledge-mcp-review.test.ts',
      runner: runKnowledgeMcpReviewTests,
    },
    {
      name: '32. اختبارات الاستخراج بالذكاء وكشف التعارض (قراءة الرد وبناء الطلب، والمصادر وحالتها، والاقتراحات بلا تكرار و«استبدل القرار»، والمهمة والإلغاء، واختيار المزوّد)',
      file: 'tests/32-knowledge-extraction.test.ts',
      runner: runKnowledgeExtractionTests,
    },
    {
      name: '33. اختبارات تصدير المعرفة إلى Obsidian (المشاريع المختارة فقط وبلا الحساس، والروابط والفهرس، والحتمية، والحذف والملاحظة اليدوية، والمسار والخيار)',
      file: 'tests/33-knowledge-obsidian-export.test.ts',
      runner: runKnowledgeObsidianExportTests,
    },
    {
      name: '34. اختبارات استرجاع المساعد من المعرفة (سياق السؤال بالقرار ومحادثته وما استبدله، وقسم المعرفة في وضع القائد وحده داخل وسم البيانات، ومن البداية للنهاية بمزوّد وهمي)',
      file: 'tests/34-knowledge-assistant.test.ts',
      runner: runKnowledgeAssistantTests,
    },
  ];

  const reportSections: string[] = [];
  let totalChecksPassed = 0;

  // كل الاختبارات تعمل داخل بيئة مؤقتة معزولة ولا تلمس الخزنة أو Obsidian الحقيقيين
  const testEnv = setupIsolatedTestEnvironment();
  console.log(`🧪 بيئة الاختبار المعزولة: ${testEnv.rootDir}\n`);
  try {
    for (const suite of suites) {
      console.log(`▶️ تشغيل: ${suite.name} (${suite.file})...`);
      const checks = await suite.runner();
      totalChecksPassed += checks.length;
      for (const c of checks) {
        console.log(`   ✅ ${c}`);
      }
      console.log('');
      reportSections.push(
        `### ${suite.name}\n* **ملف الاختبار المحفوظ دائماً:** \`Second-Brain-System/${suite.file}\`\n* **النتيجة:** ✅ ناجح بالكامل (${checks.length} فحوصات دقيقة)\n${checks.map((c) => `  - ✅ ${c}`).join('\n')}`
      );
    }
  } finally {
    testEnv.restore();
  }

  // بعد إغلاق البيئة المعزولة: تحديث فهرس الأكواد وتقرير الاختبارات في أماكنها الحقيقية
  const registry = scanAndGenerateCodeRegistry();

  const config = loadSystemConfig();
  const reportPath = path.join(config.paths.docsDir, '05-TESTS-ARCHIVE-REPORT.md');
  const reportMarkdown = `# 🧪 تقرير الفحص والتحليل وأرشيف الاختبارات الدائمة (Permanent Test Verification Report)

> **تطبيقاً للقانون الثامن (8):** جميع الاختبارات المدونة أدناه محفوظة بشكل دائم داخل مجلد \`Second-Brain-System/tests/\` ولا تُحذف أبداً، لضمان إمكانية إعادة فحص النظام بعد أي تعديل مستقبلي.
> **العزل:** تعمل الاختبارات داخل مجلد مؤقت (\`tests/test-environment.ts\`) يُحذف بعد انتهائها، فلا تلمس الخزنة أو Obsidian أو سجلات المحادثات الحقيقية.
> **تاريخ آخر فحص شامل:** \`${formatTimestampIso()}\`  
> **إجمالي حزم الاختبار:** \`${suites.length}\` | **إجمالي الفحوصات الناجحة:** \`${totalChecksPassed} / ${totalChecksPassed} (100%)\`  
> **إجمالي الدوال المفهرسة آلياً:** \`${registry.entries.length} دالة\`

---

## 📋 تفاصيل نتائج حزم الاختبار

${reportSections.join('\n\n---\n\n')}

---

## 🔄 كيفية إعادة تشغيل الفحص الشامل في أي وقت مستقبلاً
\`\`\`powershell
cd "D:\\Second Brain\\Second-Brain-System"
npm test
\`\`\`
`;

  writeTextFileSafe(reportPath, reportMarkdown);
  console.log('====================================================================');
  console.log(`🎉 اكتملت جميع الاختبارات بنجاح 100%! (${totalChecksPassed} فحص ناجح)`);
  console.log(`📄 تم تحديث تقرير الاختبارات الدائم في: ${reportPath}`);
  console.log(`📑 تم تحديث فهرس الدوال الحي في: ${registry.docsIndexPath}`);
  console.log('====================================================================');
}

executeAllSystemTests().catch((err) => {
  console.error('❌ فشل أحد الاختبارات:', err);
  process.exit(1);
});
