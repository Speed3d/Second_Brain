/**
 * ============================================================================
 * الملف: src/features/dashboard-app/hud-styles.ts
 * القسم: Features -> Dashboard App (أنماط وتصميم غرفة القيادة الهولوغرامية)
 * Hint بالعربي: يوفر هذا الملف تصميم CSS السينمائي المتقدم المستوحى من شاشات
 *               أفلام الخيال العلمي (زوايا مقطوعة، توهج سماوي وبرتقالي ناري،
 *               شبكة هولوغرامية متحركة، وحركات تفاعلية ناعمة).
 * ============================================================================
 */

/**
 * Hint بالعربي: دالة إرجاع كود التصميم الهولوغرامي المتقدم (CSS3 Animations & Sci-Fi HUD Layout)
 * لواجهة القائد وواجهة العائلة الذكية.
 */
export function getSecondBrainHolographicStyles(): string {
  return `
    :root {
      --void-black: #02050a;
      --panel-glass: rgba(6, 16, 32, 0.72);
      --cyan-glow: #00f0ff;
      --cyan-dim: rgba(0, 240, 255, 0.22);
      --amber-glow: #ff6a00;
      --amber-bright: #ffaa00;
      --amber-dim: rgba(255, 106, 0, 0.28);
      --emerald-glow: #00ff9d;
      --rose-glow: #ff3877;
      --text-bright: #e8f8ff;
      --text-muted: #7da2c1;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      background-color: var(--void-black);
      background-image:
        radial-gradient(circle at 50% 42%, rgba(0, 240, 255, 0.09) 0%, rgba(255, 106, 0, 0.04) 32%, transparent 70%),
        linear-gradient(rgba(0, 240, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 240, 255, 0.03) 1px, transparent 1px);
      background-size: 100% 100%, 44px 44px, 44px 44px;
      color: var(--text-bright);
      font-family: 'Segoe UI', 'Cairo', Tahoma, sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* شريط القيادة العلوي المستقبلي */
    .hud-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 28px;
      background: linear-gradient(90deg, rgba(2,8,18,0.95) 0%, rgba(8,24,48,0.85) 50%, rgba(2,8,18,0.95) 100%);
      border-bottom: 1px solid var(--cyan-dim);
      box-shadow: 0 4px 30px rgba(0, 240, 255, 0.12);
      position: sticky;
      top: 0;
      z-index: 200;
      backdrop-filter: blur(12px);
    }

    .hud-brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .reactor-mini {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 2px dashed var(--cyan-glow);
      box-shadow: 0 0 14px var(--cyan-glow), inset 0 0 10px var(--amber-glow);
      animation: spinSlow 10s linear infinite;
    }

    .brand-text {
      font-size: 20px;
      font-weight: 900;
      letter-spacing: 1px;
      background: linear-gradient(90deg, var(--cyan-glow), #ffffff, var(--amber-bright));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: 0 0 20px rgba(0, 240, 255, 0.35);
    }

    .telemetry-bar {
      display: flex;
      gap: 18px;
      font-family: 'Consolas', monospace;
      font-size: 12px;
      color: var(--cyan-glow);
    }

    .telemetry-item {
      padding: 4px 10px;
      border: 1px solid var(--cyan-dim);
      border-radius: 4px;
      background: rgba(0, 240, 255, 0.05);
    }

    .mode-switcher {
      display: flex;
      gap: 10px;
    }

    .hud-tab-btn {
      padding: 9px 18px;
      background: rgba(5, 15, 30, 0.85);
      border: 1px solid var(--cyan-dim);
      color: var(--text-bright);
      font-weight: 700;
      cursor: pointer;
      clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
      transition: all 0.25s ease;
    }

    .hud-tab-btn:hover {
      border-color: var(--cyan-glow);
      box-shadow: 0 0 16px rgba(0, 240, 255, 0.35);
      transform: translateY(-1px);
    }

    .hud-tab-btn.active-cmd {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.28), rgba(255, 106, 0, 0.22));
      border-color: var(--cyan-glow);
      color: #fff;
      box-shadow: 0 0 22px rgba(0, 240, 255, 0.45);
    }

    .hud-tab-btn.active-wife {
      background: linear-gradient(135deg, rgba(255, 56, 119, 0.35), rgba(255, 170, 0, 0.25));
      border-color: var(--rose-glow);
      color: #fff;
      box-shadow: 0 0 22px rgba(255, 56, 119, 0.5);
    }

    /* تخطيط غرفة القيادة الثلاثي (جناح أيمن + النواة المتحركة في المنتصف + جناح أيسر) */
    .cockpit-layout {
      display: grid;
      grid-template-columns: 390px 1fr 390px;
      gap: 20px;
      max-width: 1680px;
      margin: 16px auto;
      padding: 0 20px;
      align-items: start;
    }

    @media (max-width: 1320px) {
      .cockpit-layout {
        grid-template-columns: 1fr;
      }
    }

    /* الألواح الهولوغرامية المقطوعة الزوايا */
    .holo-panel {
      position: relative;
      background: var(--panel-glass);
      border: 1px solid var(--cyan-dim);
      padding: 18px;
      margin-bottom: 18px;
      backdrop-filter: blur(14px);
      clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
      box-shadow: 0 10px 35px rgba(0, 0, 0, 0.65), inset 0 0 22px rgba(0, 240, 255, 0.05);
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }

    .holo-panel:hover {
      border-color: rgba(0, 240, 255, 0.55);
      box-shadow: 0 10px 40px rgba(0, 240, 255, 0.14), inset 0 0 25px rgba(0, 240, 255, 0.08);
    }

    .holo-panel::before {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      width: 65px;
      height: 3px;
      background: linear-gradient(90deg, transparent, var(--amber-glow), var(--cyan-glow));
    }

    .panel-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 0 0 14px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(0, 240, 255, 0.18);
      font-size: 15.5px;
      font-weight: 800;
      color: var(--cyan-glow);
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }

    .panel-title .tag-amber {
      font-family: monospace;
      font-size: 11px;
      color: var(--amber-bright);
      background: rgba(255, 106, 0, 0.15);
      border: 1px solid var(--amber-dim);
      padding: 2px 8px;
      border-radius: 4px;
    }

    /* منصة النواة ثلاثية الأبعاد في منتصف الشاشة */
    .core-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 10px;
    }

    .canvas-wrapper {
      position: relative;
      width: 520px;
      height: 520px;
      max-width: 92vw;
      max-height: 92vw;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    #secondBrainCoreCanvas {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      filter: drop-shadow(0 0 28px rgba(0, 240, 255, 0.25));
    }

    .core-overlay-status {
      position: absolute;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      font-family: 'Consolas', monospace;
      font-size: 12px;
      letter-spacing: 2px;
      color: var(--amber-bright);
      background: rgba(2, 6, 14, 0.82);
      border: 1px solid var(--amber-dim);
      padding: 5px 16px;
      border-radius: 20px;
      pointer-events: none;
      text-shadow: 0 0 8px var(--amber-glow);
    }

    .visual-mode-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin: 8px 0 16px 0;
    }

    .pill-btn {
      background: rgba(4, 14, 28, 0.85);
      border: 1px solid var(--cyan-dim);
      color: var(--text-muted);
      padding: 6px 13px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: 0.2s;
    }

    .pill-btn.active, .pill-btn:hover {
      color: #fff;
      border-color: var(--amber-bright);
      background: linear-gradient(90deg, rgba(0, 240, 255, 0.2), rgba(255, 106, 0, 0.25));
      box-shadow: 0 0 12px rgba(255, 106, 0, 0.35);
    }

    /* موجات الصوت الحية */
    .voice-bars {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 26px;
      margin-bottom: 10px;
    }

    .v-bar {
      width: 4px;
      height: 6px;
      background: var(--cyan-glow);
      border-radius: 2px;
      transition: height 0.08s ease, background 0.2s ease;
    }

    /* بطاقات المشاريع والذاكرة */
    .holo-item-card {
      background: rgba(3, 10, 22, 0.78);
      border: 1px solid rgba(0, 240, 255, 0.16);
      border-right: 3px solid var(--cyan-glow);
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 10px;
      transition: 0.2s;
    }

    .holo-item-card:hover {
      border-right-color: var(--amber-bright);
      background: rgba(8, 22, 44, 0.9);
      transform: translateX(-3px);
    }

    .holo-btn {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(0, 160, 255, 0.35));
      border: 1px solid var(--cyan-glow);
      color: #fff;
      padding: 9px 15px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
      transition: 0.2s;
      margin-left: 6px;
      margin-bottom: 6px;
    }

    .holo-btn:hover {
      background: var(--cyan-glow);
      color: #020813;
      box-shadow: 0 0 18px var(--cyan-glow);
    }

    .holo-btn-amber {
      background: linear-gradient(135deg, rgba(255, 106, 0, 0.25), rgba(255, 170, 0, 0.35));
      border-color: var(--amber-bright);
    }

    .holo-btn-amber:hover {
      background: var(--amber-bright);
      color: #090400;
      box-shadow: 0 0 18px var(--amber-glow);
    }

    input, textarea {
      width: 100%;
      background: rgba(2, 8, 18, 0.85);
      border: 1px solid rgba(0, 240, 255, 0.25);
      color: var(--text-bright);
      padding: 9px 12px;
      border-radius: 6px;
      margin-bottom: 8px;
      font-family: inherit;
      font-size: 13px;
    }

    input:focus, textarea:focus {
      outline: none;
      border-color: var(--amber-bright);
      box-shadow: 0 0 12px rgba(255, 170, 0, 0.25);
    }

    .terminal-output {
      background: rgba(1, 5, 12, 0.92);
      border: 1px solid rgba(0, 240, 255, 0.3);
      border-right: 3px solid var(--amber-bright);
      padding: 12px;
      font-size: 13.5px;
      line-height: 1.7;
      white-space: pre-wrap;
      max-height: 220px;
      overflow-y: auto;
      border-radius: 6px;
      margin-top: 8px;
    }

    @keyframes spinSlow {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
}
