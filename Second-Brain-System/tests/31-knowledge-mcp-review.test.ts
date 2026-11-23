/**
 * ============================================================================
 * الملف: tests/31-knowledge-mcp-review.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المعرفة مع MCP وقائمة المراجعة (المرحلة 3.1، الإصدار 4.0.1):
 *               - النسخة المحلية من مفتاح المعرفة: تُكتب عند فتح القائد، والتعطيل يحذفها، والتالفة تُرفض،
 *                 ولا تدخل المزامنة ولا النسخ.
 *               - قائمة المراجعة: سجل MCP ينشئ عقدة محادثة واقتراحات، لا عُقد قرار. الاعتماد يكتبها، والرفض لا،
 *                 ولا يُعاد اقتراح ما حُسم، والقرار يصل إلى الجهاز الآخر.
 *               - أدوات MCP: التسجيل والبحث في المعرفة وسجل القرارات، وبلا النسخة المحلية رسالة واضحة.
 *               - المسارات: الحالة والمراجعة والقرار والنسخة المحلية عبر HTTP.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { closeVaultSession, openVaultSession, resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { createEncryptedSystemBackup, openEncryptedBackup } from '../src/features/family-emergency/backup-service.ts';
import { decideReviewItem, isKnowledgeDeviceKeyEnabled, readDeviceKnowledgeKey, resolveDeviceKeyFile, setKnowledgeDeviceKeyEnabled, syncKnowledgeDeviceKey } from '../src/features/knowledge/knowledge-access.ts';
import { conversationNodeId, decisionNodeId, migrateSharedMemoryToKnowledge, reviewItemId } from '../src/features/knowledge/knowledge-migration.ts';
import { deriveKnowledgeKey, listKnowledgeFiles, readKnowledgeGraph, resolveKnowledgeDir } from '../src/features/knowledge/knowledge-store.ts';
import { edgeIdFor, validateReviewItem, type KnowledgeNode } from '../src/features/knowledge/knowledge-types.ts';
import { readLocalRecords } from '../src/features/sync/records.ts';
import { runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import type { SyncContext } from '../src/features/sync/sync-context.ts';
import { createVault, unlockVault } from '../src/features/vault/vault-manager.ts';
import { handleMcpJsonRpcRequest } from '../src/tools/mcp-memory-server.ts';
import type { SharedAIMemoryEntry } from '../src/shared/types.ts';
import { postJson, rawRequest } from './06-security.test.ts';
import { ensureTestVault, writeFixtureFile } from './test-environment.ts';

const PASS = 'Knowledge-Review-Test-Pass-01';
const T0 = '2026-11-23T09:00:00.000Z';

function tool(id: number, name: string, args: Record<string, unknown>): { isError?: boolean; text: string } {
  const r = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: r.result.isError, text: r.result.content[0].text };
}

function reviewEntry(id: string, decisions: string[]): SharedAIMemoryEntry {
  return { id, sourceAI: 'claude-code', projectId: 'proj-r', title: `جلسة ${id}`, summaryAr: 'ملخص', keyDecisionsAr: decisions, createdAt: T0, knowledgeReview: true };
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
 * Hint بالعربي: دالة تشغيل اختبارات المعرفة مع MCP وقائمة المراجعة وإرجاع نتائج الفحص.
 */
export async function runKnowledgeMcpReviewTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const base = path.join(loadSystemConfig().paths.rootDir, 'knowledge-review-sim');
  fs.mkdirSync(base, { recursive: true });
  resetSessionStateForTests();
  try {
    // ===================== 1. النسخة المحلية من مفتاح المعرفة =====================
    const dir = path.join(base, 'k1');
    const { vault } = createVault(PASS, path.join(base, 'vault', 'vault.aes256.json'));
    const kk = deriveKnowledgeKey(vault.dataKey);
    assert.equal(isKnowledgeDeviceKeyEnabled(), true, 'مفعّلة افتراضياً (قرار القائد)');
    assert.equal(readDeviceKnowledgeKey(dir), null);
    assert.equal(syncKnowledgeDeviceKey(kk, dir), 'written');
    assert.ok(readDeviceKnowledgeKey(dir)?.equals(kk));
    assert.equal(syncKnowledgeDeviceKey(kk, dir), 'unchanged', 'لا تُعاد كتابتها بلا تغيير');
    if (process.platform !== 'win32') assert.equal(fs.statSync(resolveDeviceKeyFile(dir)).mode & 0o077, 0, 'صلاحية 600 على الماك');
    const raw = JSON.parse(fs.readFileSync(resolveDeviceKeyFile(dir), 'utf8'));
    assert.ok(!JSON.stringify(raw).includes(vault.dataKey.toString('hex')), 'لا تحمل مفتاح البيانات');
    fs.writeFileSync(resolveDeviceKeyFile(dir), JSON.stringify({ ...raw, keyHex: 'a'.repeat(64) }));
    assert.equal(readDeviceKnowledgeKey(dir), null, 'المعدّلة (البصمة لا تطابق) تُرفض');
    assert.equal(syncKnowledgeDeviceKey(kk, dir), 'written', 'وتُصحَّح عند الفتح التالي');
    assert.equal(listKnowledgeFiles(dir).length, 0, 'ليست من سجلات المعرفة (لا مزامنة ولا نسخ)');
    setKnowledgeDeviceKeyEnabled(false, null, dir);
    assert.equal(fs.existsSync(resolveDeviceKeyFile(dir)), false, 'التعطيل يحذفها فوراً');
    assert.equal(readDeviceKnowledgeKey(dir), null);
    assert.equal(syncKnowledgeDeviceKey(kk, dir), 'disabled', 'ولا تُكتب ثانية وهي معطّلة');
    setKnowledgeDeviceKeyEnabled(true, kk, dir);
    assert.ok(readDeviceKnowledgeKey(dir)?.equals(kk), 'إعادة التفعيل تكتبها');
    passedChecks.push('اختبار النسخة المحلية من مفتاح المعرفة (مفعّلة افتراضياً، وتُكتب مرة، وبلا مفتاح البيانات، والمعدّلة تُرفض وتُصحَّح، وليست من سجلات المزامنة، والتعطيل يحذفها ويمنع كتابتها، وإعادة التفعيل) بنجاح.');

    // ===================== 2. قائمة المراجعة =====================
    const conv = conversationNodeId('MEM-R-1');
    const dec1 = decisionNodeId('MEM-R-1', 1);
    const node = (id: string): KnowledgeNode => ({ id, type: 'decision', title: 'x', body: '', projectId: null, source: 'manual', status: 'active', confidence: 'confirmed', createdAt: T0, updatedAt: T0 });
    assert.throws(
      () => validateReviewItem({ id: 'R-X', proposal: { node: node('K-A'), edges: [{ id: edgeIdFor('related_to', 'K-B', 'K-C'), type: 'related_to', from: 'K-B', to: 'K-C', createdAt: T0 }] }, reasonAr: '', createdAt: T0, status: 'pending' }),
      /لا تمسّ/,
      'لا يُدسّ في الاقتراح ربط بين عُقد أخرى'
    );
    const r1 = migrateSharedMemoryToKnowledge(kk, [reviewEntry('MEM-R-1', ['اعتماد Kotlin للجوال', 'رفض Flutter'])], dir);
    assert.equal(r1.createdReviews, 2);
    let g = readKnowledgeGraph(kk, dir);
    assert.ok(g.nodes.has(conv), 'عقدة المحادثة مباشرة');
    assert.equal(g.nodes.has(dec1), false, 'لا عقدة قرار بلا موافقة');
    assert.equal(g.edges.size, 0);
    assert.equal(g.reviews.get(reviewItemId('MEM-R-1', 1))?.status, 'pending');
    assert.equal(migrateSharedMemoryToKnowledge(kk, [reviewEntry('MEM-R-1', ['اعتماد Kotlin للجوال', 'رفض Flutter'])], dir).createdReviews, 0, 'لا تكرار');
    decideReviewItem(kk, reviewItemId('MEM-R-1', 1), 'approve', dir);
    decideReviewItem(kk, reviewItemId('MEM-R-1', 2), 'reject', dir);
    g = readKnowledgeGraph(kk, dir);
    assert.equal(g.nodes.get(dec1)?.title, 'اعتماد Kotlin للجوال', 'الاعتماد يكتب العقدة');
    assert.ok(g.edges.has(edgeIdFor('decided_in', dec1, conv)), 'وعلاقتها بالمحادثة');
    assert.equal(g.nodes.has(decisionNodeId('MEM-R-1', 2)), false, 'المرفوض لا يدخل');
    assert.equal(g.reviews.get(reviewItemId('MEM-R-1', 2))?.status, 'rejected', 'ويبقى بحالته');
    assert.ok(g.reviews.get(reviewItemId('MEM-R-1', 2))?.decidedAt);
    assert.throws(() => decideReviewItem(kk, reviewItemId('MEM-R-1', 1), 'reject', dir), /اعتُمد/, 'لا يُحسم مرتين');
    assert.throws(() => decideReviewItem(kk, 'R-NONE', 'approve', dir), /غير موجود/);
    removeConversation(dir, conv);
    assert.equal(migrateSharedMemoryToKnowledge(kk, [reviewEntry('MEM-R-1', ['اعتماد Kotlin للجوال', 'رفض Flutter'])], dir).createdReviews, 0, 'المحسوم لا يُقترح ثانية حتى لو أُعيد الترحيل');
    passedChecks.push('اختبار قائمة المراجعة (السجل الجديد ينشئ عقدة محادثة واقتراحات لا عُقد قرار، ولا ربط مدسوس، ولا تكرار، والاعتماد يكتب العقدة وعلاقتها، والرفض لا، ولا حسم مرتين، والمحسوم لا يُقترح ثانية) بنجاح.');

    // ===================== 3. أدوات MCP =====================
    const realDir = resolveKnowledgeDir();
    const real = ensureTestVault();
    const realKk = deriveKnowledgeKey(unlockVault(real.masterPassword).dataKey);
    setKnowledgeDeviceKeyEnabled(false);
    const blocked = tool(1, 'second_brain_search_knowledge', { query: 'Kotlin' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /المعرفة غير متاحة/, 'بلا النسخة المحلية: رسالة واضحة');
    const offline = JSON.parse(tool(2, 'second_brain_record_shared_memory', { sourceAI: 'claude-code', projectId: 'proj-m', title: 'جلسة بلا مفتاح', summaryAr: 'ملخص', keyDecisionsAr: ['قرار أثناء القفل'] }).text);
    assert.equal(offline.ok, true, 'الذاكرة تُحفظ دائماً');
    assert.equal(offline.knowledge.added, false, 'والمعرفة عند الفتح التالي');
    setKnowledgeDeviceKeyEnabled(true, realKk);
    openVaultSession(unlockVault(real.masterPassword));
    closeVaultSession();
    assert.equal(readKnowledgeGraph(realKk, realDir).reviews.get(reviewItemId(offline.id, 1))?.status, 'pending', 'فتح القائد حوّل قرار السجل إلى اقتراح');
    const online = JSON.parse(tool(3, 'second_brain_record_shared_memory', { sourceAI: 'antigravity-gemini', projectId: 'proj-m', title: 'جلسة اختيار قاعدة البيانات', summaryAr: 'ناقشنا SQLite و PostgreSQL', keyDecisionsAr: ['نعتمد PostgreSQL للإنتاج'] }).text);
    assert.equal(online.knowledge.added, true, 'بالنسخة المحلية: تُضاف فوراً');
    assert.equal(online.knowledge.pendingReview, 1);
    const found = JSON.parse(tool(4, 'second_brain_search_knowledge', { query: 'قاعدة البيانات', projectId: 'proj-m' }).text) as Array<{ id: string; type: string }>;
    assert.deepEqual(found.map((f) => [f.id, f.type]), [[conversationNodeId(online.id), 'conversation']], 'البحث يجد المحادثة، والقرار المنتظر ليس في المعرفة بعد');
    assert.deepEqual(JSON.parse(tool(5, 'second_brain_get_decision_log', { projectId: 'proj-m' }).text), [], 'لا قرار قبل الموافقة');
    decideReviewItem(realKk, reviewItemId(online.id, 1), 'approve', realDir);
    const log = JSON.parse(tool(6, 'second_brain_get_decision_log', { projectId: 'proj-m' }).text) as Array<{ title: string; decidedIn: Array<{ id: string }> }>;
    assert.equal(log[0].title, 'نعتمد PostgreSQL للإنتاج');
    assert.equal(log[0].decidedIn[0].id, conversationNodeId(online.id), 'مع المحادثة التي اتُّخذ فيها');
    const withNeighbors = JSON.parse(tool(7, 'second_brain_search_knowledge', { query: 'PostgreSQL', type: 'decision' }).text) as Array<{ neighbors: Array<{ relation: string }> }>;
    assert.equal(withNeighbors[0].neighbors[0].relation, 'decided_in', 'النتيجة بجيرانها');
    const bad = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'second_brain_search_knowledge', arguments: { query: 'x', type: 'nonsense' } } }) as { error?: { code: number } };
    assert.equal(bad.error?.code, -32602, 'نوع غير معروف ← خطأ معاملات JSON-RPC');
    passedChecks.push('اختبار أدوات MCP على المعرفة (بلا النسخة المحلية رسالة واضحة والذاكرة تُحفظ ثم تُحوَّل عند الفتح، وبها تُضاف المحادثة فوراً والقرار اقتراحاً، والبحث وسجل القرارات بعد الموافقة مع المحادثة والجيران، ورفض المعاملات غير الصالحة) بنجاح.');

    // ===================== 4. المسارات =====================
    const server = await startSecondBrainDesktopServer(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const cookie = String((await postJson(port, '/api/vault/unlock', { key: real.masterPassword })).headers['set-cookie'] ?? '').split(';')[0];
      const status = JSON.parse((await rawRequest(port, { path: '/api/knowledge/status', headers: { Cookie: cookie } })).body) as { nodes: number; pendingReview: number; deviceKey: { enabled: boolean; present: boolean } };
      assert.ok(status.nodes >= 3 && status.pendingReview >= 1);
      assert.deepEqual(status.deviceKey, { enabled: true, present: true, dirExists: true } as never);
      const review = JSON.parse((await rawRequest(port, { path: '/api/knowledge/review', headers: { Cookie: cookie } })).body) as { items: Array<{ id: string; node: { typeAr: string }; links: Array<{ relationAr: string }> }> };
      const item = review.items.find((i) => i.id === reviewItemId(offline.id, 1))!;
      assert.equal(item.node.typeAr, 'قرار');
      assert.equal(item.links[0].relationAr, 'اتُّخذ في محادثة');
      assert.equal((await postJson(port, '/api/knowledge/review/decide', { id: '../x', decision: 'approve' }, cookie)).status, 400);
      assert.equal((await postJson(port, '/api/knowledge/review/decide', { id: item.id, decision: 'maybe' }, cookie)).status, 400);
      const decided = await postJson(port, '/api/knowledge/review/decide', { id: item.id, decision: 'reject' }, cookie);
      assert.equal(decided.status, 200, decided.body);
      assert.equal((await postJson(port, '/api/knowledge/review/decide', { id: item.id, decision: 'approve' }, cookie)).status, 400, 'المحسوم لا يُحسم ثانية');
      assert.equal((await postJson(port, '/api/knowledge/device-key', { enabled: 'yes' }, cookie)).status, 400);
      assert.equal((await postJson(port, '/api/knowledge/device-key', { enabled: false }, cookie)).status, 200);
      assert.equal(fs.existsSync(resolveDeviceKeyFile()), false, 'التعطيل من الواجهة يحذفها');
      assert.equal((await postJson(port, '/api/knowledge/device-key', { enabled: true }, cookie)).status, 200);
      assert.ok(readDeviceKnowledgeKey()?.equals(realKk), 'والتفعيل يكتبها فوراً');
    } finally {
      resetSessionStateForTests();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // النسخة المحلية لا تدخل النسخ الاحتياطية، والاقتراحات تدخلها
    const bk = openEncryptedBackup(createEncryptedSystemBackup(unlockVault(real.masterPassword), { outputDir: path.join(base, 'backups'), extraOutputDir: '' }).backupFilePath, real.masterPassword);
    assert.ok(!Object.keys(bk.filesMap).some((k) => k.endsWith('device-key.json')), 'النسخة المحلية ليست في النسخة الاحتياطية');
    assert.ok(Object.keys(bk.filesMap).some((k) => /\/knowledge\/review\/R-/.test(k)), 'والاقتراحات فيها');
    passedChecks.push('اختبار مسارات المعرفة (الحالة والأعداد والنسخة المحلية، والمراجعة بالنوع والعلاقة بالعربية، ورفض المعرّف والقرار غير الصالحين، ولا حسم مرتين، والنسخة المحلية تُعطَّل وتُفعَّل من الواجهة، ولا تدخل النسخ الاحتياطية) بنجاح.');

    // ===================== 5. القرار يصل إلى الجهاز الآخر =====================
    const syncRoot = path.join(base, 'Drive', 'Second-Brain-Sync');
    fs.mkdirSync(syncRoot, { recursive: true });
    const seed = path.join(base, 'seed', 'vault.aes256.json');
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    createVault(PASS, seed);
    const A = makeSyncDevice(base, 'Asus', syncRoot, seed);
    const B = makeSyncDevice(base, 'Mac', syncRoot, seed);
    const vA = unlockVault(PASS, A.vaultFile);
    const vB = unlockVault(PASS, B.vaultFile);
    const k = deriveKnowledgeKey(vA.dataKey);
    let clock = Date.parse('2026-11-23T12:00:00.000Z');
    const cycle = (ctx: SyncContext, v: typeof vA) => runSyncCycle(ctx, v, { now: (clock += 1000) });
    cycle(A, vA);
    cycle(B, vB);
    const kA = path.join(A.dataDir, 'knowledge');
    const kB = path.join(B.dataDir, 'knowledge');
    syncKnowledgeDeviceKey(k, kA);
    migrateSharedMemoryToKnowledge(k, [reviewEntry('MEM-SYNC-1', ['قرار يُعتمد على الماك'])], kA);
    assert.ok(![...readLocalRecords(A, vA).keys()].some((key) => key.includes('device-key')), 'النسخة المحلية لا تُنشر');
    cycle(A, vA);
    cycle(B, vB);
    assert.equal(readKnowledgeGraph(k, kB).reviews.get(reviewItemId('MEM-SYNC-1', 1))?.status, 'pending', 'الاقتراح وصل إلى ب');
    assert.equal(fs.existsSync(resolveDeviceKeyFile(kB)), false, 'والنسخة المحلية لم تصل');
    decideReviewItem(k, reviewItemId('MEM-SYNC-1', 1), 'approve', kB);
    cycle(B, vB);
    cycle(A, vA);
    const gA = readKnowledgeGraph(k, kA);
    assert.equal(gA.reviews.get(reviewItemId('MEM-SYNC-1', 1))?.status, 'approved', 'الاعتماد على ب وصل إلى أ');
    assert.equal(gA.nodes.get(decisionNodeId('MEM-SYNC-1', 1))?.title, 'قرار يُعتمد على الماك', 'ومعه العقدة');
    passedChecks.push('اختبار مزامنة قائمة المراجعة (الاقتراح يصل إلى الجهاز الآخر، والاعتماد هناك يعود بالعقدة، والنسخة المحلية من المفتاح لا تُنشر أبداً) بنجاح.');
  } finally {
    setKnowledgeDeviceKeyEnabled(true);
    resetSessionStateForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
  return passedChecks;
}

/** حذف عقدة المحادثة لمحاكاة ترحيل يُعاد */
function removeConversation(dir: string, id: string): void {
  fs.rmSync(path.join(dir, 'nodes', `${id}.enc.json`), { force: true });
}
