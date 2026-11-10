/**
 * ============================================================================
 * الملف: src/features/dashboard-app/hologram-core-script.ts
 * القسم: Features -> Dashboard App (محرك الرسوميات المتحركة ثلاثية الأبعاد والصوت التفاعلي)
 * Hint بالعربي: يولّد هذا الملف محرك Canvas ثلاثي الأبعاد بسرعة 60 إطار/ثانية
 *               يحاكي الصور الثلاث التي اختارها القائد بدقة:
 *               1) حلقات العقل الثاني الهولوغرامية البرتقالية والسماوية الدوارة (صورة 1).
 *               2) السحابة النقطية العصبية البيضاء ثلاثية الأبعاد (صورة 2).
 *               3) الكرة الموجية السماوية النابضة بالحياة والصوت (صورة 3).
 *               4) وضع الدمج الفائق (Fusion Mode) الذي يجمع الحلقات والكرة الموجية معاً!
 * ============================================================================
 */

/**
 * Hint بالعربي: دالة إرجاع السكربت التفاعلي المسؤول عن تحريك النواة ثلاثية الأبعاد،
 * المؤثرات الصوتية الخيالية (Sci-Fi Sound FX)، والتفاعل مع الماوس وصوت المساعد الذكي.
 */
export function getSecondBrainHologramClientScript(): string {
  return `
    // ==================== محرك المؤثرات الصوتية المستقبلية (Web Audio Sci-Fi Synth) ====================
    let soundFxEnabled = true;
    let audioCtx = null;

    function playSciFiTone(freqStart = 680, freqEnd = 1120, duration = 0.08, type = 'sine') {
      if (!soundFxEnabled) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freqStart, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(freqEnd, audioCtx.currentTime + duration);
        gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch (e) {}
    }

    function toggleSoundFx() {
      soundFxEnabled = !soundFxEnabled;
      const btn = document.getElementById('btnSoundToggle');
      if (btn) btn.textContent = soundFxEnabled ? '🔊 المؤثرات: مفعلة' : '🔇 المؤثرات: صامت';
      if (soundFxEnabled) playSciFiTone(520, 960, 0.12);
    }

    // ==================== محرك النواة الهولوغرامية ثلاثية الأبعاد (60FPS 3D Engine) ====================
    const canvas = document.getElementById('secondBrainCoreCanvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 560 * dpr;
    canvas.height = 560 * dpr;
    ctx.scale(dpr, dpr);

    const W = 560;
    const H = 560;
    const CX = W / 2;
    const CY = H / 2;

    // الأوضاع البصرية الأربعة المستوحاة من صور القائد:
    // 'fusion' | 'cyan_wave' | 'neural_cloud' | 'hud_rings'
    let visualCoreMode = 'fusion';
    let aiState = 'IDLE'; // 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING'
    let energyPulse = 0;
    let mouseX = 0;
    let mouseY = 0;
    let time = 0;

    // توليد 1850 نقطة ثلاثية الأبعاد موزعة هندسياً بطريقة فيبوناتشي على سطح الكرة
    const PARTICLE_COUNT = 1850;
    const basePoints = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = goldenAngle * i;
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;
      basePoints.push({ x, y, z, idx: i });
    }

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      mouseY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    });

    canvas.addEventListener('mouseleave', () => {
      mouseX = 0;
      mouseY = 0;
    });

    canvas.addEventListener('click', () => {
      energyPulse = 1.3;
      playSciFiTone(320, 1280, 0.22, 'triangle');
      const statusEl = document.getElementById('coreOverlayStatus');
      if (statusEl) statusEl.textContent = '⚡ QUANTUM CORE PULSE ACTIVATED';
      setTimeout(() => {
        if (statusEl && aiState === 'IDLE') statusEl.textContent = 'SYSTEM ONLINE • 60FPS HOLOGRAM ACTIVE';
      }, 1600);
    });

    function setVisualCoreMode(mode, btnEl) {
      visualCoreMode = mode;
      playSciFiTone(740, 1180, 0.1);
      document.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
      if (btnEl) btnEl.classList.add('active');
    }

    function setSecondBrainAIState(state) {
      aiState = state;
      const statusEl = document.getElementById('coreOverlayStatus');
      if (!statusEl) return;
      if (state === 'LISTENING') statusEl.textContent = '🎤 LISTENING TO COMMANDER VOICE...';
      else if (state === 'THINKING') statusEl.textContent = '🧠 ANALYZING NEURAL MEMORY & VAULT...';
      else if (state === 'SPEAKING') statusEl.textContent = '🔊 Second Brain VOICE TRANSMISSION...';
      else statusEl.textContent = 'SYSTEM ONLINE • 60FPS HOLOGRAM ACTIVE';
    }

    // دالة رسم الحلقات الهولوغرامية الدوارة (مطابقة للصورة 1: برتقالي ناري + سماوي متوهج)
    function drawHudRings(t, boost) {
      ctx.save();
      ctx.translate(CX, CY);

      // توهج خلفي مزدوج (سماوي في المركز + برتقالي في الأطراف)
      const bgGrad = ctx.createRadialGradient(0, 0, 20, 0, 0, 265);
      bgGrad.addColorStop(0, 'rgba(0, 240, 255, 0.18)');
      bgGrad.addColorStop(0.55, 'rgba(0, 180, 255, 0.06)');
      bgGrad.addColorStop(0.82, 'rgba(255, 106, 0, 0.10)');
      bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bgGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 265, 0, Math.PI * 2);
      ctx.fill();

      // الحلقة الخارجية البرتقالية المتقطعة (تتحرك عكس عقارب الساعة)
      ctx.save();
      ctx.rotate(-t * 0.25);
      ctx.strokeStyle = 'rgba(255, 115, 0, 0.78)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 72; i++) {
        const angle = (i / 72) * Math.PI * 2;
        const len = i % 6 === 0 ? 14 : 6;
        const r1 = 238;
        const r2 = r1 + len;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
        ctx.lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2);
        ctx.stroke();
      }
      ctx.restore();

      // أقواس الطاقة البرتقالية المتوهجة (الصورة 1)
      ctx.save();
      ctx.rotate(t * 0.42);
      ctx.strokeStyle = '#ff7b00';
      ctx.shadowColor = '#ff6a00';
      ctx.shadowBlur = 16;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 224, -0.4, 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 224, Math.PI - 0.6, Math.PI + 0.7);
      ctx.stroke();
      ctx.restore();

      // الحلقة السماوية التكتيكية الرئيسية
      ctx.save();
      ctx.rotate(-t * 0.6);
      ctx.strokeStyle = '#00f0ff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 14;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([45, 18, 12, 18]);
      ctx.beginPath();
      ctx.arc(0, 0, 198, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // حلقة المؤشرات الدقيقة الداخلية
      ctx.save();
      ctx.rotate(t * 0.85);
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 48; i++) {
        if (i % 4 === 0) continue;
        const a = (i / 48) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 172, Math.sin(a) * 172);
        ctx.lineTo(Math.cos(a) * 180, Math.sin(a) * 180);
        ctx.stroke();
      }
      ctx.restore();

      // خطوط القياس الهولوغرامية الجانبية (Telemetry Callouts كما في الصورة 1)
      ctx.strokeStyle = 'rgba(255, 136, 0, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(195, -75);
      ctx.lineTo(255, -75);
      ctx.moveTo(-195, 65);
      ctx.lineTo(-255, 65);
      ctx.stroke();

      ctx.fillStyle = '#ffaa00';
      ctx.font = '10px Consolas, monospace';
      ctx.fillText('SYS.CORE // 0x9F4A', 198, -81);
      ctx.fillStyle = '#00f0ff';
      ctx.fillText('AES.256 // LOCKED', -254, 59);

      ctx.restore();
    }

    // دالة رسم الكرة النقطية الموجية ثلاثية الأبعاد (مطابقة للصورة 2 والصورة 3)
    function draw3DParticleWaveSphere(t, radiusBase, colorScheme, boost) {
      const rotY = t * 0.55 + mouseX * 0.85;
      const rotX = Math.sin(t * 0.35) * 0.35 + mouseY * 0.85;
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      const waveAmp = (aiState === 'SPEAKING' || aiState === 'LISTENING' ? 0.24 : 0.13) + boost * 0.18;
      const waveFreq = aiState === 'SPEAKING' ? 6.5 : 4.5;

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = basePoints[i];

        // تموج عضوي ثلاثي الأبعاد على سطح الكرة (مطابق للتموجات في الصورة 3 والصورة 2)
        const wave1 = Math.sin(p.x * waveFreq + t * 2.6) * Math.cos(p.y * waveFreq - t * 2.1);
        const wave2 = Math.sin(p.z * (waveFreq + 2) + t * 3.2) * 0.5;
        const displacement = 1 + (wave1 + wave2) * waveAmp;

        const wx = p.x * displacement;
        const wy = p.y * displacement;
        const wz = p.z * displacement;

        // تدوير ثلاثي الأبعاد
        const x1 = wx * cosY - wz * sinY;
        const z1 = wz * cosY + wx * sinY;
        const y2 = wy * cosX - z1 * sinX;
        const z2 = z1 * cosX + wy * sinX;

        // إسقاط منظوري (Perspective Projection)
        const perspective = 3.2 / (3.2 - z2);
        const sx = CX + x1 * radiusBase * perspective;
        const sy = CY + y2 * radiusBase * perspective;

        const depthAlpha = Math.max(0.12, Math.min(1, (z2 + 1.3) / 2.2));
        const dotSize = Math.max(0.9, (1.55 + (wave1 + 0.5) * 0.9) * perspective * 0.72);

        ctx.beginPath();
        ctx.arc(sx, sy, dotSize, 0, Math.PI * 2);

        if (colorScheme === 'neural_white') {
          // الصورة 2: السحابة النقطية البيضاء/الفضية
          ctx.fillStyle = \`rgba(235, 245, 255, \${depthAlpha * 0.88})\`;
        } else {
          // الصورة 3: الكرة الموجية السماوية المتوهجة مع لمسات برتقالية عند التحدث
          if (aiState === 'SPEAKING' && wave1 > 0.38) {
            ctx.fillStyle = \`rgba(255, 170, 0, \${depthAlpha})\`;
          } else {
            const g = Math.floor(215 + wave1 * 40);
            ctx.fillStyle = \`rgba(0, \${g}, 255, \${depthAlpha * 0.92})\`;
          }
        }
        ctx.fill();
      }
    }

    // تحديث أشرطة الصوت التفاعلية أسفل الكرة
    function updateVoiceVisualizerBars(t) {
      const bars = document.querySelectorAll('.v-bar');
      if (!bars.length) return;
      const isActive = aiState === 'SPEAKING' || aiState === 'LISTENING' || energyPulse > 0.1;
      bars.forEach((bar, idx) => {
        if (isActive) {
          const h = 6 + Math.abs(Math.sin(t * 9 + idx * 0.7)) * 22;
          bar.style.height = h + 'px';
          bar.style.background = idx % 3 === 0 ? '#ffaa00' : '#00f0ff';
        } else {
          const h = 4 + Math.abs(Math.sin(t * 2 + idx * 0.4)) * 5;
          bar.style.height = h + 'px';
          bar.style.background = 'rgba(0, 240, 255, 0.45)';
        }
      });
    }

    function animateHologramLoop() {
      const speed = aiState === 'SPEAKING' || aiState === 'THINKING' ? 0.032 : 0.014;
      time += speed;
      energyPulse *= 0.93;

      ctx.clearRect(0, 0, W, H);

      if (visualCoreMode === 'fusion') {
        drawHudRings(time, energyPulse);
        draw3DParticleWaveSphere(time, 122, 'cyan_bio', energyPulse);
      } else if (visualCoreMode === 'cyan_wave') {
        draw3DParticleWaveSphere(time, 168, 'cyan_bio', energyPulse);
      } else if (visualCoreMode === 'neural_cloud') {
        draw3DParticleWaveSphere(time, 168, 'neural_white', energyPulse);
      } else if (visualCoreMode === 'hud_rings') {
        drawHudRings(time, energyPulse);
        draw3DParticleWaveSphere(time, 68, 'cyan_bio', energyPulse);
      }

      updateVoiceVisualizerBars(time);
      requestAnimationFrame(animateHologramLoop);
    }

    requestAnimationFrame(animateHologramLoop);
  `;
}
