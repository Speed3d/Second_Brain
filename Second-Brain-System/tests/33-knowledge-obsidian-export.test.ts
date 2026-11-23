/**
 * ============================================================================
 * الملف: tests/33-knowledge-obsidian-export.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات تصدير المعرفة إلى Obsidian (المرحلة 3.1، الإصدار 4.0.3):
 *               - للمشاريع المختارة فقط، وبلا الأشخاص والعقود والفواتير أبداً.
 *               - ملاحظة لكل عقدة بروابط [[...]] إلى جيرانها المُصدَّرين، وفهرس للمشروع.
 *               - حتمي (لا يُكتب ما لم يتغيّر)، وما لم يعد يُولَّد يُحذف، والملاحظة اليدوية لا تُمسّ.
 *               - الإيقاف يحذف المُصدَّر، والخيار يُزامَن مع المشروع، والتعارض فيها يُحسم بصمت.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { startSecondBrainDesktopServer } from '../src/features/dashboard-app/desktop-server.ts';
import { resetSessionStateForTests } from '../src/features/dashboard-app/session-manager.ts';
import { exportFileName, exportKnowledgeToObsidian, KNOWLEDGE_EXPORT_DIR } from '../src/features/knowledge/obsidian-export.ts';
import { deriveKnowledgeKey, readKnowledgeGraph, removeKnowledgeRecord, resolveKnowledgeDir, writeEdge, writeNode } from '../src/features/knowledge/knowledge-store.ts';
import { edgeIdFor, type KnowledgeNode } from '../src/features/knowledge/knowledge-types.ts';
import { getProjectFolderName } from '../src/features/project-indexer/obsidian-sync.ts';
import { isGeneratedProjectDoc } from '../src/features/sync/records.ts';
import { unlockVault } from '../src/features/vault/vault-manager.ts';
import type { WatchedProjectConfig } from '../src/shared/types.ts';
import { postJson } from './06-security.test.ts';
import { ensureTestVault } from './test-environment.ts';

const T = (d: number) => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;

function node(id: string, type: KnowledgeNode['type'], title: string, projectId: string | null, d = 10, extra: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return { id, type, title, body: `${title}: التفاصيل`, projectId, source: 'manual', status: 'active', confidence: 'confirmed', createdAt: T(d), updatedAt: T(d), ...extra };
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات تصدير المعرفة إلى Obsidian وإرجاع نتائج الفحص.
 */
export async function runKnowledgeObsidianExportTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const base = path.join(config.paths.rootDir, 'export-sim');
  fs.mkdirSync(base, { recursive: true });
  try {
    // ===================== 1. ما يُصدَّر وكيف =====================
    const real = ensureTestVault();
    const kk = deriveKnowledgeKey(unlockVault(real.masterPassword).dataKey);
    const kdir = path.join(base, 'knowledge');
    const obs = path.join(base, 'Obsidian-Vault');
    const pA: WatchedProjectConfig = { id: 'proj-a', name: 'مشروع أ', path: base, descriptionAr: '', wifeSummaryAr: '', monthlyIncome: '', billingNotes: '', knowledgeExport: true };
    const pB: WatchedProjectConfig = { ...pA, id: 'proj-b', name: 'مشروع ب', knowledgeExport: undefined };
    const conv = node('K-CONV-X1', 'conversation', 'جلسة تصميم الأمان', 'proj-a', 1);
    const oldDec = node('K-DEC-X1', 'decision', 'نعتمد SQLite', 'proj-a', 2, { status: 'superseded' });
    const newDec = node('K-DEC-X2', 'decision', 'نعتمد PostgreSQL: للتوسّع / الإنتاج', 'proj-a', 3);
    const person = node('K-PERS-X1', 'person', 'أحمد المحاسب', 'proj-a', 4);
    const invoice = node('K-INVO-X1', 'invoice', 'فاتورة الاستضافة', 'proj-a', 5);
    const other = node('K-DEC-Y1', 'decision', 'قرار مشروع ب', 'proj-b', 6);
    for (const n of [conv, oldDec, newDec, person, invoice, other]) writeNode(kk, n, kdir);
    for (const e of [
      { type: 'decided_in' as const, from: newDec.id, to: conv.id },
      { type: 'supersedes' as const, from: newDec.id, to: oldDec.id },
      { type: 'related_to' as const, from: newDec.id, to: person.id },
    ]) writeEdge(kk, { id: edgeIdFor(e.type, e.from, e.to), ...e, createdAt: T(3) }, kdir);
    const g = readKnowledgeGraph(kk, kdir);
    const r1 = exportKnowledgeToObsidian(g, [pA, pB], obs);
    assert.deepEqual(r1, { projects: 1, written: 4, unchanged: 0, removed: 0 }, 'ثلاث عُقد غير حساسة وفهرس');
    const dirA = path.join(obs, KNOWLEDGE_EXPORT_DIR, getProjectFolderName(pA));
    const files = fs.readdirSync(dirA).sort();
    assert.equal(files.length, 4);
    assert.equal(fs.existsSync(path.join(obs, KNOWLEDGE_EXPORT_DIR, getProjectFolderName(pB))), false, 'المشروع غير المختار لا يُصدَّر');
    const all = files.map((f) => fs.readFileSync(path.join(dirA, f), 'utf8')).join('\n');
    assert.ok(!all.includes('أحمد المحاسب') && !all.includes('فاتورة الاستضافة'), 'الأشخاص والفواتير لا تُصدَّر ولا تُذكر حتى في الروابط');
    const newNote = fs.readFileSync(path.join(dirA, `${exportFileName(newDec)}.md`), 'utf8');
    assert.ok(!exportFileName(newDec).includes('/') && !exportFileName(newDec).includes(':'), 'اسم الملف بلا محارف ممنوعة');
    assert.ok(newNote.includes(`- استبدل القرار: [[${exportFileName(oldDec)}]]`), 'رابط الاستبدال');
    assert.ok(newNote.includes(`- اتُّخذ في محادثة: [[${exportFileName(conv)}]]`), 'رابط المحادثة');
    assert.ok(fs.readFileSync(path.join(dirA, `${exportFileName(oldDec)}.md`), 'utf8').includes(`- ← استبدل القرار: [[${exportFileName(newDec)}]]`), 'والاتجاه المعاكس على القديم');
    assert.ok(fs.readFileSync(path.join(dirA, '00-فهرس المعرفة.md'), 'utf8').includes(`[[${exportFileName(oldDec)}]] (مُستبدَل)`), 'الفهرس يذكر الحالة');
    // المستودع عام: المعرفة المُصدَّرة لا تُرفع إلى GitHub أبداً
    const gitignore = fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
    assert.ok(gitignore.split(/\r?\n/).includes(`Obsidian-Vault/${KNOWLEDGE_EXPORT_DIR}/`), '.gitignore يستبعد المعرفة المُصدَّرة');
    passedChecks.push('اختبار ما يُصدَّر إلى Obsidian (المشاريع المختارة فقط، ولا أشخاص ولا فواتير ولو في الروابط، وملاحظة لكل عقدة بروابط الاستبدال والمحادثة في الاتجاهين، وفهرس بالحالة، وأسماء ملفات آمنة، و .gitignore يستبعد المُصدَّر من المستودع العام) بنجاح.');

    // ===================== 2. الحتمية والحذف والملاحظة اليدوية =====================
    const before = files.map((f) => fs.readFileSync(path.join(dirA, f), 'utf8'));
    const r2 = exportKnowledgeToObsidian(readKnowledgeGraph(kk, kdir), [pA, pB], obs);
    assert.deepEqual({ w: r2.written, u: r2.unchanged }, { w: 0, u: 4 }, 'لا يُكتب ما لم يتغيّر');
    const otherObs = path.join(base, 'Obsidian-Other');
    exportKnowledgeToObsidian(readKnowledgeGraph(kk, kdir), [pA, pB], otherObs);
    const dirOther = path.join(otherObs, KNOWLEDGE_EXPORT_DIR, getProjectFolderName(pA));
    assert.deepEqual(fs.readdirSync(dirOther).sort().map((f) => fs.readFileSync(path.join(dirOther, f), 'utf8')), before, 'الجهاز الآخر يكتب الملاحظات نفسها حرفياً');
    const manual = path.join(dirA, 'ملاحظتي اليدوية.md');
    fs.writeFileSync(manual, '# ملاحظة كتبها القائد');
    const sameName = path.join(dirA, `${exportFileName(newDec)}.md`);
    removeKnowledgeRecord('node', oldDec.id, kdir);
    const r3 = exportKnowledgeToObsidian(readKnowledgeGraph(kk, kdir), [pA, pB], obs);
    assert.equal(r3.removed, 1, 'ما لم يعد يُولَّد يُحذف');
    assert.equal(fs.existsSync(manual), true, 'الملاحظة اليدوية لا تُمسّ');
    assert.ok(!fs.readFileSync(sameName, 'utf8').includes('استبدل القرار: [['), 'الرابط إلى المحذوف اختفى');
    fs.writeFileSync(sameName, '# كتبتها بيدي فوق الملف');
    exportKnowledgeToObsidian(readKnowledgeGraph(kk, kdir), [pA, pB], obs);
    assert.equal(fs.readFileSync(sameName, 'utf8'), '# كتبتها بيدي فوق الملف', 'ملف بلا علامة التصدير لا يُكتب فوقه');
    // الإيقاف
    const r4 = exportKnowledgeToObsidian(readKnowledgeGraph(kk, kdir), [{ ...pA, knowledgeExport: undefined }, pB], obs);
    assert.ok(r4.removed >= 2, 'الإيقاف يحذف المُصدَّر');
    assert.deepEqual(fs.readdirSync(dirA).sort(), [path.basename(sameName), 'ملاحظتي اليدوية.md'].sort(), 'ولا يبقى إلا ما كتبه القائد');
    assert.equal(isGeneratedProjectDoc(`obs:${KNOWLEDGE_EXPORT_DIR}/${getProjectFolderName(pA)}/x.md`), true, 'تعارض المزامنة فيها يُحسم بصمت (حتمية)');
    passedChecks.push('اختبار حتمية التصدير (لا يُكتب ما لم يتغيّر، والجهاز الآخر يكتب الملاحظات نفسها حرفياً، وما لم يعد يُولَّد يُحذف، والملاحظة اليدوية والملف بلا العلامة لا يُمسّان، والإيقاف يحذف المُصدَّر، والتعارض يُحسم بصمت) بنجاح.');

    // ===================== 3. المسار والخيار المحفوظ مع المشروع =====================
    resetSessionStateForTests();
    const server = await startSecondBrainDesktopServer(0);
    const port = (server.address() as AddressInfo).port;
    const project = loadSystemConfig().watchedProjects[0];
    const realDir = path.join(config.paths.obsidianVaultDir, KNOWLEDGE_EXPORT_DIR, getProjectFolderName(project));
    try {
      const realKk = deriveKnowledgeKey(unlockVault(real.masterPassword).dataKey);
      writeNode(realKk, node('K-DEC-EXP-1', 'decision', 'قرار للتصدير', project.id, 7), resolveKnowledgeDir());
      const cookie = String((await postJson(port, '/api/vault/unlock', { key: real.masterPassword })).headers['set-cookie'] ?? '').split(';')[0];
      assert.equal(loadSystemConfig().watchedProjects[0].knowledgeExport, undefined, 'معطّل افتراضياً');
      assert.equal(fs.existsSync(realDir), false, 'ولا ملفات قبل التفعيل');
      assert.equal((await postJson(port, '/api/knowledge/export', { projectId: project.id, enabled: 'yes' }, cookie)).status, 400);
      assert.equal((await postJson(port, '/api/knowledge/export', { projectId: 'no-such', enabled: true }, cookie)).status, 404);
      const on = await postJson(port, '/api/knowledge/export', { projectId: project.id, enabled: true }, cookie);
      assert.equal(on.status, 200, on.body);
      assert.equal(loadSystemConfig().watchedProjects[0].knowledgeExport, true, 'الخيار يُحفظ مع المشروع (فيُزامَن)');
      assert.ok(fs.existsSync(path.join(realDir, `${exportFileName(node('K-DEC-EXP-1', 'decision', 'قرار للتصدير', project.id))}.md`)), 'صُدّر فوراً');
      const off = await postJson(port, '/api/knowledge/export', { projectId: project.id, enabled: false }, cookie);
      assert.equal(off.status, 200);
      assert.equal(loadSystemConfig().watchedProjects[0].knowledgeExport, undefined);
      assert.equal(fs.existsSync(realDir), false, 'الإيقاف يحذف المجلد المُصدَّر');
    } finally {
      removeKnowledgeRecord('node', 'K-DEC-EXP-1', resolveKnowledgeDir());
      resetSessionStateForTests();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    passedChecks.push('اختبار مسار التصدير (معطّل افتراضياً، ورفض القيمة والمشروع غير الصالحين، والتفعيل يحفظ الخيار مع المشروع ويصدّر فوراً، والإيقاف يحذف المجلد) بنجاح.');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return passedChecks;
}
