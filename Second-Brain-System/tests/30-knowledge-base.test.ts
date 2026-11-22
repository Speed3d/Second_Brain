/**
 * ============================================================================
 * الملف: tests/30-knowledge-base.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات أساس المعرفة (المرحلة 3.1، الإصدار 4.0.0):
 *               - الأنواع والتحقق: عقدة وعلاقة صالحتان، ورفض الأشكال الغريبة، ومعرّف العلاقة الحتمي.
 *               - مفتاح المعرفة: مشتقّ من مفتاح البيانات، ثابت للجهازين، ولا يساويه، ولا يُشتق بلا مفتاح بيانات.
 *               - التخزين المشفّر: لا نص صريح على القرص، ومفتاح البيانات والمفتاح الخاطئ لا يفتحانه.
 *               - الترحيل من الذاكرة المشتركة: بلا فقد، وبعدد مطابق، وحتمي، ويُعاد تشغيله بلا تكرار، ويكمل الترحيل الناقص.
 *               - الاستعلامات: البحث بالعربية، والجيران، والمسار، وسجل القرارات، والخط الزمني.
 *               - المزامنة بين جهازين (ومنها الترحيل المتزامن بلا تعارض)، والنسخ الاحتياطية، والترحيل عند فتح القائد.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { openWithKey } from '../src/core/crypto-engine.ts';
import { closeVaultSession, openVaultSession, resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createEncryptedSystemBackup, isExpectedBackupEntry, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { decisionNodeId, conversationNodeId, migrateSharedMemoryToKnowledge, nodesFromMemoryEntry } from '../src/features/knowledge/knowledge-migration.ts';
import { decisionLog, findPath, neighborsOf, normalizeForSearch, searchKnowledge, timeline } from '../src/features/knowledge/knowledge-query.ts';
import { deriveKnowledgeKey, listKnowledgeFiles, openKnowledgeRecord, readKnowledgeGraph, removeKnowledgeRecord, resolveKnowledgeDir, writeEdge, writeNode } from '../src/features/knowledge/knowledge-store.ts';
import { edgeIdFor, newNodeId, validateEdge, validateNode, type KnowledgeNode } from '../src/features/knowledge/knowledge-types.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../src/features/ai-memory/shared-memory-service.ts';
import { runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import { listConflicts } from '../src/features/sync/sync-store.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { createVault, unlockVault } from '../src/features/vault/vault-manager.ts';
import type { SharedAIMemoryEntry } from '../src/shared/types.ts';
import { ensureTestVault, writeFixtureFile } from './test-environment.ts';

const PASS = 'Knowledge-Base-Test-Pass-01';
const T0 = '2026-11-20T10:00:00.000Z';

function node(overrides: Partial<KnowledgeNode> & Pick<KnowledgeNode, 'id' | 'type' | 'title'>): KnowledgeNode {
  return { body: '', projectId: 'proj-a', source: 'manual', status: 'active', confidence: 'confirmed', createdAt: T0, updatedAt: T0, ...overrides };
}

function edge(type: Parameters<typeof edgeIdFor>[0], from: string, to: string, createdAt = T0) {
  return { id: edgeIdFor(type, from, to), type, from, to, createdAt };
}

function memoryEntry(id: string, decisions: string[], createdAt = T0, projectId = 'proj-a'): SharedAIMemoryEntry {
  return { id, sourceAI: 'claude-code', projectId, title: `جلسة ${id}`, summaryAr: `ملخص الجلسة ${id}: اعتمدنا قاعدة الأمان`, keyDecisionsAr: decisions, createdAt };
}

function makeSyncDevice(baseDir: string, name: string, syncRoot: string, vaultSource: string): SyncContext {
  const rootDir = path.join(baseDir, name);
  const dataDir = path.join(rootDir, 'Second-Brain-System', 'data');
  const vaultFile = path.join(dataDir, 'encrypted-vault', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
  fs.copyFileSync(vaultSource, vaultFile);
  const ctx: SyncContext = {
    device: { deviceId: `id-${name}`, deviceName: name, platform: 'test' },
    syncRoot,
    rootDir,
    dataDir,
    vaultFile,
    obsidianDir: path.join(rootDir, 'Obsidian-Vault'),
    brandingPath: path.join(rootDir, 'config', 'branding.json'),
    settingsPath: path.join(rootDir, 'config', 'settings.json'),
  };
  writeFixtureFile(ctx.brandingPath, JSON.stringify({ appName: 'Second Brain' }));
  writeFixtureFile(ctx.settingsPath, JSON.stringify({ watchedProjects: [] }));
  fs.mkdirSync(ctx.obsidianDir, { recursive: true });
  return ctx;
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات أساس المعرفة وإرجاع نتائج الفحص.
 */
export async function runKnowledgeBaseTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const base = path.join(loadSystemConfig().paths.rootDir, 'knowledge-sim');
  fs.mkdirSync(base, { recursive: true });
  try {
    // ===================== 1. الأنواع والتحقق =====================
    const ok = validateNode(node({ id: 'K-DEC-1', type: 'decision', title: 'نستعمل Node بلا حزم', body: 'لأن الدستور', extra: 'x' } as unknown as KnowledgeNode));
    assert.equal((ok as unknown as Record<string, unknown>).extra, undefined, 'الحقل الغريب لا يُحفظ');
    assert.throws(() => validateNode(node({ id: 'bad id', type: 'decision', title: 'x' })), /معرّف/);
    assert.throws(() => validateNode(node({ id: 'K-X', type: 'nonsense' as never, title: 'x' })), /نوع عقدة/);
    assert.throws(() => validateNode(node({ id: 'K-X', type: 'fact', title: '' })), /عنوان/);
    assert.throws(() => validateNode(node({ id: 'K-X', type: 'fact', title: 'x'.repeat(301) })), /عنوان/);
    assert.throws(() => validateNode(node({ id: 'K-X', type: 'fact', title: 'x', createdAt: 'أمس' })), /تاريخ/);
    assert.throws(() => validateNode(node({ id: 'K-X', type: 'fact', title: 'x', status: 'deleted' as never })), /حالة/);
    assert.equal(edgeIdFor('decided_in', 'K-A', 'K-B'), edgeIdFor('decided_in', 'K-A', 'K-B'), 'معرّف العلاقة حتمي');
    assert.notEqual(edgeIdFor('decided_in', 'K-A', 'K-B'), edgeIdFor('decided_in', 'K-B', 'K-A'), 'والاتجاه جزء منه');
    assert.equal(validateEdge(edge('supersedes', 'K-A', 'K-B')).type, 'supersedes');
    assert.throws(() => validateEdge({ ...edge('supersedes', 'K-A', 'K-B'), id: edgeIdFor('related_to', 'K-A', 'K-B') }), /لا يطابق/, 'معرّف لا يطابق النوع مرفوض');
    assert.throws(() => validateEdge(edge('related_to', 'K-A', 'K-A')), /بنفسها/);
    assert.match(newNodeId('decision'), /^K-DECI-\d{13}-[a-f0-9]{8}$/);
    passedChecks.push('اختبار أنواع المعرفة والتحقق (الحقول المعروفة فقط، ورفض المعرّف والنوع والعنوان والتاريخ والحالة غير الصالحة، والعلاقة بمعرّف حتمي يشمل الاتجاه، ولا علاقة للعقدة بنفسها) بنجاح.');

    // ===================== 2. مفتاح المعرفة =====================
    const { vault } = createVault(PASS, path.join(base, 'vault', 'vault.aes256.json'));
    const kk = deriveKnowledgeKey(vault.dataKey);
    assert.equal(kk.length, 32);
    assert.ok(kk.equals(deriveKnowledgeKey(Buffer.from(vault.dataKey))), 'المفتاح نفسه من مفتاح البيانات نفسه (الجهازان)');
    assert.ok(!kk.equals(vault.dataKey), 'لا يساوي مفتاح البيانات');
    assert.ok(!kk.equals(deriveKnowledgeKey(Buffer.alloc(32, 7))), 'مفتاح بيانات آخر ← مفتاح معرفة آخر');
    assert.throws(() => deriveKnowledgeKey(Buffer.alloc(0)), /المعرفة تحتاج/, 'جلسة العائلة أو الخزنة الممسوحة لا تملك المعرفة');
    passedChecks.push('اختبار مفتاح المعرفة (مشتقّ وثابت من مفتاح البيانات نفسه، ولا يساويه، ويختلف باختلافه، ولا يُشتق بلا مفتاح بيانات) بنجاح.');

    // ===================== 3. التخزين المشفّر =====================
    const dir = path.join(base, 'store');
    const secretTitle = 'قرار سري جداً بعنوان مميز-7731';
    writeNode(kk, node({ id: 'K-DEC-S1', type: 'decision', title: secretTitle, body: 'نص مميز-8842' }), dir);
    writeNode(kk, node({ id: 'K-CONV-S1', type: 'conversation', title: 'محادثة', body: '' }), dir);
    writeEdge(kk, edge('decided_in', 'K-DEC-S1', 'K-CONV-S1'), dir);
    const files = listKnowledgeFiles(dir);
    assert.equal(files.length, 3);
    for (const f of files) {
      const raw = fs.readFileSync(f.file, 'utf8');
      assert.ok(!raw.includes('مميز-7731') && !raw.includes('مميز-8842') && !raw.includes('decision'), 'لا نص صريح ولا نوع على القرص');
      const sealed = JSON.parse(raw).sealed;
      assert.throws(() => openWithKey(sealed, vault.dataKey), 'مفتاح البيانات نفسه لا يفتح المعرفة');
    }
    const g = readKnowledgeGraph(kk, dir);
    assert.equal(g.nodes.get('K-DEC-S1')?.title, secretTitle);
    assert.equal(g.edges.size, 1);
    assert.equal(readKnowledgeGraph(deriveKnowledgeKey(Buffer.alloc(32, 9)), dir).unreadable, 3, 'المفتاح الخاطئ: كلها غير مقروءة، ولا انهيار');
    fs.copyFileSync(files.find((f) => f.id === 'K-DEC-S1')!.file, path.join(dir, 'nodes', 'K-DEC-RENAMED.enc.json'));
    assert.equal(readKnowledgeGraph(kk, dir).unreadable, 1, 'ملف باسم لا يطابق معرّفه يُرفض');
    assert.equal(removeKnowledgeRecord('node', 'K-DEC-RENAMED', dir), true);
    assert.throws(() => writeNode(kk, node({ id: 'K-../../x', type: 'fact', title: 'x' }), dir), /معرّف/, 'لا خروج من المجلد بالمعرّف');
    passedChecks.push('اختبار التخزين المشفّر (ملف لكل عقدة وعلاقة بلا نص صريح ولا نوع، ومفتاح البيانات والمفتاح الخاطئ لا يفتحانه، والملف بغير اسمه مرفوض، ولا خروج من المجلد) بنجاح.');

    // ===================== 4. الترحيل =====================
    const mdir = path.join(base, 'migrated');
    const entries = [
      memoryEntry('MEM-1-AAAA', ['القرار الأول', 'القرار الثاني', '  ']),
      memoryEntry('MEM-2-BBBB', []),
      { ...memoryEntry('MEM-3-CCCC', ['قرار']), createdAt: 'تاريخ تالف' },
    ];
    const r1 = migrateSharedMemoryToKnowledge(kk, entries, mdir);
    assert.deepEqual({ ...r1 }, { entries: 3, createdNodes: 4, createdEdges: 2, alreadyMigrated: 0, skipped: 1 }, 'محادثتان، وقراران (الفارغ لا يُحسب)، والتالف يُتجاهل');
    const mg = readKnowledgeGraph(kk, mdir);
    assert.equal(mg.nodes.get(conversationNodeId('MEM-1-AAAA'))?.body, entries[0].summaryAr, 'الملخص كاملاً');
    assert.equal(mg.nodes.get(decisionNodeId('MEM-1-AAAA', 2))?.body, 'القرار الثاني');
    assert.equal(mg.nodes.get(decisionNodeId('MEM-1-AAAA', 1))?.source, 'claude-code', 'المصدر يبقى');
    assert.equal(mg.nodes.get(decisionNodeId('MEM-1-AAAA', 1))?.origin?.memoryId, 'MEM-1-AAAA');
    const r2 = migrateSharedMemoryToKnowledge(kk, entries, mdir);
    assert.equal(r2.createdNodes, 0, 'إعادة التشغيل لا تكرر');
    assert.equal(r2.alreadyMigrated, 2);
    // ترحيل ناقص (انقطع قبل عقدة المحادثة): يكتمل في المرة التالية بلا تكرار
    removeKnowledgeRecord('node', conversationNodeId('MEM-1-AAAA'), mdir);
    removeKnowledgeRecord('node', decisionNodeId('MEM-1-AAAA', 2), mdir);
    const r3 = migrateSharedMemoryToKnowledge(kk, entries, mdir);
    assert.equal(r3.createdNodes, 2, 'المحادثة والقرار الناقص فقط');
    assert.equal(readKnowledgeGraph(kk, mdir).nodes.size, 4);
    // حتمي: جهاز آخر يرحّل السجلات نفسها فيعطي المحتوى المنطقي نفسه
    const other = path.join(base, 'migrated-other');
    migrateSharedMemoryToKnowledge(kk, entries, other);
    const logical = (d: string) => listKnowledgeFiles(d).map((f) => JSON.stringify(openKnowledgeRecord(kk, f.kind, fs.readFileSync(f.file)))).sort();
    assert.deepEqual(logical(other), logical(mdir), 'الترحيل حتمي');
    assert.deepEqual(nodesFromMemoryEntry(entries[0]), nodesFromMemoryEntry(structuredClone(entries[0])));
    passedChecks.push('اختبار الترحيل من الذاكرة المشتركة (بلا فقد وبعدد مطابق، والقرار الفارغ والسجل التالف لا يدخلان، وإعادة التشغيل بلا تكرار، والترحيل الناقص يكتمل، وحتمي على جهازين) بنجاح.');

    // ===================== 5. الاستعلامات =====================
    const qdir = path.join(base, 'query');
    const nodes: KnowledgeNode[] = [
      node({ id: 'K-CONV-Q1', type: 'conversation', title: 'جلسة تصميم الأمان', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }),
      node({ id: 'K-DEC-Q1', type: 'decision', title: 'نعتمد قاعدة البيانات SQLite', body: 'خفيفة', status: 'superseded', createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:00:00.000Z' }),
      node({ id: 'K-DEC-Q2', type: 'decision', title: 'نعتمد قاعدة البيانات PostgreSQL', body: 'للتوسّع', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z' }),
      node({ id: 'K-TASK-Q1', type: 'task', title: 'نقل الجداول', projectId: 'proj-b', createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z' }),
      node({ id: 'K-FACT-Q1', type: 'fact', title: 'الأمان أولوية', body: 'إِنَّ الأَمانَ أَوَّلاً', projectId: null, createdAt: '2026-11-07T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z' }),
      node({ id: 'K-LONE-Q1', type: 'skill', title: 'Kotlin', projectId: null }),
    ];
    for (const n of nodes) writeNode(kk, n, qdir);
    for (const e of [edge('decided_in', 'K-DEC-Q1', 'K-CONV-Q1'), edge('decided_in', 'K-DEC-Q2', 'K-CONV-Q1'), edge('supersedes', 'K-DEC-Q2', 'K-DEC-Q1'), edge('affected', 'K-DEC-Q2', 'K-TASK-Q1'), edge('related_to', 'K-TASK-Q1', 'K-GHOST-1')]) writeEdge(kk, e, qdir);
    const q = readKnowledgeGraph(kk, qdir);
    assert.equal(normalizeForSearch('قاعدةٌ أمانٌ ى'), 'قاعده امان ي');
    assert.deepEqual(searchKnowledge(q, 'قاعده البيانات').map((h) => h.node.id), ['K-DEC-Q2'], 'التاء المربوطة كالهاء، والمُستبدَل لا يظهر افتراضياً');
    assert.deepEqual(searchKnowledge(q, 'قاعدة', { includeSuperseded: true }).map((h) => h.node.id), ['K-DEC-Q2', 'K-DEC-Q1'], 'الساري أولاً');
    assert.deepEqual(searchKnowledge(q, 'امان').map((h) => h.node.id), ['K-FACT-Q1', 'K-CONV-Q1'], 'الهمزة والتشكيل لا يمنعان التطابق، والعنوان والأحدث أولاً');
    assert.deepEqual(searchKnowledge(q, 'نقل', { projectId: 'proj-a' }), [], 'تصفية المشروع');
    assert.deepEqual(searchKnowledge(q, 'نعتمد', { types: ['task'] }), [], 'تصفية النوع');
    assert.deepEqual(searchKnowledge(q, 'ا'), [], 'كلمة من حرف واحد لا تبحث');
    const near = neighborsOf(q, 'K-DEC-Q2');
    assert.deepEqual(near.map((n) => [n.edge.type, n.direction, n.node.id]).sort(), [['affected', 'out', 'K-TASK-Q1'], ['decided_in', 'out', 'K-CONV-Q1'], ['supersedes', 'out', 'K-DEC-Q1']].sort());
    assert.equal(neighborsOf(q, 'K-TASK-Q1').length, 1, 'الطرف الغائب (لم يصل بالمزامنة بعد) يُتجاهل');
    assert.deepEqual(findPath(q, 'K-TASK-Q1', 'K-DEC-Q1'), ['K-TASK-Q1', 'K-DEC-Q2', 'K-DEC-Q1'], 'أقصر مسار');
    assert.equal(findPath(q, 'K-TASK-Q1', 'K-LONE-Q1'), null, 'لا مسار');
    assert.equal(findPath(q, 'K-TASK-Q1', 'K-DEC-Q1', 1), null, 'حد العمق');
    const log = decisionLog(q, 'proj-a');
    assert.deepEqual(log.map((l) => l.decision.id), ['K-DEC-Q2', 'K-DEC-Q1'], 'الأحدث أولاً، والمُستبدَل يبقى في التاريخ');
    assert.deepEqual(log[0].supersedes.map((n) => n.id), ['K-DEC-Q1']);
    assert.deepEqual(log[1].supersededBy.map((n) => n.id), ['K-DEC-Q2']);
    assert.deepEqual(log[0].decidedIn.map((n) => n.id), ['K-CONV-Q1']);
    assert.deepEqual(log[0].affects.map((n) => n.id), ['K-TASK-Q1']);
    assert.equal(decisionLog(q, 'proj-b').length, 0);
    assert.deepEqual(timeline(q, { from: '2026-11-02T00:00:00.000Z', to: '2026-11-06T23:00:00.000Z' }).map((n) => n.id), ['K-TASK-Q1', 'K-DEC-Q2', 'K-DEC-Q1']);
    assert.deepEqual(timeline(q, { types: ['fact', 'skill'] }).map((n) => n.id), ['K-LONE-Q1', 'K-FACT-Q1']);
    passedChecks.push('اختبار استعلامات المعرفة (البحث بالعربية يتجاهل التشكيل والهمزات والتاء المربوطة، والساري قبل المُستبدَل، والتصفية بالمشروع والنوع، والجيران بالاتجاه، وأقصر مسار وحد العمق، وسجل القرارات بالاستبدال والسياق، والخط الزمني بالفترة والنوع) بنجاح.');

    // ===================== 6. المزامنة بين جهازين =====================
    const syncRoot = path.join(base, 'Drive', 'Second-Brain-Sync');
    fs.mkdirSync(syncRoot, { recursive: true });
    const seed = path.join(base, 'seed', 'vault.aes256.json');
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    createVault(PASS, seed);
    const A = makeSyncDevice(base, 'Asus', syncRoot, seed);
    const B = makeSyncDevice(base, 'Mac', syncRoot, seed);
    const vA = unlockVault(PASS, A.vaultFile);
    const vB = unlockVault(PASS, B.vaultFile);
    const kA = deriveKnowledgeKey(vA.dataKey);
    const kB = deriveKnowledgeKey(vB.dataKey);
    assert.ok(kA.equals(kB), 'الجهازان يشتقّان مفتاح المعرفة نفسه');
    let clock = Date.parse('2026-11-22T12:00:00.000Z');
    const cycle = (ctx: SyncContext, v: typeof vA) => runSyncCycle(ctx, v, { now: (clock += 1000) });
    cycle(A, vA);
    cycle(B, vB);
    const kdirA = path.join(A.dataDir, 'knowledge');
    const kdirB = path.join(B.dataDir, 'knowledge');
    // الترحيل نفسه على الجهازين قبل أن يتزامنا: محتوى حتمي ← بلا تعارض
    const shared = [memoryEntry('MEM-S-1111', ['قرار مشترك'])];
    migrateSharedMemoryToKnowledge(kA, shared, kdirA);
    migrateSharedMemoryToKnowledge(kB, shared, kdirB);
    writeNode(kA, node({ id: 'K-DEC-A1', type: 'decision', title: 'قرار من أ' }), kdirA);
    cycle(A, vA);
    const rb = cycle(B, vB);
    cycle(A, vA);
    assert.equal(rb.conflicts, 0, 'الترحيل المتزامن بلا تعارض');
    assert.equal(listConflicts(B, vB.dataKey).length + listConflicts(A, vA.dataKey).length, 0);
    const gA = readKnowledgeGraph(kA, kdirA);
    const gB = readKnowledgeGraph(kB, kdirB);
    assert.equal(gB.nodes.get('K-DEC-A1')?.title, 'قرار من أ', 'العقدة وصلت إلى ب');
    assert.deepEqual([...gA.nodes.keys()].sort(), [...gB.nodes.keys()].sort(), 'الجهازان متطابقان');
    assert.equal(gB.unreadable, 0);
    assert.ok(!fs.readFileSync(listKnowledgeFiles(kdirB).find((f) => f.id === 'K-DEC-A1')!.file, 'utf8').includes('قرار من أ'), 'مختومة على ب أيضاً');
    // التعديل والحذف يصلان
    writeNode(kB, { ...gB.nodes.get('K-DEC-A1')!, status: 'superseded', updatedAt: '2026-11-22T13:00:00.000Z' }, kdirB);
    removeKnowledgeRecord('node', conversationNodeId('MEM-S-1111'), kdirB);
    cycle(B, vB);
    cycle(A, vA);
    const gA2 = readKnowledgeGraph(kA, kdirA);
    assert.equal(gA2.nodes.get('K-DEC-A1')?.status, 'superseded', 'التعديل وصل');
    assert.equal(gA2.nodes.has(conversationNodeId('MEM-S-1111')), false, 'الحذف وصل');
    // سجل معرفة تالف من الجهاز الآخر لا يُكتب
    fs.writeFileSync(path.join(kdirA, 'nodes', 'K-DEC-JUNK.enc.json'), '{"format":"second-brain-knowledge","version":1,"sealed":{"ivHex":"00","authTagHex":"00","cipherTextHex":"00"}}');
    const before = cycle(A, vA);
    cycle(B, vB);
    assert.equal(readKnowledgeGraph(kB, kdirB).nodes.has('K-DEC-JUNK'), false, 'الملف التالف لا يُنشر');
    assert.ok(before.warnings.every((w) => !/فشل/.test(w)), 'ولا يُفشل الدورة');
    passedChecks.push('اختبار مزامنة المعرفة بين جهازين (مفتاح واحد بلا مزامنة له، والترحيل المتزامن بلا تعارض، والإضافة والتعديل والحذف تصل، ومختومة على الجهاز الآخر، والملف التالف لا يُنشر ولا يُفشل الدورة) بنجاح.');

    // ===================== 7. النسخ الاحتياطية والترحيل عند الفتح =====================
    resetSessionStateForTests();
    const real = ensureTestVault();
    const realDir = resolveKnowledgeDir();
    // سجل ذاكرة خاص بهذا الفحص، فلا يعتمد على ما كتبته حزم أخرى
    const own = recordSharedAIMemory({ sourceAI: 'manual', projectId: 'second-brain-test-project', title: 'سجل فحص المعرفة', summaryAr: 'ملخص للفحص', keyDecisionsAr: ['قرار الفحص'] }, path.join(base, 'obsidian-own'));
    const before7 = listKnowledgeFiles(realDir).length;
    const memories = querySharedAIMemory();
    assert.ok(memories.some((m) => m.id === own.id));
    const family = unlockVault(real.emergencyKey);
    openVaultSession(family);
    assert.equal(listKnowledgeFiles(realDir).length, before7, 'جلسة العائلة لا ترحّل ولا تكتب معرفة');
    closeVaultSession();
    openVaultSession(unlockVault(real.masterPassword));
    const realKk = deriveKnowledgeKey(unlockVault(real.masterPassword).dataKey);
    const realGraph = readKnowledgeGraph(realKk, realDir);
    for (const m of memories) assert.ok(realGraph.nodes.has(conversationNodeId(m.id)), `فتح القائد رحّل ${m.id}`);
    assert.equal(realGraph.nodes.get(decisionNodeId(own.id, 1))?.title, 'قرار الفحص');
    // حدود المفاتيح: المفتاح العائلي لا يفتح أي ملف معرفة
    const fk = unlockVault(real.masterPassword).familyKey!;
    for (const f of listKnowledgeFiles(realDir)) assert.throws(() => openWithKey(JSON.parse(fs.readFileSync(f.file, 'utf8')).sealed, fk), `المفتاح العائلي فتح ${f.id}`);
    closeVaultSession();
    resetSessionStateForTests();
    const bk = createEncryptedSystemBackup(unlockVault(real.masterPassword), { outputDir: path.join(base, 'backups'), extraOutputDir: '' });
    const full = openEncryptedBackup(bk.backupFilePath, real.masterPassword);
    const knowEntries = Object.keys(full.filesMap).filter((k) => k.includes('/knowledge/'));
    assert.equal(knowEntries.length, listKnowledgeFiles(realDir).length, 'المعرفة كلها في النسخة الكاملة');
    assert.ok(knowEntries.every(isExpectedBackupEntry), 'وفحص هيكل النسخة يقبلها');
    if (memories.length) assert.ok(knowEntries.length > 0);
    const famPayload = openEncryptedBackup(bk.backupFilePath, real.emergencyKey);
    assert.equal(Object.keys(famPayload.filesMap).filter((k) => k.includes('/knowledge/')).length, 0, 'ولا شيء منها في الحمولة العائلية');
    assert.equal(isExpectedBackupEntry('Second-Brain-System/data/knowledge/nodes/../evil.enc.json'), false);
    assert.equal(isExpectedBackupEntry('Second-Brain-System/data/knowledge/nodes/K-X.cmd'), false);
    passedChecks.push('اختبار المعرفة مع الجلسات والنسخ (فتح القائد يرحّل كل سجلات الذاكرة، والمفتاح العائلي لا يفتح أي ملف معرفة، وجلسة العائلة لا تكتب شيئاً، والنسخة الكاملة تحمل كل ملفات المعرفة ويقبلها فحص الهيكل، والحمولة العائلية بلا معرفة) بنجاح.');
  } finally {
    resetSessionStateForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
  return passedChecks;
}
