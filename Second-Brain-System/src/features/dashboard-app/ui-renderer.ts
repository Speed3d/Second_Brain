/**
 * ============================================================================
 * الملف: src/features/dashboard-app/ui-renderer.ts
 * القسم: Features -> Dashboard App (ميزة عرض واجهة غرفة القيادة الهولوغرامية التفاعلية)
 * Hint بالعربي: يبني صفحة الواجهة (وضع القائد + وضع العائلة) ويدمج أنماط الهولوغرام والنواة المتحركة.
 *               كل قيمة متغيرة تمر عبر escapeHtml لمنع حقن الأكواد، وكل ما يخص الخزنة يُجلب من الخادم
 *               بعد فتح الجلسة ويُبنى في المتصفح عبر textContent (لا يُحقن كـ HTML أبداً).
 * ============================================================================
 */

import type { ProjectScanReport, SharedAIMemoryEntry, SystemBrandingConfig } from '../../shared/types.ts';
import { escapeHtml as e } from '../../shared/html-helpers.ts';
import { getSecondBrainHologramClientScript } from './hologram-core-script.ts';
import { getSecondBrainHolographicStyles } from './hud-styles.ts';
import { getVaultClientScript } from './vault-client-script.ts';

/**
 * Hint بالعربي: دالة بناء صفحة الواجهة الهولوغرامية التفاعلية الكاملة لبرنامج سطح المكتب.
 */
export function renderSecondBrainDesktopHTML(
  config: SystemBrandingConfig,
  projectReports: ProjectScanReport[],
  memories: SharedAIMemoryEntry[]
): string {
  const totalCriticalFiles = projectReports.reduce((acc, r) => acc + r.criticalFilesFound.length, 0);

  const projectsHtml =
    projectReports
      .map(
        (p) => `
      <div class="holo-item-card" onmouseenter="playSciFiTone(880, 1020, 0.04)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong style="color:var(--cyan-glow);font-size:14.5px;">🚀 <bdi>${e(p.projectName)}</bdi></strong>
          <span dir="ltr" style="font-size:11px;color:var(--amber-bright);font-family:monospace;">${e(p.detectedStack.join(' | '))}</span>
        </div>
        <div dir="ltr" style="font-family:monospace;font-size:11.5px;color:var(--text-muted);margin:4px 0;text-align:left;">📂 ${e(p.projectPath)}</div>
        <div style="font-size:12.5px;margin-top:6px;">
          <span style="color:var(--emerald-glow);">▶️ التشغيل:</span> <code dir="ltr">${e(p.runCommands[0] ?? 'npm start')}</code>
          <br/>
          <span style="color:var(--amber-bright);">🔐 الملفات الحساسة المكتشفة:</span> <strong>(${p.criticalFilesFound.length}) ملف</strong>
        </div>
      </div>`
      )
      .join('\n') || '<p style="font-size:12.5px;color:var(--text-muted);">لا توجد مشاريع مسجلة بعد.</p>';

  const wifeProjectsHtml =
    config.watchedProjects
      .map(
        (p) => `
      <div class="holo-item-card" style="border-right-color:var(--rose-glow);">
        <h3 style="margin:0 0 6px 0;color:#fda4af;">📱 مشروع: <bdi>${e(p.name)}</bdi></h3>
        <p style="margin:4px 0;font-size:14px;"><strong>ما هو هذا المشروع؟</strong> ${e(p.wifeSummaryAr)}</p>
        <p style="margin:4px 0;font-size:14px;"><strong>💰 الدخل المالي:</strong> ${e(p.monthlyIncome)}</p>
        <p style="margin:4px 0;font-size:14px;"><strong>🧾 الفواتير المطلوبة للاستمرار:</strong> ${e(p.billingNotes)}</p>
      </div>`
      )
      .join('\n') || '<p style="font-size:14px;">لا توجد مشاريع مسجلة بعد.</p>';

  const memoriesHtml =
    memories.length > 0
      ? memories
          .slice(0, 6)
          .map(
            (m) => `
          <div class="holo-item-card" style="border-right-color:var(--amber-bright);">
            <div style="display:flex;justify-content:space-between;gap:8px;">
              <strong style="font-size:13px;color:#fff;">🧠 ${e(m.title)}</strong>
              <span dir="ltr" style="font-size:11px;color:var(--amber-bright);">${e(m.sourceAI)}</span>
            </div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">${e(m.summaryAr)}</div>
          </div>`
          )
          .join('\n')
      : '<p style="font-size:12.5px;color:var(--text-muted);">لا توجد سجلات ذاكرة بعد.</p>';

  const voiceBarsHtml = Array.from({ length: 28 })
    .map(() => `<div class="v-bar"></div>`)
    .join('');

  const categoryOptions = `
    <option value="email_account">📧 حساب بريد إلكتروني</option>
    <option value="password" selected>🔑 كلمة مرور / حساب</option>
    <option value="api_key">🧩 مفتاح API</option>
    <option value="recovery_code">🛟 أكواد استرداد (2FA)</option>
    <option value="billing">💳 فواتير واشتراكات</option>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${e(config.appTitleAr)}</title>
  <style>${getSecondBrainHolographicStyles()}
    [hidden] { display: none !important; }
    select { width: 100%; background: rgba(2, 8, 18, 0.85); border: 1px solid rgba(0, 240, 255, 0.25); color: var(--text-bright); padding: 9px 12px; border-radius: 6px; margin-bottom: 8px; font-family: inherit; }
    .vault-status { font-size: 13px; margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; background: rgba(0, 240, 255, 0.06); border: 1px solid var(--cyan-dim); }
    .vault-status.unlocked { border-color: var(--emerald-glow); background: rgba(0, 255, 157, 0.07); }
    .secret-card { background: rgba(3, 10, 22, 0.78); border: 1px solid rgba(0, 240, 255, 0.16); border-right: 3px solid var(--emerald-glow); padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; font-size: 13px; }
    .secret-card .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .secret-card .value { font-family: Consolas, monospace; direction: ltr; unicode-bidi: isolate; word-break: break-all; }
    .mini-btn { background: transparent; border: 1px solid var(--cyan-dim); color: var(--text-bright); border-radius: 4px; padding: 3px 8px; font-size: 12px; cursor: pointer; margin-inline-start: 4px; }
    .mini-btn:hover { border-color: var(--cyan-glow); }
    .mini-btn.danger { border-color: rgba(255, 56, 119, 0.5); color: #fda4af; }
    .key-reveal { font-family: Consolas, monospace; font-size: 17px; direction: ltr; text-align: center; background: #020813; border: 2px dashed var(--amber-bright); color: var(--amber-bright); padding: 12px; border-radius: 8px; margin: 8px 0; word-break: break-all; user-select: all; }
    .wife-mode-text { font-size: 15px; line-height: 1.9; }
  </style>
</head>
<body>
  <header class="hud-topbar">
    <div class="hud-brand">
      <div class="reactor-mini"></div>
      <div>
        <div class="brand-text">${e(config.appName)}</div>
        <div style="font-size:11.5px;color:var(--text-muted);">${e(config.appTitleAr)} • v${e(config.version)}</div>
      </div>
    </div>

    <div class="telemetry-bar">
      <div class="telemetry-item">المشاريع: <strong>${projectReports.length}</strong></div>
      <div class="telemetry-item">الخزنة: <strong id="telemetryVault">…</strong></div>
      <div class="telemetry-item">ملفات حساسة: <strong>${totalCriticalFiles}</strong></div>
      <div class="telemetry-item">الذاكرة: <strong>${memories.length}</strong></div>
    </div>

    <div class="mode-switcher">
      <button id="btnSoundToggle" class="hud-tab-btn" onclick="toggleSoundFx()">🔇 المؤثرات: صامت</button>
      <button id="btnCmdMode" class="hud-tab-btn active-cmd" onclick="switchMode('commander')">⚡ غرفة القيادة</button>
      <button id="btnWifeMode" class="hud-tab-btn" onclick="switchMode('wife_emergency')">❤️ وضع العائلة والطوارئ</button>
    </div>
  </header>

  <!-- ==================== 1. غرفة قيادة القائد ==================== -->
  <main id="commanderModeSection" class="cockpit-layout">
    <section>
      <div class="holo-panel">
        <div class="panel-title">
          <span>📡 رادار المشاريع</span>
          <span class="tag-amber">${projectReports.length}</span>
        </div>
        <div style="max-height:245px;overflow-y:auto;padding-left:4px;">${projectsHtml}</div>
        <button class="holo-btn" style="width:100%;margin-top:8px;" onclick="rescanProjects()">🔄 إعادة الفحص وتحديث Obsidian (وتأمين الملفات إن كانت الخزنة مفتوحة)</button>
        <details style="margin-top:10px;border-top:1px solid rgba(0,240,255,0.15);padding-top:10px;">
          <summary style="cursor:pointer;color:var(--amber-bright);font-weight:700;font-size:13px;">➕ إضافة مشروع جديد للتشريح والتأمين</summary>
          <div style="margin-top:10px;">
            <input id="projName" placeholder="اسم المشروع (مثال: My-Flutter-App)" maxlength="120" />
            <input id="projPath" dir="ltr" placeholder="D:\\Projects\\MyApp" maxlength="500" />
            <input id="projDesc" placeholder="وصف تقني للمشروع" />
            <input id="projWifeDesc" placeholder="شرح مبسط لزوجتك عن هذا المشروع" />
            <input id="projIncome" placeholder="الدخل الشهري للمشروع" />
            <input id="projBilling" placeholder="الفواتير وموعد تجديد السيرفر/الدومين" />
            <button class="holo-btn" onclick="addProject()">🔍 فحص وتوثيق في Obsidian</button>
          </div>
        </details>
        <div id="projectsOutputBox" class="terminal-output" hidden></div>
      </div>

      <div class="holo-panel">
        <div class="panel-title">
          <span>🧠 الذاكرة الموحدة (Antigravity و Claude)</span>
          <span class="tag-amber">MCP</span>
        </div>
        <button class="holo-btn holo-btn-amber" style="width:100%;margin-bottom:10px;" onclick="harvestLogs()">🔄 سحب وأرشفة المحادثات</button>
        <div style="max-height:210px;overflow-y:auto;padding-left:4px;">${memoriesHtml}</div>
      </div>
    </section>

    <section class="core-stage">
      <div class="visual-mode-pills">
        <button class="pill-btn active" onclick="setVisualCoreMode('fusion', this)">🔥 الوضع المدمج</button>
        <button class="pill-btn" onclick="setVisualCoreMode('cyan_wave', this)">🌊 الكرة الموجية</button>
        <button class="pill-btn" onclick="setVisualCoreMode('neural_cloud', this)">⚪ السحابة العصبية</button>
        <button class="pill-btn" onclick="setVisualCoreMode('hud_rings', this)">🎯 الحلقات</button>
      </div>

      <div class="canvas-wrapper" title="اضغط على النواة لإطلاق نبضة طاقة">
        <canvas id="secondBrainCoreCanvas"></canvas>
        <div id="coreOverlayStatus" class="core-overlay-status">SYSTEM ONLINE</div>
      </div>

      <div class="voice-bars">${voiceBarsHtml}</div>

      <div class="holo-panel" style="width:100%;max-width:620px;margin-top:4px;">
        <div class="panel-title">
          <span>🎙️ المحادثة مع ${e(config.assistantNameAr)}</span>
        </div>
        <textarea id="aiQuestionInput" rows="2" placeholder="اكتب سؤالك (مثال: ما هي حالة المشاريع والملفات الحساسة؟)"></textarea>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          <button class="holo-btn" onclick="askAssistant('commander')">⚡ إرسال</button>
          <button class="holo-btn holo-btn-amber" onclick="startVoiceInput('aiQuestionInput', 'commander')">🎤 تحدث بالمايكروفون</button>
          <button class="holo-btn" onclick="speakLastAnswer()">🔊 نطق الرد</button>
        </div>
        <div id="aiResponseBox" class="terminal-output">بانتظار أوامرك...</div>
      </div>
    </section>

    <section>
      <div class="holo-panel">
        <div class="panel-title">
          <span>🔐 الخزنة المشفرة (AES-256-GCM)</span>
        </div>
        <div id="vaultStatusLine" class="vault-status">جاري التحقق من حالة الخزنة...</div>

        <div id="vaultSetupBox" hidden>
          <p style="font-size:13px;margin-top:0;">لا توجد خزنة بعد. اختر كلمة مرور رئيسية قوية (10 أحرف على الأقل) لا تستخدمها في أي مكان آخر:</p>
          <input id="setupPass" type="password" autocomplete="new-password" placeholder="كلمة المرور الرئيسية الجديدة" />
          <input id="setupPass2" type="password" autocomplete="new-password" placeholder="تأكيد كلمة المرور" />
          <button class="holo-btn holo-btn-amber" onclick="setupVault()">🛡️ إنشاء الخزنة</button>
        </div>

        <div id="vaultUnlockBox" hidden>
          <input id="vaultMasterPass" type="password" autocomplete="current-password" placeholder="كلمة المرور الرئيسية" onkeydown="if(event.key==='Enter')unlockVaultUI('vaultMasterPass')" />
          <button class="holo-btn holo-btn-amber" onclick="unlockVaultUI('vaultMasterPass')">🔓 فتح الخزنة</button>
        </div>

        <div id="vaultOpenBox" hidden>
          <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
            <button class="holo-btn" onclick="lockVaultUI()">🔒 قفل الآن</button>
          </div>
          <details id="addSecretDetails">
            <summary style="cursor:pointer;color:var(--amber-bright);font-weight:700;font-size:13px;">➕ إضافة حساب أو سر جديد</summary>
            <div style="margin-top:8px;">
              <select id="secretCategory">${categoryOptions}</select>
              <input id="secretTitle" maxlength="200" placeholder="العنوان (مثال: إيميل Google Play الرسمي)" />
              <input id="secretUser" dir="ltr" maxlength="300" placeholder="الإيميل أو اسم المستخدم" />
              <input id="secretVal" type="password" autocomplete="off" placeholder="كلمة المرور أو الكود السري" />
              <input id="secretUrl" dir="ltr" maxlength="500" placeholder="رابط الموقع (اختياري)" />
              <input id="secretWifeNote" maxlength="2000" placeholder="شرح مبسط لزوجتك حول هذا الحساب" />
              <button class="holo-btn" onclick="saveSecret()">🔒 تشفير وحفظ</button>
            </div>
          </details>
          <input id="secretSearch" placeholder="🔎 بحث في الأسرار..." oninput="renderSecretsList('commanderSecretsList', true)" style="margin-top:8px;" />
          <div id="commanderSecretsList" style="max-height:300px;overflow-y:auto;"></div>
        </div>
        <div id="vaultOutputBox" class="terminal-output" hidden></div>
      </div>

      <div class="holo-panel">
        <div class="panel-title">
          <span>🛡️ الطوارئ والنسخ الاحتياطي</span>
        </div>
        <p style="font-size:12.5px;color:var(--text-muted);margin-top:0;">لطباعة كتيب الطوارئ أدخل مفتاح الطوارئ الحالي؛ يتحقق البرنامج أنه يفتح الخزنة فعلاً قبل الطباعة.</p>
        <input id="kitEmergencyKey" dir="ltr" placeholder="SB-XXXX-XXXX-..." autocomplete="off" />
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          <button class="holo-btn holo-btn-amber" onclick="printEmergencyKit()">🖨️ طباعة كتيب الطوارئ</button>
          <button class="holo-btn" onclick="createBackupUI()">💾 نسخة احتياطية مشفرة الآن</button>
        </div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;color:var(--amber-bright);font-weight:700;font-size:13px;">🔑 تغيير كلمة المرور أو إصدار مفتاح طوارئ جديد</summary>
          <div style="margin-top:8px;">
            <input id="cpCurrent" type="password" autocomplete="current-password" placeholder="كلمة المرور الحالية" />
            <input id="cpNew" type="password" autocomplete="new-password" placeholder="كلمة المرور الجديدة (10 أحرف على الأقل)" />
            <button class="holo-btn" onclick="changePasswordUI()">تغيير كلمة المرور</button>
            <hr style="border-color:rgba(0,240,255,0.15);" />
            <p style="font-size:12px;color:#fda4af;">إصدار مفتاح جديد يُبطل الورقة المطبوعة القديمة فوراً.</p>
            <input id="rotPass" type="password" autocomplete="current-password" placeholder="كلمة المرور الرئيسية للتأكيد" />
            <button class="holo-btn holo-btn-amber" onclick="rotateKeyUI()">إصدار مفتاح طوارئ جديد</button>
          </div>
        </details>
        <div id="emergencyOutputBox" class="terminal-output" hidden></div>
        <div id="backupsListCommander" style="font-size:12px;color:var(--text-muted);margin-top:8px;"></div>
      </div>
    </section>
  </main>

  <!-- ==================== 2. وضع العائلة والطوارئ ==================== -->
  <section id="wifeModeSection" style="display:none;max-width:1220px;margin:24px auto;padding:0 20px;" class="wife-mode-text">
    <div class="holo-panel" style="border-color:var(--rose-glow);background:linear-gradient(135deg, rgba(40,10,35,0.85), rgba(10,20,42,0.9));">
      <h1 style="margin:0 0 8px 0;color:#fda4af;">❤️ أهلاً بكِ يا ${e(config.familyMemberTitle)}</h1>
      <p style="margin:0;font-size:16px;color:#fce7f3;">هذه البوابة تشرح لكِ كل مشروع وحساباته وفواتيره خطوة بخطوة، بدون أي تعقيد تقني.</p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:22px;">
      <div class="holo-panel">
        <div class="panel-title"><span style="color:#fda4af;">🔑 الخطوة 1: فتح خزنة الحسابات بمفتاح الطوارئ</span></div>
        <p>أدخلي <strong>مفتاح الطوارئ</strong> المكتوب في الوثيقة المطبوعة لديكِ (الحروف الصغيرة والمسافات مقبولة):</p>
        <input id="wifeEmergencyInput" dir="ltr" autocomplete="off" placeholder="SB-XXXX-XXXX-..." onkeydown="if(event.key==='Enter')unlockVaultUI('wifeEmergencyInput')" />
        <button class="holo-btn holo-btn-amber" onclick="unlockVaultUI('wifeEmergencyInput')">🔓 فتح وعرض الحسابات</button>
        <button class="holo-btn" onclick="lockVaultUI()">🔒 قفل</button>
        <div id="wifeVaultStatus" class="vault-status" style="margin-top:8px;">الخزنة مقفلة.</div>
        <div id="wifeSecretsList"></div>

        <div class="panel-title" style="margin-top:20px;"><span style="color:var(--cyan-glow);">📊 الخطوة 2: المشاريع والدخل والفواتير</span></div>
        ${wifeProjectsHtml}

        <details style="margin-top:16px;">
          <summary style="cursor:pointer;color:var(--amber-bright);font-weight:700;">💻 استعادة نسخة احتياطية (إذا تعطّل الجهاز)</summary>
          <div style="margin-top:8px;">
            <p style="font-size:14px;">اختاري ملف النسخة، ثم أدخلي مفتاح الطوارئ، ثم مجلداً جديداً فارغاً للاستعادة.</p>
            <div id="backupsListWife" style="font-size:13px;margin-bottom:6px;"></div>
            <input id="restoreFile" dir="ltr" placeholder="مسار ملف النسخة (...enc.json)" />
            <input id="restoreKey" dir="ltr" autocomplete="off" placeholder="مفتاح الطوارئ أو كلمة المرور الرئيسية" />
            <input id="restoreTarget" dir="ltr" placeholder="مجلد جديد للاستعادة (مثال: D:\\Second Brain Restored)" />
            <button class="holo-btn" onclick="restoreBackupUI(true)">👁️ معاينة</button>
            <button class="holo-btn holo-btn-amber" onclick="restoreBackupUI(false)">♻️ استعادة</button>
            <div id="restoreOutputBox" class="terminal-output" hidden></div>
          </div>
        </details>
      </div>

      <div class="holo-panel">
        <div class="panel-title"><span style="color:var(--amber-bright);">🎙️ الخطوة 3: اسألي المساعد (${e(config.assistantNameAr)})</span></div>
        <p>اسألي بالكتابة أو بالصوت، أو اضغطي أحد الأسئلة الجاهزة:</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          <button class="mini-btn" onclick="askPreset('ما هي الفواتير المهمة التي يجب دفعها؟')">🧾 الفواتير المهمة</button>
          <button class="mini-btn" onclick="askPreset('كيف أتعامل مع مبرمج بأمان؟')">👨‍💻 التعامل مع مبرمج</button>
          <button class="mini-btn" onclick="askPreset('اعطني ملخصاً عن كل المشاريع')">📋 ملخص المشاريع</button>
        </div>
        <textarea id="wifeQuestionInput" rows="3" placeholder="اكتبي سؤالكِ هنا..."></textarea>
        <div>
          <button class="holo-btn holo-btn-amber" onclick="askAssistant('wife_emergency')">💬 اسألي المساعد</button>
          <button class="holo-btn" onclick="startVoiceInput('wifeQuestionInput', 'wife_emergency')">🎤 تحدثي بالصوت</button>
          <button class="holo-btn" onclick="speakLastAnswer()">🔊 استمعي للإجابة</button>
        </div>
        <div id="wifeAiResponseBox" class="terminal-output" style="min-height:180px;">مرحباً بكِ، أنا جاهز لإرشادكِ في أي وقت...</div>
      </div>
    </div>
  </section>

  <script>
    ${getSecondBrainHologramClientScript()}
    ${getVaultClientScript()}

    let lastSpokenText = '';

    function switchMode(mode) {
      playSciFiTone(540, 1080, 0.12, 'triangle');
      const isWife = mode === 'wife_emergency';
      document.getElementById('commanderModeSection').style.display = isWife ? 'none' : 'grid';
      document.getElementById('wifeModeSection').style.display = isWife ? 'block' : 'none';
      document.getElementById('btnCmdMode').className = isWife ? 'hud-tab-btn' : 'hud-tab-btn active-cmd';
      document.getElementById('btnWifeMode').className = isWife ? 'hud-tab-btn active-wife' : 'hud-tab-btn';
    }

    function askPreset(text) {
      document.getElementById('wifeQuestionInput').value = text;
      askAssistant('wife_emergency');
    }

    async function askAssistant(mode) {
      playSciFiTone(620, 1240, 0.1);
      setSecondBrainAIState('THINKING');
      energyPulse = 1.1;
      const inputId = mode === 'wife_emergency' ? 'wifeQuestionInput' : 'aiQuestionInput';
      const boxId = mode === 'wife_emergency' ? 'wifeAiResponseBox' : 'aiResponseBox';
      const question = document.getElementById(inputId).value.trim() || 'اعطني ملخصاً شاملاً';
      const box = document.getElementById(boxId);
      box.textContent = '⏳ جاري التحليل...';
      try {
        const data = await api('/api/assistant', { body: { question: question, mode: mode } });
        box.textContent = data.answerAr;
        lastSpokenText = box.textContent;
        setSecondBrainAIState('SPEAKING');
        speakLastAnswer();
      } catch (err) {
        box.textContent = '❌ ' + err.message;
      }
      setTimeout(function () { setSecondBrainAIState('IDLE'); }, 3200);
    }

    function speakLastAnswer() {
      if (!lastSpokenText || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(lastSpokenText.replace(/[*#_\\\`]/g, ''));
      utter.lang = 'ar-SA';
      utter.onstart = function () { setSecondBrainAIState('SPEAKING'); };
      utter.onend = function () { setSecondBrainAIState('IDLE'); };
      window.speechSynthesis.speak(utter);
    }

    function startVoiceInput(targetInputId, mode) {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRec) { showOutput(mode === 'wife_emergency' ? 'wifeAiResponseBox' : 'aiResponseBox', 'متصفحك الحالي لا يدعم الإدخال الصوتي.'); return; }
      playSciFiTone(440, 880, 0.12);
      setSecondBrainAIState('LISTENING');
      const rec = new SpeechRec();
      rec.lang = 'ar-SA';
      rec.onresult = function (ev) {
        document.getElementById(targetInputId).value = ev.results[0][0].transcript;
        askAssistant(mode);
      };
      rec.onerror = function () { setSecondBrainAIState('IDLE'); };
      rec.start();
    }

    async function addProject() {
      playSciFiTone(500, 1100, 0.12);
      const payload = {
        name: document.getElementById('projName').value.trim(),
        path: document.getElementById('projPath').value.trim(),
        descriptionAr: document.getElementById('projDesc').value.trim(),
        wifeSummaryAr: document.getElementById('projWifeDesc').value.trim(),
        monthlyIncome: document.getElementById('projIncome').value.trim(),
        billingNotes: document.getElementById('projBilling').value.trim()
      };
      if (!payload.name || !payload.path) return showOutput('projectsOutputBox', 'يرجى إدخال اسم المشروع ومساره.');
      try {
        const data = await api('/api/projects/add', { body: payload });
        showOutput('projectsOutputBox', data.messageAr + '\\n(حدّث الصفحة لرؤية المشروع في الرادار)');
      } catch (err) {
        showOutput('projectsOutputBox', '❌ ' + err.message);
      }
    }

    async function rescanProjects() {
      showOutput('projectsOutputBox', '⏳ جاري إعادة الفحص...');
      try {
        const data = await api('/api/projects/rescan', { body: {} });
        const lines = data.projects.map(function (p) { return '• ' + p.name + ': ملفات حساسة ' + p.critical + '، مؤمَّن منها ' + p.secured; });
        showOutput('projectsOutputBox', '✅ اكتمل الفحص وتحديث Obsidian.\\n' + lines.join('\\n') + (data.vaultUnlocked ? '' : '\\n(الخزنة مقفلة: افتحها ثم أعد الفحص لتأمين الملفات)'));
      } catch (err) {
        showOutput('projectsOutputBox', '❌ ' + err.message);
      }
    }

    async function harvestLogs() {
      playSciFiTone(580, 1180, 0.14);
      try {
        const data = await api('/api/memory/harvest', { body: {} });
        showOutput('projectsOutputBox', data.messageAr);
      } catch (err) {
        showOutput('projectsOutputBox', '❌ ' + err.message);
      }
    }

    refreshVaultStatus();
    loadBackupsList();
    setInterval(refreshVaultStatus, 30000);
  </script>
</body>
</html>`;
}
