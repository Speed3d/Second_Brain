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
