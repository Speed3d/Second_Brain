/* ============================================================================
 * الملف: src/features/dashboard-app/public/hologram.js
 * Hint بالعربي: محرك النواة المتحركة (Canvas) ومؤثرات الصوت. يتيح للواجهة: SBHologram.setMode / setState /
 *               pulse / setVisible / setSound.
 *               الأداء: يتوقف الرسم عند إخفاء التبويب أو مغادرة قسم القيادة، ويرسم إطاراً ثابتاً عند تفعيل
 *               "تقليل الحركة"، ويقلل عدد النقاط على الأجهزة الأضعف، ويتبع حجم العنصر الفعلي.
 * ============================================================================ */
'use strict';

(function () {
  const canvas = document.getElementById('coreCanvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('coreStatus');
  const barsBox = document.getElementById('voiceBars');

  const LOGICAL = 560; // كل الرسم يتم في مساحة منطقية 560×560 ثم يُكبّر/يُصغّر لحجم العنصر
  const C = LOGICAL / 2;
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener() {} };
  const weakDevice = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const PARTICLES = weakDevice ? 900 : 1600;

  let mode = 'fusion';
  let aiState = 'IDLE';
  let energy = 0;
  let mouseX = 0;
  let mouseY = 0;
  let time = 0;
  let visible = true;
  let rafId = 0;
  let soundOn = false;
  let audioCtx = null;

  // نقاط موزعة بانتظام على سطح الكرة (لولب فيبوناتشي)
  const points = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < PARTICLES; i++) {
    const y = 1 - (i / (PARTICLES - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    points.push({ x: Math.cos(golden * i) * r, y: y, z: Math.sin(golden * i) * r });
  }

  // أشرطة الصوت
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
    // تغيير الحجم يمسح اللوحة؛ نرسم فوراً حتى لا تظهر فارغة بانتظار الإطار التالي
    drawFrame();
  }

  function drawRings(t) {
    ctx.save();
    ctx.translate(C, C);
    const glow = ctx.createRadialGradient(0, 0, 20, 0, 0, 265);
    glow.addColorStop(0, 'rgba(0, 229, 255, 0.16)');
    glow.addColorStop(0.55, 'rgba(0, 180, 255, 0.05)');
    glow.addColorStop(0.82, 'rgba(255, 140, 0, 0.09)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 265, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.rotate(-t * 0.25);
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.75)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const len = i % 6 === 0 ? 14 : 6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 238, Math.sin(a) * 238);
      ctx.lineTo(Math.cos(a) * (238 + len), Math.sin(a) * (238 + len));
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.rotate(t * 0.42);
    ctx.strokeStyle = '#ff8a00';
    ctx.shadowColor = '#ff8a00';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 224, -0.4, 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 224, Math.PI - 0.6, Math.PI + 0.7);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.rotate(-t * 0.6);
    ctx.strokeStyle = '#00e5ff';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([45, 18, 12, 18]);
    ctx.beginPath();
    ctx.arc(0, 0, 198, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.rotate(t * 0.85);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
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
    ctx.restore();
  }

  function drawSphere(t, radius, scheme, boost) {
    const rotY = t * 0.55 + mouseX * 0.85;
    const rotX = Math.sin(t * 0.35) * 0.35 + mouseY * 0.85;
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX);
    const sinX = Math.sin(rotX);
    const active = aiState === 'SPEAKING' || aiState === 'LISTENING';
    const amp = (active ? 0.22 : 0.12) + boost * 0.16;
    const freq = aiState === 'SPEAKING' ? 6.5 : 4.5;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const w1 = Math.sin(p.x * freq + t * 2.6) * Math.cos(p.y * freq - t * 2.1);
      const w2 = Math.sin(p.z * (freq + 2) + t * 3.2) * 0.5;
      const d = 1 + (w1 + w2) * amp;
      const wx = p.x * d;
      const wy = p.y * d;
      const wz = p.z * d;
      const x1 = wx * cosY - wz * sinY;
      const z1 = wz * cosY + wx * sinY;
      const y2 = wy * cosX - z1 * sinX;
      const z2 = z1 * cosX + wy * sinX;
      const persp = 3.2 / (3.2 - z2);
      const sx = C + x1 * radius * persp;
      const sy = C + y2 * radius * persp;
      const alpha = Math.max(0.12, Math.min(1, (z2 + 1.3) / 2.2));
      const size = Math.max(0.9, (1.5 + (w1 + 0.5) * 0.9) * persp * 0.7);
      if (scheme === 'white') ctx.fillStyle = 'rgba(235, 245, 255, ' + (alpha * 0.85).toFixed(3) + ')';
      else if (aiState === 'SPEAKING' && w1 > 0.38) ctx.fillStyle = 'rgba(255, 179, 0, ' + alpha.toFixed(3) + ')';
      else ctx.fillStyle = 'rgba(0, ' + Math.floor(215 + w1 * 40) + ', 255, ' + (alpha * 0.9).toFixed(3) + ')';
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }

  function drawFrame() {
    ctx.clearRect(0, 0, LOGICAL, LOGICAL);
    if (mode === 'fusion') {
      drawRings(time);
      drawSphere(time, 122, 'cyan', energy);
    } else if (mode === 'cyan_wave') {
      drawSphere(time, 168, 'cyan', energy);
    } else if (mode === 'neural_cloud') {
      drawSphere(time, 168, 'white', energy);
    } else {
      drawRings(time);
      drawSphere(time, 68, 'cyan', energy);
    }
    const active = aiState !== 'IDLE' || energy > 0.1;
    for (let i = 0; i < bars.length; i++) {
      const h = active ? 6 + Math.abs(Math.sin(time * 9 + i * 0.7)) * 20 : 4 + Math.abs(Math.sin(time * 2 + i * 0.4)) * 4;
      bars[i].style.height = h.toFixed(1) + 'px';
    }
  }

  function loop() {
    time += aiState === 'IDLE' ? 0.014 : 0.03;
    energy *= 0.93;
    drawFrame();
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (rafId || !visible || reducedMotion.matches) {
      if (!rafId) drawFrame();
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
    setMode(next) {
      mode = next;
      tone(740, 1180, 0.1);
      if (!rafId) drawFrame();
    },
    setState(next) {
      aiState = next;
      if (statusEl) statusEl.textContent = STATUS[next] || STATUS.IDLE;
      if (!rafId) drawFrame();
    },
    pulse(withSound) {
      energy = 1.2;
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
