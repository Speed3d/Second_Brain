/**
 * ============================================================================
 * الملف: tests/16-multi-writer-sync.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات المزامنة متعددة الكتابة (2.0) بمحاكاة 3 أجهزة ومجلد Google Drive وهمي،
 *               بالسيناريوهات التي طلبها القائد (docs/11، الموضوع 1، و docs/12 البند 1.5):
 *               الترحيل من 1.9 بلا تعارضات وهمية، الكتابة من الأجهزة الثلاثة في الوقت نفسه، تعارض السجل نفسه،
 *               تعارض سرّ بلا فائز تلقائي، حذف مقابل تعديل، ساعة جهاز متقدمة، فشل الدمج في منتصفه والتراجع،
 *               دفعة لم يكتمل تنزيلها، جهاز بلا اتصال يعود، السلة والاسترجاع والتفريغ بعد 30 يوماً،
 *               تغيير كلمة المرور، الضغط وإقلاع جهاز جديد، حذف كل جهاز لملفاته فقط، الوثائق المولّدة، وتمرين الاستعادة.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { appendConversationTurn, resolveConversationsDir } from '../src/features/conversations/conversation-store.ts';
import { createEncryptedSystemBackup } from '../src/features/family-emergency/backup-service.ts';
import { isGeneratedDocsOwner } from '../src/features/sync/code-ownership.ts';
import { hlcCompare, hlcParse, hlcReceive, hlcTick, hlcToString } from '../src/features/sync/hlc.ts';
import { applyRecordWrites, normalizeObsidianFileNames, readLocalRecords } from '../src/features/sync/records.ts';
import { bootstrapFromSnapshotV2, createSnapshotV2, pruneOwnSyncFiles, resolveConflict, restoreFromTrash, runSyncCycle } from '../src/features/sync/multi-writer-sync.ts';
import { acquireLease, type SyncContext } from '../src/features/sync/sync-context.ts';
import { publishSnapshot } from '../src/features/sync/snapshot-sync.ts';
import { compareVv, listConflicts, listTrash, purgeTrash, readSyncIndex, removeTrashEntry } from '../src/features/sync/sync-store.ts';
import { changeMasterPassword, unlockVault, upsertVaultSecret, type UnlockedVault } from '../src/features/vault/vault-manager.ts';
import { removePathSync } from '../src/shared/file-helpers.ts';
import { checkRestoredFiles, describeBackupAge, findBackupCandidates, runRestoreDrill } from '../src/tools/restore-drill.ts';
import { ensureTestVault, TEST_MASTER_PASSWORD, writeFixtureFile } from './test-environment.ts';

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const exists = (file: string): boolean => fs.existsSync(file);

function makeDevice(baseDir: string, name: string, syncRoot: string, vaultSource: string | null): SyncContext {
  const rootDir = path.join(baseDir, name);
  const dataDir = path.join(rootDir, 'Second-Brain-System', 'data');
  const vaultFile = path.join(dataDir, 'encrypted-vault', 'vault.aes256.json');
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
  if (vaultSource) fs.copyFileSync(vaultSource, vaultFile);
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
  writeFixtureFile(ctx.settingsPath, JSON.stringify({ watchedProjects: [{ id: 'app', name: 'App', path: 'D:\\App' }], aiConfig: { ollamaModel: `model-${name}` } }));
  fs.mkdirSync(ctx.obsidianDir, { recursive: true });
  return ctx;
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات المزامنة متعددة الكتابة.
 */
export async function runMultiWriterSyncTests(): Promise<string[]> {
  const passed: string[] = [];
  const config = loadSystemConfig();
  ensureTestVault();
  const base = path.join(config.paths.rootDir, 'mw-sim');
  const syncRoot = path.join(base, 'Google-Drive', 'Second-Brain-Sync');
  fs.mkdirSync(syncRoot, { recursive: true });
  const A = makeDevice(base, 'Asus', syncRoot, config.paths.encryptedVaultFile);
  const B = makeDevice(base, 'Mac', syncRoot, config.paths.encryptedVaultFile);
  const C = makeDevice(base, 'Desktop', syncRoot, config.paths.encryptedVaultFile);
  const vA = unlockVault(TEST_MASTER_PASSWORD, A.vaultFile);
  const vB = unlockVault(TEST_MASTER_PASSWORD, B.vaultFile);
  const vC = unlockVault(TEST_MASTER_PASSWORD, C.vaultFile);
  let clock = Date.now();
  const tick = (ms = 1000): number => (clock += ms);
  const cycle = (ctx: SyncContext, vault: UnlockedVault, extra: Parameters<typeof runSyncCycle>[2] = {}) => runSyncCycle(ctx, vault, { now: tick(), ...extra });
  const all = (fn: (ctx: SyncContext, v: UnlockedVault) => void): void => {
    fn(A, vA);
    fn(B, vB);
    fn(C, vC);
  };
  const obs = (ctx: SyncContext, rel: string): string => path.join(ctx.obsidianDir, rel);

  // 0. العدّاد الذكي ومتجهات الإصدارات
  const st = { wallMs: 0, counter: 0 };
  const t1 = hlcToString(hlcTick(st, 'x', 1000));
  const t2 = hlcToString(hlcTick(st, 'x', 500)); // ساعة رجعت للخلف
  assert.ok(hlcCompare(t2, t1) > 0, 'الختم التالي أحدث حتى لو رجعت ساعة الجهاز');
  hlcReceive(st, hlcParse(hlcToString({ wallMs: 9000, counter: 4, deviceId: 'y' })), 2000);
  assert.ok(hlcCompare(hlcToString(hlcTick(st, 'x', 2000)), hlcToString({ wallMs: 9000, counter: 4, deviceId: 'y' })) > 0, 'بعد رؤية ختم أحدث، أختامنا تتقدّمه');
  assert.equal(compareVv({ a: 2 }, { a: 1 }), 'greater');
  assert.equal(compareVv({ a: 1 }, { a: 1, b: 1 }), 'less');
  assert.equal(compareVv({ a: 2 }, { a: 1, b: 1 }), 'concurrent');
  assert.equal(compareVv({}, {}), 'equal');
  passed.push('اختبار العدّاد الذكي (لا يتأثر برجوع ساعة الجهاز، ويتقدّم على ما رآه) ومقارنة متجهات الإصدارات بنجاح.');

  // 1. الترحيل من 1.9: الأجهزة الثلاثة تبدأ من الأساس نفسه، فلا تعارضات وهمية
  writeFixtureFile(obs(A, 'Notes/base.md'), '# ملاحظة من الأساس');
  writeFixtureFile(path.join(A.dataDir, 'ai-memory-store.json'), JSON.stringify([{ id: 'm-base', sourceAI: 'manual', projectId: 'app', title: 'أساس', summaryAr: 'من الأساس', keyDecisionsAr: [], createdAt: '2026-11-01T00:00:00Z' }]));
  acquireLease(A);
  publishSnapshot(A, vA, { force: true });
  const mA = cycle(A, vA);
  assert.equal(mA.migrated, true);
  assert.equal(mA.published, 0, 'الأساس لا يُعاد نشره');
  assert.equal(mA.compacted, true, 'أول جهاز يرحّل ينشئ أول نسخة كاملة');
  const mB = cycle(B, vB);
  const mC = cycle(C, vC);
  assert.equal(mB.migrated && mC.migrated, true);
  assert.equal(read(obs(B, 'Notes/base.md')), '# ملاحظة من الأساس', 'الترحيل يستورد آخر نسخة قديمة أولاً');
  assert.equal(mB.published + mC.published + mB.conflicts + mC.conflicts, 0, 'لا تغييرات ولا تعارضات وهمية بعد الترحيل');
  assert.equal(readSyncIndex(B)!.origin.legacyVersion, 1);
  passed.push('اختبار الترحيل من 1.9 (استيراد آخر نسخة قديمة، الأساس المشترك بلا إعادة نشر، لا تعارضات وهمية على 3 أجهزة، أول نسخة كاملة) بنجاح.');

  // 2. الكتابة من الأجهزة الثلاثة في الوقت نفسه، بلا قفل
  writeFixtureFile(obs(A, 'Notes/from-asus.md'), 'كتبتُ على الأسوس');
  writeFixtureFile(path.join(B.dataDir, 'ai-memory-store.json'), JSON.stringify([
    { id: 'm-mac', sourceAI: 'claude-code', projectId: 'app', title: 'قرار من الماك', summaryAr: 'ماك', keyDecisionsAr: ['قرار'], createdAt: '2026-11-17T10:00:00Z' },
    ...JSON.parse(read(path.join(B.dataDir, 'ai-memory-store.json'))),
  ]));
  writeFixtureFile(path.join(C.dataDir, 'conversations', 'conv-desktop-0001.enc.json'), '{"sealed":"from-desktop"}');
  upsertVaultSecret(vC, { id: 'sec-hosting', category: 'password', title: 'الاستضافة', secretValue: 'host-pass-1', notesForCommanderAr: '', notesForWifeAr: '' });
  all((ctx, v) => cycle(ctx, v));
  all((ctx, v) => cycle(ctx, v));
  for (const [ctx, v] of [[A, vA], [B, vB], [C, vC]] as Array<[SyncContext, UnlockedVault]>) {
    assert.equal(read(obs(ctx, 'Notes/from-asus.md')), 'كتبتُ على الأسوس', `${ctx.device.deviceName}: ملف الأسوس وصل`);
    assert.match(read(path.join(ctx.dataDir, 'ai-memory-store.json')), /m-mac/, `${ctx.device.deviceName}: ذاكرة الماك وصلت`);
    assert.match(read(path.join(ctx.dataDir, 'ai-memory-store.json')), /m-base/, 'السجل القديم في الذاكرة باقٍ (دمج سجلّاً بسجلّ، لا استبدال)');
    assert.equal(read(path.join(ctx.dataDir, 'conversations', 'conv-desktop-0001.enc.json')), '{"sealed":"from-desktop"}', `${ctx.device.deviceName}: محادثة المكتبي وصلت`);
    assert.equal(v.secrets.find((s) => s.id === 'sec-hosting')?.secretValue, 'host-pass-1', `${ctx.device.deviceName}: السر وصل إلى الجلسة المفتوحة نفسها`);
    assert.equal(unlockVault(TEST_MASTER_PASSWORD, ctx.vaultFile).secrets.some((s) => s.id === 'sec-hosting'), true, 'والسر محفوظ في ملف الخزنة');
    assert.equal(listConflicts(ctx, v.dataKey).length, 0);
  }
  const batchFile = fs.readdirSync(path.join(syncRoot, 'changes', 'id-Desktop')).map((n) => read(path.join(syncRoot, 'changes', 'id-Desktop', n))).join('');
  assert.ok(!batchFile.includes('host-pass-1') && !batchFile.includes('from-desktop'), 'الدفعات على Drive مشفّرة');
  assert.ok(!fs.readdirSync(path.join(syncRoot, 'changes')).some((d) => !['id-Asus', 'id-Mac', 'id-Desktop'].includes(d)));
  passed.push('اختبار الكتابة من 3 أجهزة في الوقت نفسه (ملف، ذاكرة، محادثة، سرّ) بلا قفل: كلٌّ يصل إلى الجميع، والدمج سجلّاً بسجلّ، والسر في الجلسة الحية والملف، والدفعات مشفّرة، وكل جهاز في مجلده فقط بنجاح.');

  // 3. تعارض على الملف نفسه: تُحفظ النسختان، الأحدث معتمد، والأخرى بجانبه
  writeFixtureFile(obs(A, 'Notes/plan.md'), 'خطة الأسوس');
  tick();
  writeFixtureFile(obs(B, 'Notes/plan.md'), 'خطة الماك (أحدث)');
  cycle(A, vA);
  cycle(B, vB);
  cycle(A, vA);
  cycle(B, vB);
  assert.equal(read(obs(A, 'Notes/plan.md')), 'خطة الماك (أحدث)', 'الأحدث معتمد على الأسوس');
  assert.equal(read(obs(B, 'Notes/plan.md')), 'خطة الماك (أحدث)', 'والأحدث معتمد على الماك');
  const sideA = fs.readdirSync(obs(A, 'Notes')).find((n) => n.startsWith('plan (تعارض - Asus'));
  assert.ok(sideA, 'نسخة الأسوس محفوظة بجانب الملف');
  assert.equal(read(obs(A, path.join('Notes', sideA!))), 'خطة الأسوس', 'ولا يضيع شيء');
  const cA = listConflicts(A, vA.dataKey).filter((c) => c.key === 'obs:Notes/plan.md');
  assert.equal(cA.length, 1);
  assert.equal(cA[0].kind, 'edit');
  cycle(C, vC);
  cycle(B, vB);
  assert.ok(exists(obs(B, path.join('Notes', sideA!))), 'النسخة الجانبية تُزامَن هي أيضاً، باسم واحد على الجهازين');
  passed.push('اختبار تعارض الملف نفسه على جهازين (الأحدث معتمد على الجهازين، والأخرى نسخة جانبية تُزامَن، وتعارض مسجّل، ولا فقد) بنجاح.');

  // 4. تعارض سرّ: لا فائز تلقائي، كل جهاز يبقي قيمته، ثم الحسم ينتقل للجميع
  upsertVaultSecret(vA, { ...vA.secrets.find((s) => s.id === 'sec-hosting')!, secretValue: 'host-pass-ASUS' });
  tick();
  upsertVaultSecret(vB, { ...vB.secrets.find((s) => s.id === 'sec-hosting')!, secretValue: 'host-pass-MAC' });
  cycle(A, vA);
  cycle(B, vB);
  cycle(A, vA);
  assert.equal(vA.secrets.find((s) => s.id === 'sec-hosting')!.secretValue, 'host-pass-ASUS', 'السر لا يُحسم تلقائياً: يبقى المحلي');
  assert.equal(vB.secrets.find((s) => s.id === 'sec-hosting')!.secretValue, 'host-pass-MAC');
  const secretConflictA = listConflicts(A, vA.dataKey).find((c) => c.key === 'secret:sec-hosting');
  assert.equal(secretConflictA?.kind, 'secret');
  assert.ok(listConflicts(B, vB.dataKey).some((c) => c.key === 'secret:sec-hosting'), 'التعارض ظاهر على الجهازين');
  resolveConflict(A, vA, secretConflictA!.id, 'other');
  assert.equal(vA.secrets.find((s) => s.id === 'sec-hosting')!.secretValue, 'host-pass-MAC', 'القائد اعتمد قيمة الماك');
  cycle(A, vA);
  cycle(B, vB);
  cycle(C, vC);
  assert.equal(vC.secrets.find((s) => s.id === 'sec-hosting')!.secretValue, 'host-pass-MAC', 'الحسم وصل إلى الجهاز الثالث');
  assert.equal(listConflicts(B, vB.dataKey).some((c) => c.key === 'secret:sec-hosting'), false, 'حُسم على جهاز فاختفى تعارضه من الآخر');
  assert.ok(listTrash(A, vA.dataKey).some((t) => t.key === 'secret:sec-hosting'), 'القيمة التي لم تُعتمد في السلة');
  passed.push('اختبار تعارض سرّ (لا فائز تلقائي، يظهر على الجهازين، الحسم ينتقل للجميع ويُغلق التعارض في كل مكان، والقيمة الأخرى في السلة) بنجاح.');

  // 5. حذف مقابل تعديل: يبقى التعديل على كل الأجهزة
  writeFixtureFile(obs(A, 'Notes/shared.md'), 'نسخة أولى');
  all((ctx, v) => cycle(ctx, v));
  fs.rmSync(obs(A, 'Notes/shared.md'));
  writeFixtureFile(obs(B, 'Notes/shared.md'), 'عدّلتُه على الماك');
  cycle(A, vA);
  cycle(B, vB);
  cycle(A, vA);
  cycle(C, vC);
  assert.equal(read(obs(A, 'Notes/shared.md')), 'عدّلتُه على الماك', 'التعديل عاد إلى الجهاز الذي حذف');
  assert.equal(read(obs(B, 'Notes/shared.md')), 'عدّلتُه على الماك');
  assert.equal(read(obs(C, 'Notes/shared.md')), 'عدّلتُه على الماك');
  assert.ok(listConflicts(B, vB.dataKey).some((c) => c.key === 'obs:Notes/shared.md' && c.kind === 'delete-vs-edit'));
  passed.push('اختبار الحذف مقابل التعديل المتزامن (يبقى التعديل ويعود إلى الجهاز الذي حذف، مع تعارض مسجّل) بنجاح.');

  // 6. ساعة جهاز متقدمة 10 دقائق: التعديلات المتتالية تبقى بالترتيب الصحيح
  runSyncCycle(C, vC, { now: clock + 10 * 60 * 1000 });
  writeFixtureFile(obs(C, 'Notes/clock.md'), 'من المكتبي بساعة متقدمة');
  runSyncCycle(C, vC, { now: clock + 10 * 60 * 1000 + 1 });
  cycle(A, vA);
  writeFixtureFile(obs(A, 'Notes/clock.md'), 'الأسوس عدّل بعده (ساعته عادية)');
  cycle(A, vA);
  runSyncCycle(C, vC, { now: clock + 10 * 60 * 1000 + 5 });
  cycle(B, vB);
  assert.equal(read(obs(C, 'Notes/clock.md')), 'الأسوس عدّل بعده (ساعته عادية)', 'التعديل اللاحق يفوز رغم ساعة المكتبي المتقدمة');
  assert.equal(read(obs(B, 'Notes/clock.md')), 'الأسوس عدّل بعده (ساعته عادية)');
  assert.equal(listConflicts(C, vC.dataKey).some((c) => c.key === 'obs:Notes/clock.md'), false, 'تعديلان متتاليان ليسا تعارضاً');
  passed.push('اختبار ساعة جهاز متقدمة 10 دقائق (التعديل اللاحق يفوز، ولا تعارض بين تعديلين متتاليين) بنجاح.');

  // 7. فشل الدمج في منتصفه: تعود الحالة السابقة كاملة، ثم يُطبَّق في الدورة التالية
  writeFixtureFile(obs(A, 'Notes/atomic.md'), 'تغيير سيفشل دمجه أولاً');
  upsertVaultSecret(vA, { id: 'sec-atomic', category: 'password', title: 'ذري', secretValue: 'v1', notesForCommanderAr: '', notesForWifeAr: '' });
  cycle(A, vA);
  const indexBefore = read(path.join(B.dataDir, 'sync', 'index.json'));
  const secretsBefore = vB.secrets.length;
  assert.throws(() => cycle(B, vB, { failMergeAfterWrite: true }), /فشل مُحقَن/);
  assert.equal(exists(obs(B, 'Notes/atomic.md')), false, 'الملف أُعيد كما كان (غير موجود)');
  assert.equal(vB.secrets.length, secretsBefore, 'الأسرار في الجلسة أُعيدت كما كانت');
  assert.equal(unlockVault(TEST_MASTER_PASSWORD, B.vaultFile).secrets.some((s) => s.id === 'sec-atomic'), false, 'وملف الخزنة أُعيد كما كان');
  assert.deepEqual(JSON.parse(read(path.join(B.dataDir, 'sync', 'index.json'))).cursors, JSON.parse(indexBefore).cursors, 'المؤشرات لم تتقدّم');
  assert.match(readSyncIndex(B)!.lastError ?? '', /فشل مُحقَن/, 'الخطأ مسجّل');
  cycle(B, vB);
  assert.equal(read(obs(B, 'Notes/atomic.md')), 'تغيير سيفشل دمجه أولاً', 'نجح في الدورة التالية');
  assert.ok(vB.secrets.some((s) => s.id === 'sec-atomic'));
  assert.equal(readSyncIndex(B)!.lastError, undefined);
  assert.ok(fs.readdirSync(path.join(B.dataDir, 'sync-backups')).length >= 1, 'نسخة احتياطية محلية قبل الدمج');
  passed.push('اختبار فشل الدمج في منتصفه (عودة الملفات والأسرار في الجلسة والملف، المؤشرات لا تتقدّم، الخطأ مسجّل، ثم النجاح في الدورة التالية، ونسخة احتياطية قبل الدمج) بنجاح.');

  // 8. دفعة لم يكتمل تنزيلها من Drive: تؤجَّل ولا تُعدّ محذوفة
  writeFixtureFile(obs(A, 'Notes/partial.md'), 'وصل متأخراً');
  cycle(A, vA);
  const aDir = path.join(syncRoot, 'changes', 'id-Asus');
  const newestBatch = fs.readdirSync(aDir).sort().pop()!;
  const fullText = read(path.join(aDir, newestBatch));
  fs.writeFileSync(path.join(aDir, newestBatch), fullText.slice(0, Math.floor(fullText.length / 2)));
  const partialRun = cycle(C, vC);
  assert.equal(partialRun.skippedBatches, 1, 'الدفعة الناقصة تؤجَّل');
  assert.ok(partialRun.warnings.some((w) => /لم تكتمل/.test(w)));
  assert.equal(exists(obs(C, 'Notes/partial.md')), false);
  fs.writeFileSync(path.join(aDir, newestBatch), fullText);
  cycle(C, vC);
  assert.equal(read(obs(C, 'Notes/partial.md')), 'وصل متأخراً', 'اكتمل التنزيل فطُبّقت');
  passed.push('اختبار دفعة لم يكتمل تنزيلها من Drive (تؤجَّل مع تنبيه ولا يتقدّم المؤشر، ثم تُطبَّق حين تكتمل) بنجاح.');

  // 9. جهاز بلا اتصال يعود بعد عدة دفعات
  for (let i = 1; i <= 3; i += 1) {
    writeFixtureFile(obs(A, `Offline/day-${i}.md`), `يوم ${i}`);
    cycle(A, vA);
  }
  writeFixtureFile(obs(B, 'Offline/mac-offline.md'), 'كتبه الماك بلا اتصال');
  cycle(B, vB);
  cycle(A, vA);
  for (let i = 1; i <= 3; i += 1) assert.equal(read(obs(B, `Offline/day-${i}.md`)), `يوم ${i}`);
  assert.equal(read(obs(A, 'Offline/mac-offline.md')), 'كتبه الماك بلا اتصال');
  passed.push('اختبار جهاز بلا اتصال يعود (يدمج كل الدفعات الفائتة بالترتيب، وتصل تغييراته هو أيضاً) بنجاح.');

  // 10. السلة: حذف على جهاز، الاسترجاع من جهاز آخر، والتفريغ بعد 30 يوماً
  writeFixtureFile(obs(A, 'Notes/to-delete.md'), 'سأحذفه ثم أندم');
  all((ctx, v) => cycle(ctx, v));
  fs.rmSync(obs(A, 'Notes/to-delete.md'));
  cycle(A, vA);
  cycle(B, vB);
  assert.equal(exists(obs(B, 'Notes/to-delete.md')), false, 'الحذف وصل');
  const trashed = listTrash(B, vB.dataKey).find((t) => t.key === 'obs:Notes/to-delete.md');
  assert.ok(trashed, 'المحذوف في سلة الجهاز الآخر أيضاً');
  restoreFromTrash(B, vB, trashed!);
  removeTrashEntry(B, trashed!.id);
  cycle(B, vB);
  cycle(A, vA);
  assert.equal(read(obs(A, 'Notes/to-delete.md')), 'سأحذفه ثم أندم', 'الاسترجاع من جهاز آخر أعاده إلى كل الأجهزة');
  assert.ok(listTrash(A, vA.dataKey).length > 0);
  assert.equal(purgeTrash(A, clock + 31 * 24 * 3600 * 1000) > 0, true, 'يُفرَّغ ما مضى عليه 30 يوماً');
  assert.equal(listTrash(A, vA.dataKey).length, 0);
  passed.push('اختبار السلة (المحذوف في سلة كل جهاز، الاسترجاع من جهاز آخر يعيده للجميع، والتفريغ بعد 30 يوماً) بنجاح.');

  // 10.5 ISS-024: الحذف بأسماء عربية (fs.rmSync على Windows لا يحذفها ولا يرمي خطأ)
  const arabicDir = path.join(base, 'حذف-عربي');
  writeFixtureFile(path.join(arabicDir, 'داخلي', 'ملاحظة.md'), 'نص');
  writeFixtureFile(path.join(base, 'ملف-عربي.md'), 'نص');
  assert.equal(removePathSync(path.join(base, 'ملف-عربي.md')), true);
  assert.equal(exists(path.join(base, 'ملف-عربي.md')), false, 'ملف باسم عربي يُحذف فعلاً');
  removePathSync(arabicDir, { recursive: true });
  assert.equal(exists(arabicDir), false, 'مجلد باسم عربي بمحتواه يُحذف فعلاً');
  assert.equal(removePathSync(path.join(base, 'غير-موجود.md')), false, 'غير الموجود لا يرمي');
  writeFixtureFile(obs(A, 'ملاحظات/خطة-عربية.md'), 'ملاحظة باسم عربي');
  all((ctx, v) => cycle(ctx, v));
  assert.equal(read(obs(C, 'ملاحظات/خطة-عربية.md')), 'ملاحظة باسم عربي');
  removePathSync(obs(B, 'ملاحظات/خطة-عربية.md'));
  cycle(B, vB);
  cycle(A, vA);
  cycle(C, vC);
  assert.equal(exists(obs(A, 'ملاحظات/خطة-عربية.md')), false, 'حذف ملف باسم عربي على جهاز يصل إلى الأسوس');
  assert.equal(exists(obs(C, 'ملاحظات/خطة-عربية.md')), false, 'وإلى المكتبي');
  assert.ok(listTrash(C, vC.dataKey).some((t) => t.key === 'obs:ملاحظات/خطة-عربية.md'), 'وهو في السلة');
  passed.push('اختبار الحذف بأسماء عربية (ISS-024: ملف ومجلد يُحذفان فعلاً، وحذف ملاحظة عربية على جهاز يصل إلى الجميع ويدخل السلة) بنجاح.');

  // 10.6 ISS-025: الماك يعيد الأسماء العربية مفكّكة (NFD)، و Windows مركّبة (NFC): الملف نفسه لا يصبح ملفين
  const nfcName = 'نظام ادارة الوثائق'; // «ئ» مركّبة
  const nfdName = nfcName.normalize('NFD'); // «ي» + همزة فوقها، كما يعيدها الماك
  assert.notEqual(nfcName, nfdName);
  // ISS-027: نظام ملفات الماك (APFS) يعامل الصيغتين كاسم واحد، فلا يمكن صنع «مجلد مكرر» عليه أصلاً
  // (الكتابة بالمسار المفكّك تكتب فوق الأصل). نفحص سلوك نظام الملفات الفعلي بدل افتراض سلوك Windows.
  const probe = path.join(base, 'probe-unicode');
  writeFixtureFile(path.join(probe, nfcName), 'x');
  const fsFoldsUnicode = exists(path.join(probe, nfdName));
  removePathSync(probe, { recursive: true });
  if (!fsFoldsUnicode) {
    // Windows / Linux: الصيغتان ملفان مختلفان، فيظهر المجلد المكرر ويجب توحيده
    writeFixtureFile(obs(A, `02-Projects/${nfcName}/02-Run-And-Update.md`), 'الأصل باسم مركّب');
    writeFixtureFile(obs(A, `02-Projects/${nfdName}/02-Run-And-Update.md`), 'مكرر باسم مفكّك');
    writeFixtureFile(obs(A, `02-Projects/${nfdName}/05-Auto-Changelog.md`), 'سجل وصل باسم مفكّك فقط');
    const keysA = [...readLocalRecords(A, vA).keys()].filter((k) => k.includes('ادارة'));
    assert.ok(keysA.every((k) => k === k.normalize('NFC')), 'كل المفاتيح بصيغة مركّبة');
    assert.equal(keysA.filter((k) => k.endsWith('02-Run-And-Update.md')).length, 1, 'الملف نفسه مفتاح واحد');
    assert.equal(readLocalRecords(A, vA).get(`obs:02-Projects/${nfcName}/02-Run-And-Update.md`)!.toString(), 'الأصل باسم مركّب', 'الاسم المركّب يتقدّم');
    assert.equal(normalizeObsidianFileNames(A, vA.dataKey, 'Asus', 'darwin'), 0, 'على الماك لا تغيير (النظام يعامل الصيغتين كاسم واحد)');
    assert.equal(normalizeObsidianFileNames(A, vA.dataKey, 'Asus', 'win32'), 2);
    assert.equal(exists(obs(A, `02-Projects/${nfdName}`)), false, 'المجلد المكرر اختفى');
    assert.equal(read(obs(A, `02-Projects/${nfcName}/05-Auto-Changelog.md`)), 'سجل وصل باسم مفكّك فقط', 'الملف الذي لا أصل له نُقل إلى الاسم المركّب');
    assert.ok(listTrash(A, vA.dataKey).some((t) => t.key === `obs:02-Projects/${nfcName}/02-Run-And-Update.md` && Buffer.from(t.content, 'base64').toString() === 'مكرر باسم مفكّك'), 'المكرر في السلة لا يضيع');
  } else {
    // الماك: الملفات تصل بأسماء مفكّكة (كما يعيدها Google Drive)، والمفاتيح يجب أن تخرج مركّبة
    writeFixtureFile(obs(A, `02-Projects/${nfdName}/02-Run-And-Update.md`), 'الأصل باسم مركّب');
    writeFixtureFile(obs(A, `02-Projects/${nfdName}/05-Auto-Changelog.md`), 'سجل وصل باسم مفكّك فقط');
    const recordsA = readLocalRecords(A, vA);
    const keysA = [...recordsA.keys()].filter((k) => k.includes('ادارة'));
    assert.ok(keysA.every((k) => k === k.normalize('NFC')), 'كل المفاتيح بصيغة مركّبة (الماك)');
    assert.equal(keysA.filter((k) => k.endsWith('02-Run-And-Update.md')).length, 1, 'الملف نفسه مفتاح واحد (الماك)');
    assert.equal(recordsA.get(`obs:02-Projects/${nfcName}/02-Run-And-Update.md`)!.toString(), 'الأصل باسم مركّب', 'المفتاح المركّب يقرأ الملف المفكّك (الماك)');
    assert.equal(normalizeObsidianFileNames(A, vA.dataKey, 'Asus', 'darwin'), 0, 'على الماك لا تغيير (النظام يعامل الصيغتين كاسم واحد)');
    assert.equal(listTrash(A, vA.dataKey).filter((t) => t.key.includes('ادارة')).length, 0, 'لا شيء في السلة على الماك');
  }
  assert.equal(read(obs(A, `02-Projects/${nfcName}/02-Run-And-Update.md`)), 'الأصل باسم مركّب');
  applyRecordWrites(A, vA, [{ key: `obs:02-Projects/${nfdName}/02-Run-And-Update.md`, content: null }]);
  assert.equal(read(obs(A, `02-Projects/${nfcName}/02-Run-And-Update.md`)), 'الأصل باسم مركّب', 'حذف قادم بمفتاح مفكّك لا يمسّ الملف الحقيقي (على الماك كان سيحذفه)');
  all((ctx, v) => cycle(ctx, v));
  all((ctx, v) => cycle(ctx, v));
  assert.equal(read(obs(C, `02-Projects/${nfcName}/05-Auto-Changelog.md`)), 'سجل وصل باسم مفكّك فقط', 'وصل للجميع باسم واحد');
  assert.ok(!fs.readdirSync(obs(C, '02-Projects')).some((n) => n !== n.normalize('NFC')), 'لا مجلد مكرر على أي جهاز');
  passed.push('اختبار الأسماء العربية بصيغتي يونيكود (ISS-025: مفتاح واحد بصيغة NFC، توحيد الأسماء على Windows مع نقل المكرر إلى السلة، تجاهل الحذف القادم بمفتاح مفكّك، ولا مجلد مكرر على أي جهاز) بنجاح.');

  // 10.7 ISS-026: الوثائق المولّدة تُحسم بصمت، ومرآة فهرس الدوال لا تُزامَن
  writeFixtureFile(obs(A, '02-Projects/App/01-Overview.md'), 'نظرة عامة ولّدها الأسوس');
  tick();
  writeFixtureFile(obs(B, '02-Projects/App/01-Overview.md'), 'نظرة عامة ولّدها الماك (أحدث)');
  const conflictsBefore = listConflicts(A, vA.dataKey).length;
  cycle(A, vA);
  cycle(B, vB);
  cycle(A, vA);
  assert.equal(read(obs(A, '02-Projects/App/01-Overview.md')), 'نظرة عامة ولّدها الماك (أحدث)', 'الأحدث معتمد');
  assert.equal(listConflicts(A, vA.dataKey).length, conflictsBefore, 'بلا بطاقة تعارض للوثائق المولّدة');
  assert.ok(!fs.readdirSync(obs(A, '02-Projects/App')).some((n) => n.includes('تعارض')), 'ولا نسخة جانبية');
  assert.ok(listTrash(A, vA.dataKey).some((t) => t.key === 'obs:02-Projects/App/01-Overview.md'), 'والأقدم في السلة');
  writeFixtureFile(obs(A, '00-Command-Center/Code-Registry-Mirror.md'), 'مرآة الأسوس');
  cycle(A, vA);
  cycle(C, vC);
  assert.equal(exists(obs(C, '00-Command-Center/Code-Registry-Mirror.md')), false, 'مرآة فهرس الدوال لا تُزامَن (تصل عبر Git)');
  passed.push('اختبار الوثائق المولّدة (ISS-026: الأحدث يُعتمد بصمت بلا بطاقة تعارض ولا نسخة جانبية، والأقدم في السلة، ومرآة فهرس الدوال لا تُزامَن) بنجاح.');

  // 11. تغيير كلمة المرور على جهاز ينتقل إلى الآخرين
  const NEW_PASSWORD = 'New-Strong-Password-2026';
  changeMasterPassword(vA, TEST_MASTER_PASSWORD, NEW_PASSWORD);
  cycle(A, vA);
  const pwB = cycle(B, vB);
  assert.ok(pwB.warnings.some((w) => /تغيّرت كلمة المرور/.test(w)), 'إشعار بتغيير كلمة المرور');
  assert.equal(unlockVault(NEW_PASSWORD, B.vaultFile).secrets.length, vB.secrets.length, 'كلمة المرور الجديدة تفتح خزنة الماك');
  assert.throws(() => unlockVault(TEST_MASTER_PASSWORD, B.vaultFile), /غير صحيح/, 'القديمة لم تعد تعمل');
  assert.equal(vB.secrets.length > 0, true, 'الجلسة المفتوحة على الماك بقيت تعمل');
  cycle(C, vC);
  passed.push('اختبار تغيير كلمة المرور (ينتقل إلى الأجهزة الأخرى مع إشعار، والقديمة تتوقف، والجلسات المفتوحة تبقى) بنجاح.');

  // 12. الضغط وإقلاع جهاز جديد من النسخة الكاملة ثم الدفعات اللاحقة
  createSnapshotV2(A, vA, readSyncIndex(A)!, tick());
  writeFixtureFile(obs(A, 'Notes/after-snapshot.md'), 'بعد النسخة الكاملة');
  cycle(A, vA);
  const N = makeDevice(base, 'New-PC', syncRoot, null);
  fs.rmSync(N.settingsPath);
  const boot = bootstrapFromSnapshotV2(N, NEW_PASSWORD, tick());
  assert.ok(boot.records > 5);
  assert.equal(read(obs(N, 'Notes/from-asus.md')), 'كتبتُ على الأسوس', 'الجهاز الجديد حصل على البيانات من النسخة');
  assert.ok(boot.vault.secrets.some((s) => s.id === 'sec-hosting'), 'والأسرار');
  cycle(N, boot.vault);
  assert.equal(read(obs(N, 'Notes/after-snapshot.md')), 'بعد النسخة الكاملة', 'ثم الدفعات بعد النسخة');
  assert.throws(() => bootstrapFromSnapshotV2(N, NEW_PASSWORD), /خزنة موجودة/, 'لا إقلاع فوق خزنة موجودة');
  passed.push('اختبار الضغط وإقلاع جهاز جديد (من أحدث نسخة كاملة بكلمة المرور، ثم الدفعات اللاحقة، ورفض الإقلاع فوق خزنة موجودة) بنجاح.');

  // 13. كل جهاز يحذف ملفاته هو فقط: نسخه خارج آخر 10، ودفعاته المغطاة الأقدم من 90 يوماً
  const farFuture = clock + 100 * 24 * 3600 * 1000;
  const indexB = readSyncIndex(B)!; // نفس الفهرس، فتتقدّم ساعته مع كل نسخة
  for (let i = 0; i < 11; i += 1) createSnapshotV2(B, vB, indexB, clock + i * 1000 + 1);
  createSnapshotV2(A, vA, readSyncIndex(A)!, farFuture - 1000);
  const otherBatchesBefore = fs.readdirSync(path.join(syncRoot, 'changes', 'id-Mac')).length;
  const pruned = pruneOwnSyncFiles(A, farFuture);
  assert.ok(pruned.batches > 0, 'الأسوس حذف دفعاته القديمة المغطاة');
  assert.equal(fs.readdirSync(path.join(syncRoot, 'changes', 'id-Mac')).length, otherBatchesBefore, 'ولم يلمس دفعات الماك');
  const prunedB = pruneOwnSyncFiles(B, farFuture);
  assert.ok(prunedB.snapshots > 0, 'الماك حذف نسخه الزائدة عن آخر 10 فقط');
  assert.ok(fs.readdirSync(path.join(syncRoot, 'snapshots-v2')).some((n) => n.endsWith('-id-Asus.enc.json')), 'نسخ الأسوس لم يحذفها الماك');
  passed.push('اختبار التنظيف (كل جهاز يحذف دفعاته المغطاة الأقدم من 90 يوماً ونسخه الزائدة فقط، ولا يلمس ملفات غيره) بنجاح.');

  // 14. الوثائق المولّدة: يكتبها صاحب آخر تغيير في كود المشروع فقط
  const devicesDir = path.join(base, 'docs-owner', 'devices');
  writeFixtureFile(path.join(devicesDir, 'a.json'), JSON.stringify({ deviceId: 'dev-a', projectCodeChanges: { app: '2026-11-17T10:00:00Z' } }));
  writeFixtureFile(path.join(devicesDir, 'b.json'), JSON.stringify({ deviceId: 'dev-b', projectCodeChanges: { app: '2026-11-17T12:00:00Z' } }));
  const ownerRoot = path.join(base, 'docs-owner');
  assert.equal(isGeneratedDocsOwner('app', Date.parse('2026-11-17T10:00:00Z'), { syncRoot: ownerRoot, myDeviceId: 'dev-a' }), false, 'جهاز آخر فيه تغيير أحدث ← لا يكتب');
  assert.equal(isGeneratedDocsOwner('app', Date.parse('2026-11-17T12:00:00Z'), { syncRoot: ownerRoot, myDeviceId: 'dev-b' }), true, 'صاحب آخر تغيير يكتب');
  assert.equal(isGeneratedDocsOwner('other-project', 1, { syncRoot: ownerRoot, myDeviceId: 'dev-a' }), true, 'مشروع لا يعرفه غيري ← أكتبه');
  passed.push('اختبار الوثائق المولّدة (يكتبها فقط الجهاز صاحب آخر تغيير في كود المشروع) بنجاح.');

  // 15. تمرين الاستعادة على نسخة حقيقية الصيغة (فيها المحادثات الآن — ISS-020)
  const drillVault = unlockVault(TEST_MASTER_PASSWORD, config.paths.encryptedVaultFile);
  for (const f of fs.existsSync(resolveConversationsDir()) ? fs.readdirSync(resolveConversationsDir()) : []) fs.rmSync(path.join(resolveConversationsDir(), f), { force: true });
  appendConversationTurn(drillVault, { mode: 'commander', question: 'سؤال للتمرين', answer: 'جواب للتمرين' });
  const backup = createEncryptedSystemBackup(drillVault, { extraOutputDir: '' });
  const drill = runRestoreDrill(backup.backupFilePath, TEST_MASTER_PASSWORD, { liveRootDir: config.paths.rootDir, reportsDir: path.join(base, 'drills') });
  assert.equal(drill.ok, true, JSON.stringify(drill.checks));
  assert.equal(drill.checks.length, 6, 'الفحوص الست كلها');
  assert.match(drill.checks.find((c) => c.nameAr === 'سلامة المحادثات')!.detailAr, /1 من 1 محادثة/, 'المحادثات صارت داخل النسخة وتُفتح');
  assert.ok(fs.readdirSync(path.join(base, 'drills')).length === 1, 'التقرير محفوظ');
  assert.ok(!read(path.join(base, 'drills', fs.readdirSync(path.join(base, 'drills'))[0])).includes(TEST_MASTER_PASSWORD), 'التقرير بلا أسرار');
  const badDrill = runRestoreDrill(backup.backupFilePath, 'wrong-password-123');
  assert.equal(badDrill.ok, false, 'كلمة مرور خاطئة ← التمرين يفشل بوضوح');
  passed.push('اختبار تمرين الاستعادة (الفحوص الست، المحادثات داخل النسخة، تقرير بلا أسرار، فشل واضح بكلمة مرور خاطئة) بنجاح.');

  // 15.5 ISS-030: التمرين يجد النسخ في كل الأماكن، ومنها مجلد Backups على Drive بلا إعداد، ويُنبّه للنسخة القديمة
  const localBackups = path.join(base, 'bk-local');
  const syncFolder = path.join(base, 'bk-drive', 'Second Brain');
  fs.mkdirSync(localBackups, { recursive: true });
  fs.mkdirSync(path.join(syncFolder, 'Backups'), { recursive: true });
  const oldName = 'Second-Brain-Backup-2026-11-12T22-44-19.enc.json';
  const newName = 'Second-Brain-Backup-2026-11-16T20-22-45.enc.json';
  fs.copyFileSync(backup.backupFilePath, path.join(localBackups, oldName));
  fs.copyFileSync(backup.backupFilePath, path.join(syncFolder, 'Backups', oldName));
  fs.copyFileSync(backup.backupFilePath, path.join(syncFolder, 'Backups', newName));
  const found = findBackupCandidates({ localDir: localBackups, syncFolder });
  assert.equal(found.length, 2, 'النسخة نفسها في مكانين تظهر مرة واحدة');
  assert.equal(found[0].fileName, newName, 'الأحدث أولاً');
  assert.equal(found[0].location, 'drive', 'وجدها في Backups على Drive بلا أي إعداد');
  assert.equal(found[1].location, 'local');
  assert.equal(findBackupCandidates({ localDir: localBackups }).length, 1, 'بلا مجلد مزامنة: المحلي فقط (السلوك القديم الذي سبّب ISS-030)');
  const old = describeBackupAge('2026-11-12T22:44:19Z', Date.parse('2026-11-25T00:00:00Z'));
  assert.equal(old.ageDays, 12);
  assert.match(old.warningAr ?? '', /عمرها 12 يوماً/, 'تنبيه للنسخة الأقدم من 7 أيام');
  assert.equal(describeBackupAge('2026-11-16T20:22:45Z', Date.parse('2026-11-17T00:00:00Z')).warningAr, undefined, 'لا تنبيه للحديثة');
  passed.push('اختبار مكان النسخ في التمرين (ISS-030: مجلد Backups على Drive بلا إعداد، الأحدث أولاً، بلا تكرار، وتنبيه للنسخة الأقدم من 7 أيام) بنجاح.');

  // 15.6 ISS-031: نسخة فيها الاسم نفسه بصيغتي يونيكود (من قبل 2.0.2) تُستعاد على الماك ملفاً واحداً، فلا تُعدّ فاقدة
  const b64 = (t: string): string => Buffer.from(t).toString('base64');
  const nfcRel = 'Obsidian-Vault/02-Projects/نظام ادارة الوثائق/02-Run-And-Update.md';
  const nfdRel = nfcRel.normalize('NFD');
  const filesMap = { [nfcRel]: b64('نسخة Windows'), [nfdRel]: b64('نسخة الماك'), 'Obsidian-Vault/عادي.md': b64('عادي') };
  const apfsLike = path.join(base, 'drill-apfs');
  writeFixtureFile(path.join(apfsLike, nfcRel), 'نسخة الماك'); // على APFS: الكتابة الثانية فوق الأولى، وملف واحد
  writeFixtureFile(path.join(apfsLike, 'Obsidian-Vault/عادي.md'), 'عادي');
  const okCheck = checkRestoredFiles(apfsLike, filesMap);
  assert.deepEqual(okCheck.missing, [], 'لا يُعدّ مفقوداً ما اختلف بصيغة يونيكود فقط');
  assert.deepEqual(okCheck.mismatched, [], 'الملف سليم لأنه يطابق إحدى النسختين');
  assert.equal(okCheck.unicodeDuplicates.length, 1, 'ويُبلَّغ عن المكرر بصيغتين');
  writeFixtureFile(path.join(apfsLike, nfcRel), 'محتوى تالف');
  removePathSync(path.join(apfsLike, 'Obsidian-Vault/عادي.md'));
  const badCheck = checkRestoredFiles(apfsLike, filesMap);
  assert.equal(badCheck.mismatched.length, 1, 'المحتوى التالف يُكشف');
  assert.deepEqual(badCheck.missing, ['Obsidian-Vault/عادي.md'], 'والمفقود فعلاً يُكشف');
  const appJsText = read(path.join(import.meta.dirname, '..', 'src', 'features', 'dashboard-app', 'public', 'app.js'));
  assert.match(appJsText, /\]\.filter\(Boolean\) \/\/ ISS-031/, 'تقرير التمرين لا يكتب «null»');
  passed.push('اختبار مقارنة الاستعادة بأسماء موحّدة (ISS-031: المكرر بصيغتي يونيكود ليس فقداً على الماك، والتالف والمفقود فعلاً يُكشفان، ولا «null» في التقرير) بنجاح.');

  fs.rmSync(base, { recursive: true, force: true });
  return passed;
}
