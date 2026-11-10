/**
 * ============================================================================
 * الملف: src/features/family-emergency/emergency-kit-service.ts
 * القسم: Features -> Family Emergency (ميزة توليد كتيب ووثيقة الطوارئ للزوجة)
 * Hint بالعربي: يقوم هذا الملف بتوليد "وثيقة الطوارئ العائلية" الجاهزة للطباعة (HTML/PDF + Markdown)
 *               والتي تحتوي على مفتاح الطوارئ الخاص بالزوجة، رسالة القائد، وخطوات فتح النظام
 *               وإدارة كافة المشاريع والحسابات خطوة بخطوة.
 * ============================================================================
 */

import * as path from 'node:path';
import { ensureDirectoryExists, formatTimestampIso, writeTextFileSafe } from '../../shared/file-helpers.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة لتوليد كتيب الطوارئ العائلي المطبوع (نسخة HTML فاخرة جاهزة للطباعة كـ PDF + نسخة Markdown).
 */
export function generatePrintableEmergencyKit(
  emergencyRecoveryKey: string,
  personalMessageAr?: string,
  customOutputDir?: string
): { htmlFilePath: string; markdownFilePath: string } {
  const config = loadSystemConfig();
  const outDir = customOutputDir ?? config.paths.emergencyKitsDir;
  ensureDirectoryExists(outDir);

  const generatedDate = formatTimestampIso().slice(0, 10);
  const message =
    personalMessageAr ??
    `زوجتي الغالية (${config.familyMemberTitle})، هذه الوثيقة هي مفتاحكِ الآمن للوصول إلى جميع مشاريعي، تطبيقاتي، إيميلاتي، وحساباتي. لا تقلقي من أي تفصيلة تقنية؛ فالمساعد الذكي (${config.assistantNameAr}) سيشرح لكِ كل شيء خطوة بخطوة.`;

  const projectsTableRows = config.watchedProjects
    .map(
      (p) => `
      <tr>
        <td><strong>${p.name}</strong></td>
        <td>${p.wifeSummaryAr}</td>
        <td>${p.monthlyIncome}</td>
        <td>${p.billingNotes}</td>
      </tr>`
    )
    .join('\n');

  const htmlContent = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <title>وثيقة وكتيب الطوارئ العائلي — ${config.appTitleAr}</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; line-height: 1.7; }
    .card { max-width: 850px; margin: 0 auto; background: #ffffff; border: 2px solid #0284c7; border-radius: 16px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
    h1 { color: #0369a1; margin-top: 0; border-bottom: 2px solid #e0f2fe; padding-bottom: 12px; }
    h2 { color: #0f172a; background: #f0f9ff; padding: 8px 14px; border-right: 4px solid #0284c7; border-radius: 6px; }
    .key-box { background: #0f172a; color: #38bdf8; font-family: monospace; font-size: 24px; font-weight: bold; text-align: center; padding: 20px; border-radius: 12px; letter-spacing: 2px; margin: 20px 0; border: 2px dashed #38bdf8; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #cbd5e1; padding: 10px 12px; text-align: right; }
    th { background: #e0f2fe; color: #0369a1; }
    .warning { background: #fff1f2; border-right: 4px solid #e11d48; padding: 14px; border-radius: 8px; margin-top: 20px; }
    @media print { body { background: #fff; padding: 0; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="card">
    <button class="no-print" onclick="window.print()" style="background:#0284c7;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:15px;float:left;">🖨️ طباعة الكتيب أو حفظه كـ PDF</button>
    <h1>🛡️ وثيقة ومفتاح الطوارئ العائلي (${config.appTitleAr})</h1>
    <p><strong>تاريخ الإصدار:</strong> ${generatedDate} | <strong>مخصصة لـ:</strong> ${config.familyMemberTitle}</p>

    <h2>💌 رسالة خاصة لكِ</h2>
    <p>${message}</p>

    <h2>🔑 مفتاح الطوارئ السري لفك تشفير الخزنة (Emergency Recovery Key)</h2>
    <p>استخدمي هذا المفتاح داخل برنامج <strong>${config.appName}</strong> في قسم <strong>"بوابة العائلة / وضع الطوارئ"</strong> لفتح الخزنة السرية والوصول إلى جميع الإيميلات وكلمات المرور والملفات المهمة:</p>
    <div class="key-box">${emergencyRecoveryKey}</div>

    <h2>🧭 خطوات الدخول السريعة (خطوة بخطوة)</h2>
    <ol>
      <li>افتحي المجلد الرئيسي للنظام في المسار: <code>${config.paths.rootDir}</code>.</li>
      <li>شغّلي برنامج <strong>${config.appName}</strong> (أو افتحي واجهة سطح المكتب على الرابط <code>http://localhost:${config.serverPort}</code>).</li>
      <li>اضغطي على زر <strong>"❤️ وضع العائلة والطوارئ (Wife Mode)"</strong> في أعلى الشاشة.</li>
      <li>أدخلي مفتاح الطوارئ الموجود في الصندوق الأسود أعلاه لفتح جميع الإيميلات والباسووردات وتفعيل المساعد الذكي الناطق.</li>
    </ol>

    <h2>📊 ملخص المشاريع والفواتير المرتبطة بها</h2>
    <table>
      <thead>
        <tr>
          <th>اسم المشروع</th>
          <th>شرح مبسط للمشروع</th>
          <th>الدخل المالي</th>
          <th>الفواتير المطلوبة للاستمرار</th>
        </tr>
      </thead>
      <tbody>
        ${projectsTableRows}
      </tbody>
    </table>

    <div class="warning">
      <strong>⚠️ تحذير أمان مهم جداً:</strong>
      لا تعطي هذا المفتاح أو كلمة مرور الإيميل الرئيسي لأي مبرمج خارجي أبداً. إذا احتجتِ إلى مبرمج لصيانة أي مشروع، اسألي المساعد الذكي (${config.assistantNameAr}) داخل البرنامج ليرشدكِ خطوة بخطوة.
    </div>
  </div>
</body>
</html>`;

  const htmlFilePath = path.join(outDir, 'Emergency-Family-Kit-Print.html');
  const markdownFilePath = path.join(outDir, 'Emergency-Family-Kit-Summary.md');

  writeTextFileSafe(htmlFilePath, htmlContent);
  writeTextFileSafe(
    markdownFilePath,
    `# 🛡️ ملخص حقيبة الطوارئ العائلية\n\n* **تاريخ التوليد:** ${generatedDate}\n* **مفتاح الطوارئ:** \`${emergencyRecoveryKey}\`\n* **الرسالة:** ${message}\n`
  );

  logSystemInfo('EmergencyKitService', `تم توليد كتيب الطوارئ العائلي الجاهز للطباعة في: ${htmlFilePath}`);
  return { htmlFilePath, markdownFilePath };
}
