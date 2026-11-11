/**
 * ============================================================================
 * الملف: src/features/family-emergency/emergency-kit-service.ts
 * القسم: Features -> Family Emergency (ميزة توليد كتيب ووثيقة الطوارئ للزوجة)
 * Hint بالعربي: يولّد "وثيقة الطوارئ العائلية" الجاهزة للطباعة: رسالة القائد، مفتاح الطوارئ،
 *               مكان النسخ الاحتياطية، وخطوات التشغيل حتى على جهاز جديد.
 *               الوثيقة تُولَّد في الذاكرة فقط وتُعرض للطباعة مرة واحدة — لا يُكتب المفتاح على القرص أبداً.
 * ============================================================================
 */

import { formatTimestampIso } from '../../shared/file-helpers.ts';
import { escapeHtml } from '../../shared/html-helpers.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { normalizeEmergencyKey } from '../../core/crypto-engine.ts';
import { logSystemInfo } from '../../core/logger.ts';

/**
 * Hint بالعربي: دالة توليد صفحة HTML لكتيب الطوارئ العائلي (تُطبع أو تُحفظ PDF من المتصفح).
 *               المدخلات: مفتاح الطوارئ، رسالة شخصية اختيارية، و nonce لسكربت زر الطباعة.
 *               المخرجات: نص HTML كامل (لا يُحفظ على القرص).
 */
export function generatePrintableEmergencyKit(
  emergencyRecoveryKey: string,
  options: { personalMessageAr?: string; scriptNonce?: string } = {}
): string {
  const config = loadSystemConfig();
  const generatedDate = formatTimestampIso().slice(0, 10);
  const key = normalizeEmergencyKey(emergencyRecoveryKey);
  const message =
    options.personalMessageAr ??
    `${config.familyMemberTitle}، هذه الوثيقة هي مفتاحكِ الآمن للوصول إلى جميع مشاريعي، تطبيقاتي، إيميلاتي، وحساباتي. لا تقلقي من أي تفصيلة تقنية؛ فالمساعد الذكي (${config.assistantNameAr}) سيشرح لكِ كل شيء خطوة بخطوة.`;

  const projectsTableRows = config.watchedProjects
    .map(
      (p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${escapeHtml(p.wifeSummaryAr)}</td>
        <td>${escapeHtml(p.monthlyIncome)}</td>
        <td>${escapeHtml(p.billingNotes)}</td>
      </tr>`
    )
    .join('\n');

  const nonceAttr = options.scriptNonce ? ` nonce="${escapeHtml(options.scriptNonce)}"` : '';
  const extraBackupDir = config.security?.extraBackupDir;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="robots" content="noindex" />
  <title>كتيب الطوارئ العائلي — ${escapeHtml(config.appTitleAr)}</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px; line-height: 1.8; font-size: 16px; }
    .card { max-width: 850px; margin: 0 auto; background: #ffffff; border: 2px solid #0284c7; border-radius: 16px; padding: 32px; }
    h1 { color: #0369a1; margin-top: 0; border-bottom: 2px solid #e0f2fe; padding-bottom: 12px; }
    h2 { color: #0f172a; background: #f0f9ff; padding: 8px 14px; border-right: 4px solid #0284c7; border-radius: 6px; }
    .key-box { background: #0f172a; color: #38bdf8; font-family: Consolas, monospace; font-size: 22px; font-weight: bold; text-align: center; padding: 20px; border-radius: 12px; letter-spacing: 1px; margin: 20px 0; border: 2px dashed #38bdf8; direction: ltr; word-break: break-all; }
    code { direction: ltr; unicode-bidi: isolate; background: #f1f5f9; padding: 1px 6px; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #cbd5e1; padding: 10px 12px; text-align: right; vertical-align: top; }
    th { background: #e0f2fe; color: #0369a1; }
    .warning { background: #fff1f2; border-right: 4px solid #e11d48; padding: 14px; border-radius: 8px; margin-top: 20px; }
    .print-btn { background: #0284c7; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 15px; float: left; }
    @media print { body { background: #fff; padding: 0; } .no-print { display: none; } .card { border: none; } }
  </style>
</head>
<body>
  <div class="card">
    <button id="printBtn" class="no-print print-btn">🖨️ طباعة الكتيب أو حفظه PDF</button>
    <h1>🛡️ وثيقة ومفتاح الطوارئ العائلي</h1>
    <p><strong>تاريخ الإصدار:</strong> ${generatedDate} | <strong>مخصصة لـ:</strong> ${escapeHtml(config.familyMemberTitle)}</p>

    <h2>💌 رسالة خاصة لكِ</h2>
    <p>${escapeHtml(message)}</p>

    <h2>🔑 مفتاح الطوارئ لفتح الخزنة</h2>
    <p>هذا المفتاح يفتح خزنة <strong>${escapeHtml(config.appName)}</strong> التي تحتوي جميع الإيميلات وكلمات المرور والملفات المهمة. اكتبيه كما هو (الحروف الصغيرة والمسافات مقبولة):</p>
    <div class="key-box">${escapeHtml(key)}</div>

    <h2>🧭 الدخول على نفس الجهاز</h2>
    <ol>
      <li>افتحي المجلد <code>${escapeHtml(config.paths.rootDir)}</code> وشغّلي الملف <code>Launch-Second-Brain.bat</code>.</li>
      <li>سيفتح المتصفح تلقائياً على <code>http://localhost:${config.serverPort}</code>.</li>
      <li>اضغطي زر <strong>"❤️ وضع العائلة والطوارئ"</strong> في أعلى الشاشة.</li>
      <li>أدخلي مفتاح الطوارئ أعلاه لفتح الخزنة.</li>
    </ol>

    <h2>💻 إذا تعطّل الجهاز: التشغيل على جهاز جديد</h2>
    <ol>
      <li>النسخ الاحتياطية المشفرة محفوظة في: <code>${escapeHtml(config.paths.encryptedBackupsDir)}</code>${
        extraBackupDir ? ` ونسخة إضافية في: <code>${escapeHtml(extraBackupDir)}</code>` : ''
      } (اسم الملف يبدأ بـ <code>Second-Brain-Backup</code>).</li>
      <li>ثبّتي برنامج Node.js (الإصدار 24 أو أحدث) من الموقع الرسمي <code>nodejs.org</code>.</li>
      <li>انسخي مجلد البرنامج كاملاً (من الفلاشة أو السحابة) إلى الجهاز الجديد، وشغّلي <code>Launch-Second-Brain.bat</code>.</li>
      <li>من وضع العائلة اختاري <strong>"استعادة نسخة احتياطية"</strong>، وحددي ملف النسخة، وأدخلي مفتاح الطوارئ نفسه.</li>
    </ol>

    <h2>📊 ملخص المشاريع والفواتير</h2>
    <table>
      <thead>
        <tr><th>اسم المشروع</th><th>شرح مبسط</th><th>الدخل المالي</th><th>الفواتير المطلوبة للاستمرار</th></tr>
      </thead>
      <tbody>
        ${projectsTableRows || '<tr><td colspan="4">لا توجد مشاريع مسجلة بعد.</td></tr>'}
      </tbody>
    </table>

    <div class="warning">
      <strong>⚠️ تحذير أمان مهم جداً:</strong>
      لا تعطي هذا المفتاح أو كلمة مرور الإيميل الرئيسي لأي شخص، ولا تصوّري هذه الورقة أو ترسليها في أي محادثة.
      إذا احتجتِ إلى مبرمج، اسألي المساعد الذكي (${escapeHtml(config.assistantNameAr)}) داخل البرنامج ليرشدكِ خطوة بخطوة.
    </div>
  </div>
  <script${nonceAttr}>
    document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
  </script>
</body>
</html>`;

  logSystemInfo('EmergencyKitService', 'تم توليد كتيب الطوارئ العائلي للطباعة (في الذاكرة فقط، دون حفظ على القرص).');
  return html;
}
