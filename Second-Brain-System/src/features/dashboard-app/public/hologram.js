/* ============================================================================
 * الملف: src/features/dashboard-app/public/hologram.js
 * Hint بالعربي: النواة المتحركة: كرة موجية واحدة هادئة وبطيئة، تتفاعل مع المساعد:
 *               - SBHologram.feed(n): نبضة متناسبة مع طول كل جزء من الرد أثناء بثّه.
 *               - SBHologram.setState: هادئ / يستمع / يفكر / يجيب.
 *               - SBHologram.pulse: نبضة قصيرة (عند الضغط أو مع كل كلمة أثناء النطق).
 *               الأداء: يتوقف الرسم عند إخفاء التبويب أو مغادرة قسم القيادة، ويرسم إطاراً ثابتاً مع
 *               "تقليل الحركة"، ويقلل النقاط على الأجهزة الأضعف، ويرسم فوراً بعد تغيير الحجم.
 * ============================================================================ */
'use strict';

(function () {
  const canvas = document.getElementById('coreCanvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('coreStatus');
  const barsBox = document.getElementById('voiceBars');

  const LOGICAL = 560; // الرسم في مساحة منطقية 560×560 ثم يُكبّر/يُصغّر لحجم العنصر
  const C = LOGICAL / 2;
  const RADIUS = 175;
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const weakDevice = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const PARTICLES = weakDevice ? 900 : 1600;

  // سرعات هادئة (نحو نصف السرعة السابقة)
  const SPEED_IDLE = 0.007;
  const SPEED_ACTIVE = 0.015;

  let aiState = 'IDLE';
  let energy = 0; // طاقة لحظية تأتي من الرد ومن النبضات، وتتلاشى تدريجياً
  let mouseX = 0;
  let mouseY = 0;
  let time = 0;
  let visible = true;
  let rafId = 0;
  let soundOn = false;
  let audioCtx = null;

  const points = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < PARTICLES; i++) {
    const y = 1 - (i / (PARTICLES - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    points.push({ x: Math.cos(golden * i) * r, y: y, z: Math.sin(golden * i) * r });
  }

  const bars = [];
  if (barsBox) {
    for (let i = 0; i < 28; i++) {
      const s = document.createElement('span');
      barsBox.appendChild(s);
      bars.push(s);
    }
  }

  const STATUS = { IDLE: 'جاهز', LISTENING: '🎤 أستمع…', THINKING: '🧠 أفكر…', SPEAKING: '🔊 أجيب…' };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.max(1, Math.round(rect.width * dpr));
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const scale = size / LOGICAL;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawFrame(); // تغيير الحجم يمسح اللوحة؛ نرسم فوراً
  }

  function drawGlow() {
    const g = ctx.createRadialGradient(C, C, 10, C, C, 260);
    g.addColorStop(0, 'rgba(0, 229, 255, ' + (0.1 + energy * 0.08).toFixed(3) + ')');
    g.addColorStop(0.6, 'rgba(0, 160, 255, 0.04)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LOGICAL, LOGICAL);
  }

  function drawWaveSphere(t) {
    const rotY = t * 0.5 + mouseX * 0.6;
    const rotX = Math.sin(t * 0.3) * 0.3 + mouseY * 0.6;
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX);
    const sinX = Math.sin(rotX);
    const active = aiState === 'SPEAKING' || aiState === 'LISTENING';
    // ارتفاع الموجة يعتمد على الحالة وعلى الطاقة القادمة من الرد
    const amp = (active ? 0.16 : 0.09) + Math.min(energy, 1.4) * 0.14;
    const freq = 4 + Math.min(energy, 1.4) * 2;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const w1 = Math.sin(p.x * freq + t * 2.2) * Math.cos(p.y * freq - t * 1.7);
      const w2 = Math.sin(p.z * (freq + 2) + t * 2.6) * 0.5;
      const d = 1 + (w1 + w2) * amp;
      const wx = p.x * d;
      const wy = p.y * d;
      const wz = p.z * d;
      const x1 = wx * cosY - wz * sinY;
      const z1 = wz * cosY + wx * sinY;
      const y2 = wy * cosX - z1 * sinX;
      const z2 = z1 * cosX + wy * sinX;
      const persp = 3.2 / (3.2 - z2);
      const sx = C + x1 * RADIUS * persp;
      const sy = C + y2 * RADIUS * persp;
      const alpha = Math.max(0.12, Math.min(1, (z2 + 1.3) / 2.2));
      const size = Math.max(0.9, (1.4 + (w1 + 0.5) * 0.8) * persp * 0.7);
      if (energy > 0.35 && w1 > 0.45) ctx.fillStyle = 'rgba(255, 179, 0, ' + alpha.toFixed(3) + ')';
      else ctx.fillStyle = 'rgba(0, ' + Math.floor(215 + w1 * 40) + ', 255, ' + (alpha * 0.9).toFixed(3) + ')';
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }

  function drawFrame() {
    ctx.clearRect(0, 0, LOGICAL, LOGICAL);
    drawGlow();
    drawWaveSphere(time);
    const lively = aiState !== 'IDLE' || energy > 0.08;
    for (let i = 0; i < bars.length; i++) {
      const h = lively
        ? 5 + Math.abs(Math.sin(time * 6 + i * 0.7)) * (8 + Math.min(energy, 1.4) * 14)
        : 4 + Math.abs(Math.sin(time * 1.5 + i * 0.4)) * 3;
      bars[i].style.height = h.toFixed(1) + 'px';
    }
  }

  function loop() {
    time += aiState === 'IDLE' && energy < 0.1 ? SPEED_IDLE : SPEED_ACTIVE + Math.min(energy, 1.4) * 0.006;
    energy *= 0.96;
    drawFrame();
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (rafId) return;
    if (!visible || reducedMotion.matches) {
      drawFrame();
      return;
    }
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function tone(from, to, duration) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.setValueAtTime(from, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(to, audioCtx.currentTime + duration);
      gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      /* الصوت غير متاح */
    }
  }

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = ((e.clientX - r.left) / r.width - 0.5) * 2;
    mouseY = ((e.clientY - r.top) / r.height - 0.5) * 2;
  });
  canvas.addEventListener('mouseleave', () => {
    mouseX = 0;
    mouseY = 0;
  });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener('change', () => {
      stop();
      start();
    });
  }

  window.SBHologram = {
    /** نبضة متناسبة مع طول الجزء الذي وصل من الرد (عدد الأحرف) */
    feed(length) {
      energy = Math.min(1.4, energy + Math.min(0.35, Math.max(0.04, length / 120)));
      if (!rafId) drawFrame();
    },
    setState(next) {
      aiState = next;
      if (statusEl) statusEl.textContent = STATUS[next] || STATUS.IDLE;
      if (!rafId) drawFrame();
    },
    pulse(withSound) {
      energy = Math.min(1.4, energy + (withSound ? 0.9 : 0.25));
      if (withSound) tone(320, 1280, 0.22);
      if (!rafId) drawFrame();
    },
    setVisible(next) {
      visible = next;
      if (next) start();
      else stop();
    },
    setSound(on) {
      soundOn = on;
      if (on) tone(520, 960, 0.12);
    },
  };

  resize();
  start();
})();
