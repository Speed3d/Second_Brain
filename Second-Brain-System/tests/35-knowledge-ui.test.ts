/**
 * ============================================================================
 * الملف: tests/35-knowledge-ui.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات واجهة المعرفة (المرحلة 3.2، الإصدار 4.1.0):
 *               - ما تعرضه الواجهة (knowledge-view): التصفية بالمشروع والنوع، والحد، وتفاصيل العقدة بعلاقاتها،
 *                 والخط الزمني، وسجل قرارات المشروع.
 *               - رسم القوى (graph-view.js) يعمل بلا متصفح على 1500 عقدة: يهدأ، وبلا قيم فاسدة، والمترابط أقرب،
 *                 وزمن الخطوة الواحدة مقيس.
 *               - المسارات: بلا جلسة 401، وجلسة العائلة 403، وجلسة القائد تعمل، ورفض المعاملات غير الصالحة.
 *               - الصفحة: الزر واللوحة والسكربت وشرط الظهور (ISS-033).
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { getSystemRootDir } from '../src/core/config-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { STATIC_ASSETS } from '../src/features/dashboard-app/routes/state-routes.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { deriveKnowledgeKey, readKnowledgeGraph, removeKnowledgeRecord, resolveKnowledgeDir, writeEdge, writeNode, type KnowledgeGraph } from '../src/features/knowledge/knowledge-store.ts';
import { edgeIdFor, type KnowledgeEdge, type KnowledgeNode } from '../src/features/knowledge/knowledge-types.ts';
import { decisionLogView, graphView, nodeDetail, readKnowledgeFilter, timelineView } from '../src/features/knowledge/knowledge-view.ts';
import { unlockVault } from '../src/features/vault/vault-manager.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const T = (d: number) => `2026-${d > 30 ? '11' : '10'}-${String(((d - 1) % 30) + 1).padStart(2, '0')}T10:00:00.000Z`;
function node(id: string, type: KnowledgeNode['type'], title: string, d: number, extra: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return { id, type, title, body: title, projectId: 'proj-ui', source: 'manual', status: 'active', confidence: 'confirmed', createdAt: T(d), updatedAt: T(d), ...extra };
}
function edge(type: KnowledgeEdge['type'], from: string, to: string, d = 5): KnowledgeEdge {
  return { id: edgeIdFor(type, from, to), type, from, to, createdAt: T(d) };
}

/** رسم في الذاكرة (بلا تشفير) لاختبار الدوال النقية */
function memGraph(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): KnowledgeGraph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges: new Map(edges.map((e) => [e.id, e])), reviews: new Map(), unreadable: 0 };
}

/** يحمّل graph-view.js في سياق معزول بلوحة رسم وهمية، ويدير الإطارات يدوياً */
function loadGraphView() {
  const frames: Array<() => void> = [];
  const noop = () => undefined;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : key === 'measureText' ? () => ({ width: 40 }) : noop),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  const handlers: Record<string, (e: unknown) => void> = {};
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 900, height: 520, left: 0, top: 0 }),
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      handlers[name] = fn;
    },
    setPointerCapture: noop,
  };
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    performance,
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: noop,
  };
  (sandbox.window as Record<string, unknown>).devicePixelRatio = 1;
  const code = fs.readFileSync(path.join(getSystemRootDir(), 'src', 'features', 'dashboard-app', 'public', 'graph-view.js'), 'utf-8');
  vm.runInNewContext(code, sandbox);
  const api = (sandbox.window as { SBGraphView: { create: (c: unknown, o: unknown) => GraphApi; TYPE_COLORS: Record<string, string> } }).SBGraphView;
  /** يشغّل الإطارات حتى تهدأ أو تنفد */
  const run = (max = 3000) => {
    let n = 0;
    while (frames.length && n < max) {
      frames.shift()!();
      n++;
    }
    return n;
  };
  return { api, canvas, handlers, run };
}
interface GraphApi {
  setData(nodes: unknown[], edges: unknown[]): void;
  stats(): { nodes: number; edges: number; ticks: number; lastTickMs: number; settled: boolean; settledMs: number };
  layout(): Array<{ id: string; x: number; y: number; r: number }>;
  reset(): void;
  isSettled(): boolean;
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات واجهة المعرفة وإرجاع نتائج الفحص.
 */
export async function runKnowledgeUiTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // ===================== 1. ما تعرضه الواجهة (دوال نقية) =====================
  const nodes = [
    node('K-VW-CONV', 'conversation', 'جلسة اختيار الخادم', 1),
    node('K-VW-OLD', 'decision', 'نستضيف على Heroku', 2, { status: 'superseded', body: 'لأنه أسرع للبداية' }),
    node('K-VW-NEW', 'decision', 'نستضيف على Fly.io', 3, { body: 'لأن الكلفة أقل وقرب المستخدمين' }),
    node('K-VW-TASK', 'task', 'نقل قاعدة البيانات', 4),
    node('K-VW-FACT', 'fact', 'حقيقة عامة بلا مشروع', 5, { projectId: null }),
    node('K-VW-OTHER', 'decision', 'قرار مشروع آخر', 6, { projectId: 'proj-other' }),
  ];
  const edges = [
    edge('decided_in', 'K-VW-NEW', 'K-VW-CONV'),
    edge('supersedes', 'K-VW-NEW', 'K-VW-OLD'),
    edge('affected', 'K-VW-NEW', 'K-VW-TASK'),
    edge('related_to', 'K-VW-FACT', 'K-VW-TASK'),
  ];
  const g = memGraph(nodes, edges);
  const all = graphView(g);
  assert.equal(all.nodes.length, 6);
  assert.equal(all.nodes[0].id, 'K-VW-OTHER', 'الأحدث أولاً');
  assert.equal(all.edges.length, 4);
  assert.deepEqual(all.projects, ['proj-other', 'proj-ui'], 'المشاريع مرتبة');
  assert.deepEqual(all.types.map((t) => [t.id, t.count]), [['decision', 3], ['fact', 1], ['task', 1], ['conversation', 1]], 'الأنواع بترتيبها الثابت وأعدادها');
  assert.ok(!('body' in all.nodes[0]), 'المخطط بلا النص الكامل');
  const proj = graphView(g, { projectId: 'PROJ-UI' });
  assert.equal(proj.nodes.length, 4, 'تصفية المشروع بلا حساسية للحالة');
  assert.equal(proj.edges.length, 3, 'والعلاقة التي طرفها خارج التصفية لا تُرسل');
  assert.deepEqual(proj.projects, all.projects, 'القوائم من المعرفة كلها لا من المصفّى');
  assert.deepEqual(graphView(g, { projectId: 'none' }).nodes.map((n) => n.id), ['K-VW-FACT'], '«none» للعامة');
  assert.equal(graphView(g, { type: 'decision' }).nodes.length, 3);
  const limited = graphView(g, {}, 2);
  assert.equal(limited.nodes.length, 2);
  assert.equal(limited.omitted, 4, 'ما تجاوز الحد يُذكر عدده');
  assert.deepEqual(readKnowledgeFilter(new URLSearchParams('project=proj-ui&type=hack')), { projectId: 'proj-ui' }, 'النوع غير المعروف يُتجاهل');
  assert.deepEqual(readKnowledgeFilter(new URLSearchParams('type=task')), { type: 'task' });

  const detail = nodeDetail(g, 'K-VW-OLD')!;
  assert.equal(detail.body, 'لأنه أسرع للبداية');
  assert.equal(detail.statusAr, 'مُستبدَل');
  assert.deepEqual(detail.links.map((l) => [l.relationAr, l.direction, l.node.id]), [['استُبدل بـ', 'in', 'K-VW-NEW']], 'العلاقة تُقرأ من طرفها');
  assert.deepEqual(nodeDetail(g, 'K-VW-NEW')!.links.map((l) => l.relationAr).sort(), ['أثّر على', 'اتُّخذ في محادثة', 'استبدل القرار'].sort());
  assert.equal(nodeDetail(g, 'K-VW-CONV')!.links[0].relationAr, 'اتُّخذ فيها');
  assert.equal(nodeDetail(g, 'K-VW-NOPE'), null);

  const tl = timelineView(g, { projectId: 'proj-ui' });
  assert.deepEqual(tl.items.map((i) => i.id), ['K-VW-TASK', 'K-VW-NEW', 'K-VW-OLD', 'K-VW-CONV'], 'الخط الزمني بالأحدث');
  assert.equal(tl.items.find((i) => i.id === 'K-VW-NEW')!.links, 3, 'بعدد العلاقات');
  assert.equal(timelineView(g, {}, 2).total, 6);

  const log = decisionLogView(g, 'proj-ui');
  assert.deepEqual(log.map((d) => d.id), ['K-VW-NEW', 'K-VW-OLD'], 'سجل القرارات: الأحدث أولاً والمُستبدَل باقٍ');
  assert.equal(log[0].body, 'لأن الكلفة أقل وقرب المستخدمين', 'لماذا');
  assert.deepEqual([log[0].decidedIn[0].id, log[0].supersedes[0].id, log[0].affects[0].id], ['K-VW-CONV', 'K-VW-OLD', 'K-VW-TASK']);
  assert.equal(log[1].supersededBy[0].id, 'K-VW-NEW');
  assert.equal(log[0].sourceAr, 'يدوياً');
  assert.equal(decisionLogView(g, 'proj-other').length, 1, 'كل مشروع بقراراته');
  passedChecks.push('اختبار ما تعرضه واجهة المعرفة (التصفية بالمشروع بلا حساسية للحالة وبالنوع وبالعامة، والعلاقات داخل التصفية فقط، والحد بعدد ما لم يُرسل، وتفاصيل العقدة بعلاقاتها مقروءة من طرفها، والخط الزمني بالأحدث، وسجل القرارات بالسبب والمحادثة وما استبدله) بنجاح.');

  // ===================== 2. رسم القوى على 1500 عقدة =====================
  const { api, canvas, run } = loadGraphView();
  assert.ok(api.TYPE_COLORS.decision && api.TYPE_COLORS.learning, 'لون لكل نوع');
  const view = api.create(canvas, {});
  const N = 1500;
  const big = Array.from({ length: N }, (_, i) => ({ id: 'K-BIG-' + i, type: i % 7 === 0 ? 'decision' : i % 3 === 0 ? 'task' : 'fact', title: 'عقدة ' + i, status: 'active' }));
  // مجموعات من 10 مترابطة داخلياً، وبعض الروابط بين المجموعات
  const bigEdges: Array<{ from: string; to: string; type: string }> = [];
  for (let i = 0; i < N; i++) {
    if (i % 10 !== 0) bigEdges.push({ from: 'K-BIG-' + i, to: 'K-BIG-' + (i - (i % 10)), type: 'related_to' });
    if (i % 50 === 0 && i + 50 < N) bigEdges.push({ from: 'K-BIG-' + i, to: 'K-BIG-' + (i + 50), type: 'affected' });
  }
  const t0 = performance.now();
  view.setData(big, bigEdges);
  const framesRun = run();
  const elapsed = performance.now() - t0;
  const st = view.stats();
  assert.equal(st.nodes, N);
  assert.equal(st.edges, bigEdges.length);
  assert.ok(view.isSettled() && st.settled, `يهدأ ويتوقف عن الرسم (بعد ${framesRun} إطاراً)`);
  const pos = view.layout();
  assert.ok(pos.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), 'بلا قيم فاسدة');
  const at = new Map(pos.map((p) => [p.id, p]));
  const dist = (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y);
  const linked = bigEdges.filter((e) => e.type === 'related_to').slice(0, 300).reduce((s, e) => s + dist(e.from, e.to), 0) / 300;
  let randomSum = 0;
  for (let i = 0; i < 300; i++) randomSum += dist('K-BIG-' + ((i * 37) % N), 'K-BIG-' + ((i * 811 + 500) % N));
  assert.ok(linked < randomSum / 300 / 2, `المترابط أقرب بكثير (${linked.toFixed(0)} مقابل ${(randomSum / 300).toFixed(0)})`);
  let overlapping = 0;
  for (let i = 0; i < N; i += 15) for (let j = i + 1; j < N; j += 15) if (dist('K-BIG-' + i, 'K-BIG-' + j) < 1) overlapping++;
  assert.equal(overlapping, 0, 'لا عقدتان في النقطة نفسها');
  const msPerTick = elapsed / Math.max(1, st.ticks);
  assert.ok(msPerTick < 20, `الخطوة الواحدة سريعة بما يكفي (${msPerTick.toFixed(1)}ms لـ ${N} عقدة)`);
  const kept = view.layout().find((p) => p.id === 'K-BIG-5')!;
  view.setData(big.slice(0, 200), bigEdges.filter((e) => Number(e.from.slice(6)) < 200 && Number(e.to.slice(6)) < 200));
  assert.equal(view.layout().find((p) => p.id === 'K-BIG-5')!.x, kept.x, 'العقدة الباقية بعد التصفية تحتفظ بمكانها');
  run();
  view.setData([], []);
  run();
  assert.equal(view.stats().nodes, 0, 'التفريغ عند القفل');
  passedChecks.push(`اختبار رسم القوى المكتوب يدوياً على ${N} عقدة (يهدأ ويتوقف، وبلا قيم فاسدة ولا تطابق، والمترابط أقرب بكثير، والخطوة ${msPerTick.toFixed(1)}ms، والباقية بعد التصفية تحتفظ بمكانها، والتفريغ) بنجاح.`);

  // ===================== 3. المسارات =====================
  const real = ensureTestVault();
  const commander = unlockVault(real.masterPassword);
  const kk = deriveKnowledgeKey(commander.dataKey);
  const dir = resolveKnowledgeDir();
  for (const n of nodes) writeNode(kk, n, dir);
  for (const e of edges) writeEdge(kk, e, dir);
  assert.ok(readKnowledgeGraph(kk, dir).nodes.has('K-VW-NEW'));
  const server = await startSecondBrainDesktopServer(0);
  const port = (server.address() as AddressInfo).port;
  const get = async (p: string, cookie?: string) => {
    const r = await rawRequest(port, { path: p, headers: cookie ? { Cookie: cookie } : {} });
    return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  try {
    const paths = ['/api/knowledge/graph', '/api/knowledge/node?id=K-VW-NEW', '/api/knowledge/timeline', '/api/knowledge/decisions?project=proj-ui'];
    for (const p of paths) assert.equal((await get(p)).status, 401, `${p} بلا جلسة ← 401`);
    const fam = String((await postJson(port, '/api/vault/unlock', { key: real.emergencyKey })).headers['set-cookie'] ?? '').split(';')[0];
    for (const p of paths) assert.equal((await get(p, fam)).status, 403, `${p} بجلسة العائلة ← 403`);
    const doneOf = (body: string) => JSON.parse(/event: done\ndata: (.*)/.exec(body)![1]) as { referencedKnowledge: string[] };
    const famChat = await postJson(port, '/api/assistant/stream', { question: 'لماذا نستضيف على Fly.io؟', mode: 'wife_emergency' }, fam);
    assert.deepEqual(doneOf(famChat.body).referencedKnowledge, [], 'وضع العائلة: لا عُقد مرجعية');
    resetSessionStateForTests();
    const cookie = String((await postJson(port, '/api/vault/unlock', { key: real.masterPassword })).headers['set-cookie'] ?? '').split(';')[0];
    const graph = (await get('/api/knowledge/graph?project=proj-ui', cookie)).body as { nodes: Array<{ id: string }>; edges: unknown[]; projects: Array<{ id: string; name: string }>; summaryAr: string };
    assert.ok(graph.nodes.some((n) => n.id === 'K-VW-NEW') && !graph.nodes.some((n) => n.id === 'K-VW-OTHER'), 'المخطط مصفّى بالمشروع');
    assert.ok(graph.projects.some((p) => p.id === 'proj-ui' && p.name), 'المشاريع بأسمائها');
    assert.match(graph.summaryAr, /عُقد|عقدة/);
    const typed = (await get('/api/knowledge/graph?type=conversation&project=proj-ui', cookie)).body as { nodes: Array<{ type: string }> };
    assert.ok(typed.nodes.length >= 1 && typed.nodes.every((n) => n.type === 'conversation'), 'وبالنوع');
    const nd = (await get('/api/knowledge/node?id=K-VW-OLD', cookie)).body as { node: { body: string; links: Array<{ relationAr: string }> } };
    assert.equal(nd.node.links[0].relationAr, 'استُبدل بـ');
    assert.equal((await get('/api/knowledge/node?id=../etc', cookie)).status, 400, 'معرّف غير صالح ← 400');
    assert.equal((await get('/api/knowledge/node?id=K-VW-NOPE', cookie)).status, 404);
    const tlr = (await get('/api/knowledge/timeline?project=proj-ui&limit=2', cookie)).body as { items: unknown[]; total: number; summaryAr: string };
    assert.equal(tlr.items.length, 2);
    assert.ok(tlr.total >= 4 && tlr.summaryAr.startsWith('آخر'), 'الخط الزمني بحدّه وملخّصه');
    const dec = (await get('/api/knowledge/decisions?project=proj-ui', cookie)).body as { items: Array<{ id: string }>; summaryAr: string };
    assert.deepEqual(dec.items.map((i) => i.id).filter((id) => id.startsWith('K-VW-')), ['K-VW-NEW', 'K-VW-OLD']);
    assert.equal(dec.summaryAr, 'قراران', 'العدد بصيغة عربية سليمة');
    assert.equal((await get('/api/knowledge/decisions', cookie)).status, 400, 'سجل القرارات يتطلب المشروع');
    const chat = await postJson(port, '/api/assistant/stream', { question: 'لماذا نستضيف على Fly.io؟', mode: 'commander' }, cookie);
    assert.equal(doneOf(chat.body).referencedKnowledge[0], 'K-VW-NEW', 'حدث done يحمل العُقد المرجعية لزر «في المخطط»');
  } finally {
    resetSessionStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const n of nodes) removeKnowledgeRecord('node', n.id, dir);
    for (const e of edges) removeKnowledgeRecord('edge', e.id, dir);
  }
  passedChecks.push('اختبار مسارات واجهة المعرفة (المخطط والعقدة والخط الزمني وسجل القرارات: بلا جلسة 401، وجلسة العائلة 403، وجلسة القائد مصفّاة بالمشروع والنوع، ورفض المعرّف غير الصالح، و 404 للغائبة، وسجل القرارات يتطلب المشروع، وحدث done في المساعد يحمل العُقد المرجعية للقائد وحده) بنجاح.');

  // ===================== 4. الصفحة =====================
  const publicDir = path.join(getSystemRootDir(), 'src', 'features', 'dashboard-app', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf-8');
  assert.equal(STATIC_ASSETS['graph-view.js'], 'text/javascript; charset=utf-8', 'graph-view.js مسموح');
  assert.ok(html.indexOf('/assets/graph-view.js') > 0 && html.indexOf('/assets/graph-view.js') < html.indexOf('/assets/app.js'), 'ويُحمَّل قبل app.js');
  assert.match(html, /data-view="knowledge"/, 'زر «المعرفة» في الشريط الجانبي');
  assert.match(html, /data-panel="knowledge"/);
  assert.match(html, /data-commander-only data-shown-when="0" id="knowledgeBody"/, 'محتوى اللوحة للقائد ويبدأ بشرط «0» (ISS-033)');
  assert.ok(!appJs.includes("$('#knowledgeBody').hidden ="), 'ولا يُضبط بـ hidden مباشرة');
  assert.match(appJs, /if \(view === 'knowledge'\) loadKnowledgeView\(\);/);
  assert.match(appJs, /projectSection\('🗳️ سجل القرارات'/, 'سجل القرارات في صفحة المشروع');
  // replaceChildren يحوّل null إلى النص «null»: تفاصيل العقدة تُصفّى قبله (ظهر في تجربة المتصفح)
  assert.match(appJs, /\$\('#knowledgeDetail'\)\.replaceChildren\(\.\.\.parts\.filter\(Boolean\)\)/, 'لا «null» في تفاصيل العقدة');
  passedChecks.push('اختبار صفحة المعرفة (السكربت مسموح ويُحمَّل قبل app.js، والزر واللوحة، والمحتوى للقائد بشرط ظهور «0»، وبلا «null» في التفاصيل، وسجل القرارات في صفحة المشروع) بنجاح.');
  return passedChecks;
}
