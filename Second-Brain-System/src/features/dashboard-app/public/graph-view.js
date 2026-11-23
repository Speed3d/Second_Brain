/**
 * ============================================================================
 * الملف: src/features/dashboard-app/public/graph-view.js
 * القسم: Dashboard App -> Public (مخطط المعرفة التفاعلي، الإصدار 4.1.0)
 * Hint بالعربي: رسم بالقوى مكتوب يدوياً على Canvas، بلا أي مكتبة ولا اتصال خارجي (سياسة CSP: script-src 'self').
 *               - تنافر بشجرة رباعية (Barnes-Hut، O(n log n)) يشمل كل العُقد ← يكفي لآلاف العُقد بلا تكدّس.
 *               - العلاقات نوابض، وجاذبية خفيفة نحو المركز، والحركة تهدأ ثم تتوقف (لا رسم بلا داعٍ).
 *               - تقريب بالعجلة أو الأزرار، وسحب الخلفية للتحريك، وسحب العقدة لتثبيتها، والضغط لعرض تفاصيلها.
 *               - النصوص تُرسم بـ fillText (لا HTML)، فلا يُحقن شيء من عناوين العُقد في الصفحة.
 * الواجهة: window.SBGraphView.create(canvas, { onSelect }) ← { setData, highlight, select, focusOn, zoomBy, reset, resize, stats, layout, destroy, isSettled }
 * ============================================================================
 */
(function () {
  'use strict';

  /** لون لكل نوع (تستعمله وسيلة الإيضاح في app.js أيضاً) */
  const TYPE_COLORS = {
    decision: '#00e5ff',
    fact: '#2ee59d',
    suggestion: '#b388ff',
    task: '#ffb300',
    goal: '#ff9e40',
    project: '#4fc3f7',
    person: '#ff5c8a',
    contract: '#f48fb1',
    invoice: '#ffd54f',
    conversation: '#8fa9c4',
    skill: '#69f0ae',
    learning: '#80deea',
  };

  const CHARGE = -60; // قوة التنافر (سالبة = تنافر)
  const THETA2 = 0.81; // دقة Barnes-Hut: الخلية أصغر من 0.9 من بُعدها تُعامل ككتلة واحدة
  const LINK_DIST = 45; // طول العلاقة المرغوب
  const LINK_K = 0.6;
  const GRAVITY = 0.15; // جاذبية خفيفة نحو المركز حتى لا تبتعد المجموعات المنفصلة
  const VELOCITY_KEEP = 0.6;
  const ALPHA_DECAY = 0.0228; // تهدأ في نحو 300 خطوة
  const ALPHA_MIN = 0.001;

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function create(canvas, options) {
    const opts = options || {};
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const C = { bg: color('--bg', '#050a12'), text: color('--text', '#e6f3ff'), muted: color('--muted', '#8fa9c4'), line: 'rgba(143,169,196,0.28)', amber: color('--amber', '#ffb300'), cyan: color('--cyan', '#00e5ff') };

    let nodes = []; // { id, type, title, status, x, y, vx, vy, r, fixed, deg }
    let edges = []; // { a, b, type }
    let byId = new Map();
    let neighbors = new Map();
    let view = { x: 0, y: 0, k: 1 };
    let alpha = 0;
    let raf = 0;
    let dirty = true;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let hover = null;
    let selected = null;
    let marked = null; // Set من نتائج البحث
    let drag = null;
    const stat = { ticks: 0, lastTickMs: 0, lastDrawMs: 0, settleStartedAt: 0, settledMs: 0 };

    // ===================== البيانات =====================
    function setData(list, links) {
      const old = byId;
      byId = new Map();
      nodes = list.map((n, i) => {
        const prev = old.get(n.id);
        // موضع ابتدائي ثابت لكل معرّف (لولب)، والعقدة الباقية تحتفظ بمكانها
        const h = hash(n.id);
        const angle = i * 2.39996 + (h % 100) / 100;
        const radius = 14 * Math.sqrt(i + 1);
        const node = prev
          ? Object.assign(prev, { type: n.type, title: n.title, status: n.status })
          : { id: n.id, type: n.type, title: n.title, status: n.status, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, fixed: false };
        node.deg = 0;
        byId.set(n.id, node);
        return node;
      });
      neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
      edges = [];
      for (const e of links) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b || a === b) continue;
        edges.push({ a, b, type: e.type });
        a.deg++;
        b.deg++;
        neighbors.get(a.id).add(b.id);
        neighbors.get(b.id).add(a.id);
      }
      for (const n of nodes) n.r = 4 + Math.min(10, Math.sqrt(n.deg) * 2.2) + (n.type === 'project' ? 3 : 0);
      if (selected && !byId.has(selected)) selected = null;
      if (hover && !byId.has(hover.id)) hover = null;
      heat(old.size ? 0.6 : 1);
    }

    function heat(a) {
      alpha = Math.max(alpha, a);
      stat.settleStartedAt = performance.now();
      stat.settledMs = 0;
      schedule();
    }

    // ===================== المحاكاة =====================
    // التنافر بشجرة رباعية (Barnes-Hut): الخلية البعيدة تُعامل ككتلة واحدة في مركزها، فالخطوة O(n log n)
    // والتنافر يشمل كل العُقد (لا حدّ للمسافة)، فلا تتكدّس المجموعات المنفصلة.
    function buildTree() {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const n of nodes) {
        if (n.x < x0) x0 = n.x;
        if (n.y < y0) y0 = n.y;
        if (n.x > x1) x1 = n.x;
        if (n.y > y1) y1 = n.y;
      }
      const root = { x: x0, y: y0, s: Math.max(x1 - x0, y1 - y0) + 1, kids: null, pts: [], m: 0, cx: 0, cy: 0 };
      for (const n of nodes) insert(root, n, 0);
      mass(root);
      return root;
    }

    function insert(cell, n, depth) {
      for (;;) {
        if (!cell.kids) {
          // ورقة: فارغة، أو عقدة في النقطة نفسها، أو بلغنا العمق الأقصى ← تُضاف هنا
          if (!cell.pts.length || depth > 24 || (cell.pts[0].x === n.x && cell.pts[0].y === n.y)) {
            cell.pts.push(n);
            return;
          }
          const half = cell.s / 2;
          cell.kids = [0, 1, 2, 3].map((i) => ({ x: cell.x + (i & 1) * half, y: cell.y + (i >> 1) * half, s: half, kids: null, pts: [], m: 0, cx: 0, cy: 0 }));
          const old = cell.pts;
          cell.pts = [];
          for (const p of old) insert(cell, p, depth);
        }
        const half = cell.s / 2;
        cell = cell.kids[(n.x >= cell.x + half ? 1 : 0) + (n.y >= cell.y + half ? 2 : 0)];
        depth++;
      }
    }

    function mass(cell) {
      let m = 0;
      let sx = 0;
      let sy = 0;
      if (cell.kids) {
        for (const k of cell.kids) {
          mass(k);
          m += k.m;
          sx += k.cx * k.m;
          sy += k.cy * k.m;
        }
      } else {
        for (const p of cell.pts) {
          m++;
          sx += p.x;
          sy += p.y;
        }
      }
      cell.m = m;
      cell.cx = m ? sx / m : 0;
      cell.cy = m ? sy / m : 0;
    }

    function repel(n, root) {
      const w0 = CHARGE * alpha;
      const stack = [root];
      while (stack.length) {
        const cell = stack.pop();
        if (!cell.m) continue;
        let dx = cell.cx - n.x;
        let dy = cell.cy - n.y;
        let l = dx * dx + dy * dy;
        if (cell.kids) {
          if ((cell.s * cell.s) / THETA2 < l) {
            n.vx += (dx * w0 * cell.m) / l;
            n.vy += (dy * w0 * cell.m) / l;
          } else for (const k of cell.kids) stack.push(k);
          continue;
        }
        for (const p of cell.pts) {
          if (p === n) continue;
          dx = p.x - n.x;
          dy = p.y - n.y;
          l = dx * dx + dy * dy;
          if (l < 1) {
            // عقدتان في النقطة نفسها: دفعة ثابتة من المعرّف حتى تنفصلا
            dx = ((hash(n.id) % 9) - 4 || 1) * 0.5;
            dy = ((hash(p.id) % 9) - 4 || 1) * 0.5;
            l = dx * dx + dy * dy;
          }
          n.vx += (dx * w0) / l;
          n.vy += (dy * w0) / l;
        }
      }
    }

    function tick() {
      const t0 = performance.now();
      const root = buildTree();
      for (const n of nodes) {
        repel(n, root);
        n.vx -= n.x * GRAVITY * alpha;
        n.vy -= n.y * GRAVITY * alpha;
      }
      for (const e of edges) {
        const dx = e.b.x + e.b.vx - e.a.x - e.a.vx;
        const dy = e.b.y + e.b.vy - e.a.y - e.a.vy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        // العقدة كثيرة العلاقات تتحرك أقل (كما في d3: القوة تُقسم على عدد علاقات الطرف الأقل)
        const k = (((d - LINK_DIST) / d) * alpha * LINK_K) / Math.min(e.a.deg, e.b.deg);
        const bias = e.a.deg / (e.a.deg + e.b.deg);
        e.b.vx -= dx * k * bias;
        e.b.vy -= dy * k * bias;
        e.a.vx += dx * k * (1 - bias);
        e.a.vy += dy * k * (1 - bias);
      }
      for (const n of nodes) {
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= VELOCITY_KEEP;
        n.vy *= VELOCITY_KEEP;
        // حد للسرعة حتى لا «تنفجر» البداية
        const v = Math.hypot(n.vx, n.vy);
        if (v > 40) {
          n.vx = (n.vx / v) * 40;
          n.vy = (n.vy / v) * 40;
        }
        n.x += n.vx;
        n.y += n.vy;
      }
      alpha += (0 - alpha) * ALPHA_DECAY;
      stat.ticks++;
      stat.lastTickMs = performance.now() - t0;
      if (alpha < ALPHA_MIN) {
        alpha = 0;
        stat.settledMs = Math.round(performance.now() - stat.settleStartedAt);
      }
    }

    // ===================== الرسم =====================
    function toScreen(n) {
      return { x: (n.x + view.x) * view.k + width / 2, y: (n.y + view.y) * view.k + height / 2 };
    }
    function toWorld(px, py) {
      return { x: (px - width / 2) / view.k - view.x, y: (py - height / 2) / view.k - view.y };
    }

    function draw() {
      const t0 = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(view.k, view.k);
      ctx.translate(view.x, view.y);
      const focus = (hover && hover.id) || selected;
      const near = focus ? neighbors.get(focus) : null;
      const lit = (n) => !focus || n.id === focus || (near && near.has(n.id));

      // العلاقات والعُقد مجمّعة حسب طريقة رسمها، فيُرسم كل نوع بمسار واحد (أسرع بكثير من خط لكل علاقة)
      const groups = new Map();
      const add = (key, style, item) => {
        let g = groups.get(key);
        if (!g) groups.set(key, (g = Object.assign({ items: [] }, style)));
        g.items.push(item);
      };
      for (const e of edges) {
        const on = focus && (e.a.id === focus || e.b.id === focus);
        const sup = e.type === 'supersedes';
        const a = focus && !on ? 0.08 : on ? 0.95 : 0.5;
        add('e' + a + sup + on, { alpha: a, color: sup ? C.amber : on ? C.cyan : C.line, dash: sup }, e);
      }
      ctx.lineWidth = 1 / view.k;
      for (const g of groups.values()) {
        ctx.globalAlpha = g.alpha;
        ctx.strokeStyle = g.color;
        ctx.setLineDash(g.dash ? [5 / view.k, 4 / view.k] : []);
        ctx.beginPath();
        for (const e of g.items) {
          ctx.moveTo(e.a.x, e.a.y);
          ctx.lineTo(e.b.x, e.b.y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      groups.clear();
      const ringed = [];
      for (const n of nodes) {
        const faded = !lit(n) || (marked && !marked.has(n.id));
        const a = faded ? 0.15 : n.status === 'superseded' || n.status === 'outdated' ? 0.5 : 1;
        add('n' + a + n.type, { alpha: a, color: TYPE_COLORS[n.type] || C.muted }, n);
        if (n.id === selected || (marked && marked.has(n.id))) ringed.push(n);
      }
      for (const g of groups.values()) {
        ctx.globalAlpha = g.alpha;
        ctx.fillStyle = g.color;
        ctx.beginPath();
        for (const n of g.items) {
          ctx.moveTo(n.x + n.r, n.y);
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      if (ringed.length) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C.text;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath();
        for (const n of ringed) {
          ctx.moveTo(n.x + n.r + 2 / view.k, n.y);
          ctx.arc(n.x, n.y, n.r + 2 / view.k, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      ctx.restore();

      // العناوين بحجم ثابت على الشاشة: للمحدَّدة وجيرانها، أو للكل عند التقريب الكافي
      ctx.globalAlpha = 1;
      ctx.font = '12px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.direction = 'rtl';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const showAll = view.k >= 1.4 && nodes.length <= 400;
      for (const n of nodes) {
        const want = n.id === focus || (near && near.has(n.id)) || (marked && marked.has(n.id)) || (showAll && !focus);
        if (!want) continue;
        const p = toScreen(n);
        if (p.x < -100 || p.y < -20 || p.x > width + 100 || p.y > height + 20) continue;
        const label = n.title.length > 42 ? n.title.slice(0, 41) + '…' : n.title;
        ctx.fillStyle = 'rgba(5,10,18,0.78)';
        const w = ctx.measureText(label).width + 8;
        ctx.fillRect(p.x - w / 2, p.y + n.r * view.k + 3, w, 16);
        ctx.fillStyle = n.id === focus ? C.text : C.muted;
        ctx.fillText(label, p.x, p.y + n.r * view.k + 5);
      }
      stat.lastDrawMs = performance.now() - t0;
      dirty = false;
    }

    function frame() {
      raf = 0;
      if (alpha > 0) {
        tick();
        dirty = true;
      }
      if (dirty) draw();
      if (alpha > 0) schedule();
    }

    function schedule() {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(frame);
    }

    // ===================== التفاعل =====================
    function hit(px, py) {
      const w = toWorld(px, py);
      let best = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        const reach = n.r + 4 / view.k;
        if (d <= reach && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }

    function point(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onDown(e) {
      const p = point(e);
      const n = hit(p.x, p.y);
      drag = { node: n, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      if (n) n.fixed = true;
    }

    function onMove(e) {
      const p = point(e);
      if (!drag) {
        const n = hit(p.x, p.y);
        if ((n && n.id) !== (hover && hover.id)) {
          hover = n;
          canvas.style.cursor = n ? 'pointer' : 'grab';
          schedule();
        }
        return;
      }
      if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) drag.moved = true;
      if (drag.node) {
        const w = toWorld(p.x, p.y);
        drag.node.x = w.x;
        drag.node.y = w.y;
        if (drag.moved) heat(0.25);
      } else {
        view.x += (p.x - drag.lastX) / view.k;
        view.y += (p.y - drag.lastY) / view.k;
        canvas.style.cursor = 'grabbing';
        schedule();
      }
      drag.lastX = p.x;
      drag.lastY = p.y;
    }

    function onUp() {
      if (!drag) return;
      const d = drag;
      drag = null;
      canvas.style.cursor = 'grab';
      if (!d.moved) {
        if (d.node) d.node.fixed = false; // ضغطة بلا سحب لا تثبّت العقدة
        select(d.node ? d.node.id : null, true);
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const p = point(e);
      zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }

    function zoomAt(factor, px, py) {
      const before = toWorld(px, py);
      view.k = Math.min(6, Math.max(0.08, view.k * factor));
      const after = toWorld(px, py);
      view.x += after.x - before.x;
      view.y += after.y - before.y;
      schedule();
    }

    function onKey(e) {
      if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === '0') reset();
      else if (e.key === 'Escape') select(null, true);
      else return;
      e.preventDefault();
    }

    // ===================== الواجهة العامة =====================
    function select(id, fromUser) {
      selected = id && byId.has(id) ? id : null;
      schedule();
      if (fromUser && typeof opts.onSelect === 'function') opts.onSelect(selected);
    }

    function highlight(ids) {
      marked = ids && ids.length ? new Set(ids) : null;
      schedule();
    }

    function zoomBy(f) {
      zoomAt(f, width / 2, height / 2);
    }

    /** يضبط التقريب حتى تظهر العُقد كلها */
    function reset() {
      if (!nodes.length) {
        view = { x: 0, y: 0, k: 1 };
        schedule();
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      const k = Math.min(width / (maxX - minX + 80), height / (maxY - minY + 80));
      view = { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, k: Math.min(2, Math.max(0.08, k)) };
      schedule();
    }

    /** يحرّك العرض إلى عقدة ويحدّدها */
    function focusOn(id) {
      const n = byId.get(id);
      if (!n) return;
      view.x = -n.x;
      view.y = -n.y;
      view.k = Math.max(view.k, 1.2);
      select(id, false);
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      schedule();
    }

    /** مواضع العُقد (للاختبارات وقياس السرعة) */
    function layout() {
      return nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, r: n.r }));
    }

    function stats() {
      return { nodes: nodes.length, edges: edges.length, ticks: stat.ticks, lastTickMs: +stat.lastTickMs.toFixed(2), lastDrawMs: +stat.lastDrawMs.toFixed(2), settled: alpha === 0, settledMs: stat.settledMs, zoom: +view.k.toFixed(3) };
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', () => {
      if (!drag && hover) {
        hover = null;
        schedule();
      }
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    canvas.style.cursor = 'grab';
    resize();

    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      nodes = [];
      edges = [];
    }

    return { setData, highlight, select, focusOn, zoomBy, reset, resize, stats, layout, destroy, isSettled: () => alpha === 0 };
  }

  window.SBGraphView = { create, TYPE_COLORS };
})();
