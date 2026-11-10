/**
 * ============================================================================
 * الملف: src/features/dashboard-app/ui-renderer.ts
 * القسم: Features -> Dashboard App (ميزة عرض واجهة غرفة القيادة الهولوغرامية التفاعلية)
 * Hint بالعربي: يقوم هذا الملف بدمج أنماط الهولوغرام (hud-styles.ts) ومحرك النواة
 *               ثلاثية الأبعاد (hologram-core-script.ts) لبناء غرفة قيادة تفاعلية
 *               متحركة بسرعة 60 إطار/ثانية لوضع القائد ووضع العائلة.
 * ============================================================================
 */

import type { ProjectScanReport, SharedAIMemoryEntry, SystemBrandingConfig } from '../../shared/types.ts';
import { getSecondBrainHologramClientScript } from './hologram-core-script.ts';
import { getSecondBrainHolographicStyles } from './hud-styles.ts';

/**
 * Hint بالعربي: دالة بناء صفحة الواجهة الهولوغرامية التفاعلية الكاملة لبرنامج سطح المكتب
 * وتجمع بين النواة ثلاثية الأبعاد المتحركة والألواح التكتيكية الجانبية.
 */
export function renderSecondBrainDesktopHTML(
  config: SystemBrandingConfig,
  projectReports: ProjectScanReport[],
  memories: SharedAIMemoryEntry[]
): string {
  const totalCriticalFiles = projectReports.reduce((acc, r) => acc + r.criticalFilesFound.length, 0);

  const projectsHtml = projectReports
    .map(
      (p) => `
      <div class="holo-item-card" onmouseenter="playSciFiTone(880, 1020, 0.04)">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:var(--cyan-glow);font-size:14.5px;">🚀 ${p.projectName}</strong>
          <span style="font-size:11px;color:var(--amber-bright);font-family:monospace;">${p.detectedStack.join(' | ')}</span>
        </div>
        <div style="font-family:monospace;font-size:11.5px;color:var(--text-muted);margin:4px 0;direction:ltr;text-align:left;">
          📂 ${p.projectPath}
        </div>
        <div style="font-size:12.5px;margin-top:6px;">
          <span style="color:var(--emerald-glow);">▶️ التشغيل:</span> <code>${p.runCommands[0] ?? 'npm start'}</code>
          <br/>
          <span style="color:var(--amber-bright);">🔐 الملفات الحرجة المؤمنة:</span> <strong>(${p.criticalFilesFound.length}) ملف</strong>
        </div>
      </div>`
    )
    .join('\n');

  const wifeProjectsHtml = config.watchedProjects
    .map(
      (p) => `
      <div class="holo-item-card" style="border-right-color:var(--rose-glow);">
        <h3 style="margin:0 0 6px 0;color:#fda4af;">📱 مشروع: ${p.name}</h3>
        <p style="margin:4px 0;font-size:13.5px;"><strong>ما هو هذا المشروع؟</strong> ${p.wifeSummaryAr}</p>
        <p style="margin:4px 0;font-size:13.5px;"><strong>💰 الدخل المالي:</strong> ${p.monthlyIncome}</p>
        <p style="margin:4px 0;font-size:13.5px;"><strong>🧾 الفواتير المطلوبة للاستمرار:</strong> ${p.billingNotes}</p>
      </div>`
    )
    .join('\n');

  const memoriesHtml =
    memories.length > 0
      ? memories
          .slice(0, 6)
          .map(
            (m) => `
          <div class="holo-item-card" style="border-right-color:var(--amber-bright);">
            <div style="display:flex;justify-content:space-between;">
              <strong style="font-size:13px;color:#fff;">🧠 ${m.title}</strong>
              <span style="font-size:11px;color:var(--amber-bright);">${m.sourceAI}</span>
            </div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">${m.summaryAr}</div>
          </div>`
          )
          .join('\n')
      : '<p style="font-size:12.5px;color:var(--text-muted);">لا توجد سجلات ذاكرة بعد.</p>';

  const voiceBarsHtml = Array.from({ length: 28 })
    .map(() => `<div class="v-bar"></div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${config.appTitleAr}</title>
  <style>${getSecondBrainHolographicStyles()}</style>
</head>
<body>
  <!-- شريط القيادة الهولوغرامي العلوي -->
  <header class="hud-topbar">
    <div class="hud-brand">
      <div class="reactor-mini"></div>
      <div>
        <div class="brand-text">${config.appName} // HOLOGRAPHIC OS</div>
        <div style="font-size:11.5px;color:var(--text-muted);">${config.appTitleAr} • v${config.version}</div>
      </div>
    </div>

    <div class="telemetry-bar">
      <div class="telemetry-item">PROJECTS: <strong>${projectReports.length}</strong></div>
      <div class="telemetry-item">VAULT: <strong>AES-256-GCM</strong></div>
      <div class="telemetry-item">SECRETS GUARDED: <strong>${totalCriticalFiles}</strong></div>
      <div class="telemetry-item">AI MEMORY: <strong>${memories.length} LOGS</strong></div>
    </div>

    <div class="mode-switcher">
      <button id="btnSoundToggle" class="hud-tab-btn" onclick="toggleSoundFx()">🔊 المؤثرات: مفعلة</button>
      <button id="btnCmdMode" class="hud-tab-btn active-cmd" onclick="switchMode('commander')">⚡ غرفة قيادة القائد (${config.assistantName})</button>
      <button id="btnWifeMode" class="hud-tab-btn" onclick="switchMode('wife_emergency')">❤️ وضع العائلة والطوارئ (${config.familyMemberTitle})</button>
    </div>
  </header>

  <!-- ==================== 1. غرفة قيادة القائد الهولوغرامية الثلاثية ==================== -->
  <main id="commanderModeSection" class="cockpit-layout">
    <!-- الجناح الأيمن: رادار المشاريع + الذاكرة المشتركة -->
    <section>
      <div class="holo-panel">
        <div class="panel-title">
          <span>📡 رادار المشاريع والتشريح الحي</span>
          <span class="tag-amber">LIVE RADAR // ${projectReports.length}</span>
        </div>
        <div style="max-height:245px;overflow-y:auto;padding-left:4px;">
          ${projectsHtml}
        </div>
        <details style="margin-top:10px;border-top:1px solid rgba(0,240,255,0.15);padding-top:10px;">
          <summary style="cursor:pointer;color:var(--amber-bright);font-weight:700;font-size:13px;">➕ إضافة مشروع جديد للتشريح والتأمين التلقائي</summary>
          <div style="margin-top:10px;">
            <input id="projName" placeholder="اسم المشروع (مثال: My-Flutter-App)" />
            <input id="projPath" placeholder="المسار على الجهاز (مثال: D:\\Projects\\MyApp)" />
            <input id="projDesc" placeholder="وصف تقني للمشروع" />
            <input id="projWifeDesc" placeholder="شرح مبسط لزوجتك عن هذا المشروع" />
            <input id="projIncome" placeholder="الدخل الشهري للمشروع" />
            <input id="projBilling" placeholder="الفواتير وموعد تجديد السيرفر/الدومين" />
            <button class="holo-btn" onclick="addProject()">🔍 فحص وتأمين وتوثيق في Obsidian</button>
          </div>
        </details>
      </div>

      <div class="holo-panel">
        <div class="panel-title">
          <span>🧠 الذاكرة الموحدة (Antigravity & Claude)</span>
          <span class="tag-amber">MCP SYNC</span>
        </div>
        <button class="holo-btn holo-btn-amber" style="width:100%;margin-bottom:10px;" onclick="harvestLogs()">
          🔄 سحب وأرشفة محادثات Antigravity & Claude Code تلقائياً
        </button>
        <div style="max-height:210px;overflow-y:auto;padding-left:4px;">
          ${memoriesHtml}
        </div>
      </div>
    </section>

    <!-- المنصة الوسطى: نواة العقل الثاني ثلاثية الأبعاد المتفاعلة بالصوت والماوس -->
    <section class="core-stage">
      <div class="visual-mode-pills">
        <button class="pill-btn active" onclick="setVisualCoreMode('fusion', this)">🔥 الوضع المدمج الفائق (حلقات + كرة 3D)</button>
        <button class="pill-btn" onclick="setVisualCoreMode('cyan_wave', this)">🌊 الكرة الموجية السماوية 3D</button>
        <button class="pill-btn" onclick="setVisualCoreMode('neural_cloud', this)">⚪ السحابة النقطية العصبية 3D</button>
        <button class="pill-btn" onclick="setVisualCoreMode('hud_rings', this)">🎯 حلقات العقل الثاني الهولوغرامية</button>
      </div>

      <div class="canvas-wrapper" title="اضغط على النواة لإطلاق نبضة طاقة أو حرك الماوس للتفاعل ثلاثي الأبعاد!">
        <canvas id="secondBrainCoreCanvas"></canvas>
        <div id="coreOverlayStatus" class="core-overlay-status">SYSTEM ONLINE • 60FPS HOLOGRAM ACTIVE</div>
      </div>

      <div class="voice-bars">${voiceBarsHtml}</div>

      <!-- وحدة التخاطب الصوتي والنصي المباشر تحت النواة -->
      <div class="holo-panel" style="width:100%;max-width:620px;margin-top:4px;">
        <div class="panel-title">
          <span>🎙️ قناة الاتصال المباشر مع ${config.assistantNameAr}</span>
          <span class="tag-amber">VOICE & NEURAL AI</span>
        </div>
        <textarea id="aiQuestionInput" rows="2" placeholder="تحدث بالصوت أو اكتب أمرك لـ ${config.assistantNameAr} (مثال: ما هي حالة المشاريع والملفات الحساسة؟)..."></textarea>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          <button class="holo-btn" onclick="askAssistant('commander')">⚡ إرسال الأمر لـ ${config.assistantNameAr}</button>
          <button class="holo-btn holo-btn-amber" onclick="startVoiceInput('aiQuestionInput', 'commander')">🎤 تحدث بالمايكروفون</button>
          <button class="holo-btn" onclick="speakLastAnswer()">🔊 نطق الرد صوتياً</button>
        </div>
        <div id="aiResponseBox" class="terminal-output">بانتظار أوامرك أيها القائد... حرك الماوس فوق النواة أو اضغط عليها للتفاعل المباشر.</div>
      </div>
    </section>

    <!-- الجناح الأيسر: الخزنة العسكرية AES-256 + حقيبة الطوارئ العائلية -->
    <section>
      <div class="holo-panel">
        <div class="panel-title">
          <span>🔐 الخزنة العسكرية المزدوجة (AES-256)</span>
          <span class="tag-amber">ZERO-KNOWLEDGE</span>
        </div>
        <input id="vaultMasterPass" type="password" placeholder="كلمة المرور الرئيسية للقائد (Master Password)" />
        <input id="vaultEmergencyKey" placeholder="مفتاح طوارئ الزوجة (أو اتركه ليتم توليده تلقائياً)" />
        <input id="secretTitle" placeholder="عنوان الحساب (مثال: إيميل Google Play الرسمي)" />
        <input id="secretUser" placeholder="الإيميل أو اسم المستخدم" />
        <input id="secretVal" type="password" placeholder="كلمة المرور أو الكود السري" />
        <input id="secretWifeNote" placeholder="شرح مبسط لزوجتك حول هذا الحساب" />
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          <button class="holo-btn" onclick="saveSecret()">🔒 تشفير وحفظ بالخزنة</button>
          <button class="holo-btn holo-btn-amber" onclick="unlockVaultUI('vaultMasterPass', 'vaultOutputBox')">🔓 فتح الخزنة</button>
        </div>
        <div id="vaultOutputBox" class="terminal-output">الخزنة مقفلة ومؤمنة بتشفير عسكري AES-256-GCM.</div>
      </div>

      <div class="holo-panel">
        <div class="panel-title">
          <span>🛡️ بروتوكول الطوارئ والنسخ المشفر</span>
          <span class="tag-amber">FAMILY LEGACY</span>
        </div>
        <p style="font-size:12.5px;color:var(--text-muted);margin-top:0;">
          يولّد وثيقة الطوارئ القابلة للطباعة لزوجتك مع مفتاح فك التشفير + نسخة احتياطية مشفرة لكامل النظام وملفات Obsidian:
        </p>
        <button class="holo-btn holo-btn-amber" style="width:100%;" onclick="generateEmergencyKitUI()">
          🖨️ توليد كتيب الطوارئ المطبوع + نسخة احتياطية مشفرة
        </button>
      </div>
    </section>
  </main>

  <!-- ==================== 2. واجهة وضع العائلة والطوارئ للزوجة (Wife Mode) ==================== -->
  <section id="wifeModeSection" style="display:none;max-width:1220px;margin:24px auto;padding:0 20px;">
    <div class="holo-panel" style="border-color:var(--rose-glow);background:linear-gradient(135deg, rgba(40,10,35,0.85), rgba(10,20,42,0.9));">
      <h1 style="margin:0 0 8px 0;color:#fda4af;">❤️ أهلاً بكِ يا ${config.familyMemberTitle} في بوابة الإدارة العائلية الآمنة</h1>
      <p style="margin:0;font-size:16px;color:#fce7f3;">
        صمّم زوجكِ هذا النظام الذكي ليكون مستشاركِ الأمين ويشرح لكِ كل مشروع، فواتيره، وإيميلاته خطوة بخطوة بدون أي تعقيد تقني.
      </p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;">
      <div class="holo-panel">
        <div class="panel-title">
          <span style="color:#fda4af;">🔑 الخطوة 1: فتح خزنة الإيميلات والباسووردات بمفتاح الطوارئ</span>
          <span class="tag-amber">FAMILY KEY</span>
        </div>
        <p style="font-size:13.5px;">أدخلي <strong>مفتاح الطوارئ العائلي</strong> المكتوب في وثيقة الطوارئ المطبوعة لديكِ:</p>
        <input id="wifeEmergencyInput" placeholder="أدخلي مفتاح الطوارئ هنا (SB-XXXX-...)" />
        <button class="holo-btn holo-btn-amber" onclick="unlockVaultUI('wifeEmergencyInput', 'wifeVaultResults')">
          🔓 فتح وعرض جميع الإيميلات وكلمات المرور
        </button>
        <div id="wifeVaultResults" class="terminal-output">أدخلي مفتاح الطوارئ بالأعلى لعرض جميع الحسابات السرية...</div>

        <div class="panel-title" style="margin-top:20px;">
          <span style="color:var(--cyan-glow);">📊 الخطوة 2: قائمة المشاريع والدخل والفواتير</span>
        </div>
        ${wifeProjectsHtml}
      </div>

      <div class="holo-panel">
        <div class="panel-title">
          <span style="color:var(--amber-bright);">🎙️ المساعد الشخصي الناطق لخدمتكِ (${config.assistantNameAr})</span>
          <span class="tag-amber">FAMILY ADVISOR</span>
        </div>
        <p style="font-size:13.5px;">اسألي المساعد الذكي بالكتابة أو بالصوت عن أي شيء (مثلاً: <em>"ما هي الفواتير المهمة؟"</em> أو <em>"كيف أتعامل مع المبرمجين بأمان؟"</em>):</p>
        <textarea id="wifeQuestionInput" rows="3" placeholder="اكتبي سؤالكِ هنا بكل بساطة..."></textarea>
        <div>
          <button class="holo-btn holo-btn-amber" onclick="askAssistant('wife_emergency')">💬 اسألي المساعد الذكي</button>
          <button class="holo-btn" onclick="startVoiceInput('wifeQuestionInput', 'wife_emergency')">🎤 تحدثي بالصوت</button>
          <button class="holo-btn" onclick="speakLastAnswer()">🔊 استمعي للإجابة صوتياً</button>
        </div>
        <div id="wifeAiResponseBox" class="terminal-output" style="min-height:180px;">
          مرحباً بكِ يا ${config.familyMemberTitle}، أنا (${config.assistantNameAr}) جاهز لإرشادكِ في أي وقت...
        </div>
      </div>
    </div>
  </section>

  <script>
    ${getSecondBrainHologramClientScript()}

    let lastSpokenText = '';

    function switchMode(mode) {
      playSciFiTone(540, 1080, 0.12, 'triangle');
      const cmdSec = document.getElementById('commanderModeSection');
      const wifeSec = document.getElementById('wifeModeSection');
      const btnCmd = document.getElementById('btnCmdMode');
      const btnWife = document.getElementById('btnWifeMode');
      if (mode === 'wife_emergency') {
        cmdSec.style.display = 'none';
        wifeSec.style.display = 'block';
        btnCmd.className = 'hud-tab-btn';
        btnWife.className = 'hud-tab-btn active-wife';
      } else {
        cmdSec.style.display = 'grid';
        wifeSec.style.display = 'none';
        btnCmd.className = 'hud-tab-btn active-cmd';
        btnWife.className = 'hud-tab-btn';
      }
    }

    async function askAssistant(mode) {
      playSciFiTone(620, 1240, 0.1);
      setSecondBrainAIState('THINKING');
      energyPulse = 1.1;

      const inputId = mode === 'wife_emergency' ? 'wifeQuestionInput' : 'aiQuestionInput';
      const boxId = mode === 'wife_emergency' ? 'wifeAiResponseBox' : 'aiResponseBox';
      const question = document.getElementById(inputId).value.trim() || 'اعطني ملخصاً شاملاً';
      const box = document.getElementById(boxId);
      box.textContent = '⏳ جاري تحليل النواة المعرفية والذاكرة المشتركة...';

      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode })
      });
      const data = await res.json();
      box.textContent = data.answerAr || data.error;
      lastSpokenText = box.textContent;
      setSecondBrainAIState('SPEAKING');
      speakLastAnswer();
      setTimeout(() => setSecondBrainAIState('IDLE'), 3200);
    }

    function speakLastAnswer() {
      if (!lastSpokenText || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(lastSpokenText.replace(/[*#_\\\`]/g, ''));
      utter.lang = 'ar-SA';
      utter.onstart = () => setSecondBrainAIState('SPEAKING');
      utter.onend = () => setSecondBrainAIState('IDLE');
      window.speechSynthesis.speak(utter);
    }

    function startVoiceInput(targetInputId, mode) {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRec) {
        alert('متصفحك الحالي لا يدعم الإدخال الصوتي المباشر.');
        return;
      }
      playSciFiTone(440, 880, 0.12);
      setSecondBrainAIState('LISTENING');
      const rec = new SpeechRec();
      rec.lang = 'ar-SA';
      rec.onresult = (e) => {
        document.getElementById(targetInputId).value = e.results[0][0].transcript;
        askAssistant(mode);
      };
      rec.onerror = () => setSecondBrainAIState('IDLE');
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
      if (!payload.name || !payload.path) return alert('يرجى إدخال اسم المشروع ومساره!');
      const res = await fetch('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      alert(data.messageAr || 'تم فحص وإضافة المشروع بنجاح!');
      location.reload();
    }

    async function harvestLogs() {
      playSciFiTone(580, 1180, 0.14);
      const res = await fetch('/api/memory/harvest', { method: 'POST' });
      const data = await res.json();
      alert(data.messageAr);
      location.reload();
    }

    async function saveSecret() {
      playSciFiTone(480, 980, 0.12);
      const payload = {
        masterPassword: document.getElementById('vaultMasterPass').value,
        emergencyRecoveryKey: document.getElementById('vaultEmergencyKey').value,
        title: document.getElementById('secretTitle').value,
        usernameOrEmail: document.getElementById('secretUser').value,
        secretValue: document.getElementById('secretVal').value,
        notesForWifeAr: document.getElementById('secretWifeNote').value
      };
      if (!payload.masterPassword || !payload.title || !payload.secretValue) {
        return alert('يرجى إدخال كلمة المرور الرئيسية وعنوان الحساب والقيمة السرية!');
      }
      const res = await fetch('/api/vault/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      document.getElementById('vaultEmergencyKey').value = data.emergencyRecoveryKey || '';
      document.getElementById('vaultOutputBox').textContent = data.messageAr;
    }

    async function unlockVaultUI(inputId, outputBoxId) {
      playSciFiTone(400, 1200, 0.16);
      const key = document.getElementById(inputId).value.trim();
      if (!key) return alert('يرجى إدخال كلمة المرور أو مفتاح الطوارئ أولاً!');
      const res = await fetch('/api/vault/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      const box = document.getElementById(outputBoxId);
      box.textContent = data.error ? '❌ ' + data.error : data.formattedText;
    }

    async function generateEmergencyKitUI() {
      playSciFiTone(520, 1320, 0.18);
      const masterPassword = document.getElementById('vaultMasterPass').value.trim() || 'SECOND-BRAIN-DEFAULT-MASTER';
      const emergencyKey = document.getElementById('vaultEmergencyKey').value.trim();
      const res = await fetch('/api/emergency/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterPassword, emergencyKey })
      });
      const data = await res.json();
      document.getElementById('vaultOutputBox').textContent = data.messageAr;
      if (data.emergencyKey) document.getElementById('vaultEmergencyKey').value = data.emergencyKey;
    }
  </script>
</body>
</html>`;
}
