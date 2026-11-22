/**
 * ============================================================================
 * الملف: src/features/sync/records.ts
 * القسم: Features -> Sync (السجلات: تفكيك البيانات المشتركة إلى وحدات صغيرة تُدمج كلٌّ وحدها)
 * Hint بالعربي: المزامنة متعددة الكتابة (2.0) لا تنقل «كل شيء» دفعة واحدة، بل سجلّاً سجلّاً:
 *               - secret:<id>      سرّ واحد من الخزنة
 *               - vaultkeys:main   مغلّفا مفتاح الخزنة (يتغيران مع كلمة المرور أو مفتاح الطوارئ)
 *               - branding:main    ملف الهوية
 *               - memory:<id>      سجل واحد من الذاكرة المشتركة
 *               - project:<id>     مشروع واحد من قائمة المشاريع
 *               - conv:<ملف>       محادثة مشفرة واحدة
 *               - flog:<ملف>       خطوة واحدة من سجل خطوات الطوارئ (3.1.0، مختومة بالمفتاح العائلي)
 *               - obs:<مسار>       ملف واحد من Obsidian
 *               كل سجل محتواه بايتات، وبصمته SHA-256. التطبيق على الجهاز يتم كمعاملة: إن فشل أي سجل
 *               تُعاد السجلات التي تغيّرت إلى ما كانت عليه.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openWithKey } from '../../core/crypto-engine.ts';
import { listFilesRecursive, readJsonFileSafe, removePathSync, writeFileAtomic } from '../../shared/file-helpers.ts';
import { moveToTrash } from './sync-store.ts';
import type { SealedData, SharedAIMemoryEntry, VaultSecretItem } from '../../shared/types.ts';
import { adoptFamilyKeys, mergeVaultKeys, persistVault, readVaultFile, vaultKeysOf, type UnlockedVault, type VaultFile, type VaultKeysRecord } from '../vault/vault-manager.ts';
import { resealFamilyConversations } from '../conversations/conversation-store.ts';
import { FAMILY_LOG_FILE, resealFamilyLog } from '../family-emergency/family-portal.ts';
import { logSystemInfo } from '../../core/logger.ts';
import type { SyncContext } from './sync-context.ts';

/** ملفات Obsidian الخاصة بواجهة كل جهاز (لا تُزامَن) */
export const OBSIDIAN_LOCAL_ONLY = [
  /^\.obsidian\/workspace[^/]*\.json$/,
  /^\.trash\//,
  // ISS-026: مرآة فهرس الدوال يولّدها مشغّل الاختبارات على كل جهاز (وتصل عبر Git)، فلا تُزامَن
  /^00-Command-Center\/Code-Registry-Mirror\.md$/,
];

/**
 * Hint بالعربي: الوثائق المولّدة آلياً لكل مشروع (01–06). تعارضها لا يُعرض على القائد:
 *               الأحدث يُعتمد بصمت، والأخرى تذهب إلى السلة 30 يوماً (ISS-026).
 */
export function isGeneratedProjectDoc(key: string): boolean {
  return /^obs:02-Projects\/[^/]+\/0[1-6]-[^/]+\.md$/.test(key);
}

/**
 * Hint بالعربي: توحيد الاسم بصيغة يونيكود المركّبة (NFC). ISS-025: الماك يعيد أسماء الملفات العربية
 *               بصيغة مفكّكة (NFD: «ئ» = «ي» + همزة)، و Windows بالمركّبة، فيظهر الملف نفسه كملفين.
 */
export function nfc(text: string): string {
  return text.normalize('NFC');
}
/** أسماء ملفات المحادثات المسموحة */
const CONVERSATION_FILE = /^[a-z0-9-]{8,64}\.enc\.json$/;

/** خريطة السجلات: المفتاح ← المحتوى */
export type RecordMap = Map<string, Buffer>;

/** تغيير واحد يُطبَّق على الجهاز: محتوى جديد، أو null للحذف */
export interface RecordWrite {
  key: string;
  content: Buffer | null;
}

/**
 * Hint بالعربي: دالة بصمة محتوى سجل.
 */
export function hashContent(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Hint بالعربي: نوع السجل من مفتاحه (secret، memory، obs...).
 */
export function recordKind(key: string): string {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

function recordId(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function memoryFile(ctx: SyncContext): string {
  return path.join(ctx.dataDir, 'ai-memory-store.json');
}

function conversationsDir(ctx: SyncContext): string {
  return path.join(ctx.dataDir, 'conversations');
}

function familyLogDir(ctx: SyncContext): string {
  return path.join(ctx.dataDir, 'family-log');
}

/**
 * Hint بالعربي: دالة جمع كل سجلات هذا الجهاز الآن. الأسرار تُقرأ من الخزنة المفتوحة (لا من الملف)،
 *               لأن الجلسة المفتوحة هي المصدر الحي الذي تحفظ عليه الواجهة.
 */
export function readLocalRecords(ctx: SyncContext, vault: UnlockedVault): RecordMap {
  const map: RecordMap = new Map();
  for (const secret of vault.secrets) map.set(`secret:${secret.id}`, json(secret));
  if (fs.existsSync(ctx.vaultFile)) {
    // 3.0.0: v3 = مغلّف القائد + مفاتيح الخزنة العائلية (بلا غلاف الطوارئ القديم)
    map.set('vaultkeys:main', json(vaultKeysOf(readVaultFile(ctx.vaultFile))));
  }
  if (fs.existsSync(ctx.brandingPath)) map.set('branding:main', fs.readFileSync(ctx.brandingPath));
  for (const entry of readJsonFileSafe<SharedAIMemoryEntry[]>(memoryFile(ctx), [])) {
    if (entry && typeof entry.id === 'string' && entry.id) map.set(`memory:${entry.id}`, json(entry));
  }
  const settings = readJsonFileSafe<Record<string, unknown>>(ctx.settingsPath, {});
  for (const project of Array.isArray(settings.watchedProjects) ? (settings.watchedProjects as Array<{ id?: unknown }>) : []) {
    if (project && typeof project.id === 'string' && project.id) map.set(`project:${project.id}`, json(project));
  }
  const convDir = conversationsDir(ctx);
  if (fs.existsSync(convDir)) {
    for (const name of fs.readdirSync(convDir)) {
      if (CONVERSATION_FILE.test(name)) map.set(`conv:${name}`, fs.readFileSync(path.join(convDir, name)));
    }
  }
  // 3.1.0: سجل خطوات الطوارئ (تكتبه جلسة العائلة محلياً، ويُنشر حين يفتح القائد الخزنة على هذا الجهاز)
  const logDir = familyLogDir(ctx);
  if (fs.existsSync(logDir)) {
    for (const name of fs.readdirSync(logDir)) {
      if (FAMILY_LOG_FILE.test(name)) map.set(`flog:${name}`, fs.readFileSync(path.join(logDir, name)));
    }
  }
  // ISS-025: المفتاح دائماً بصيغة NFC. الملف ذو الاسم المركّب يتقدّم إن وُجد اسمان للملف نفسه
  const later: Array<{ rel: string; file: string }> = [];
  for (const file of listFilesRecursive(ctx.obsidianDir)) {
    const raw = toPosix(path.relative(ctx.obsidianDir, file));
    const rel = nfc(raw);
    if (OBSIDIAN_LOCAL_ONLY.some((re) => re.test(rel))) continue;
    if (raw !== rel) later.push({ rel, file });
    else map.set(`obs:${rel}`, fs.readFileSync(file));
  }
  for (const { rel, file } of later) if (!map.has(`obs:${rel}`)) map.set(`obs:${rel}`, fs.readFileSync(file));
  return map;
}

/**
 * Hint بالعربي: دالة تحويل محتوى نسخة قديمة (صيغة 1.9: مفاتيح vault/branding/memory/projects/conversations/obsidian)
 *               إلى سجلات بالصيغة الجديدة، للترحيل ولمعرفة «الأساس» الذي بدأ منه كل جهاز.
 */
export function recordsFromLegacyEntries(entries: Record<string, string>, dataKey: Buffer): RecordMap {
  const map: RecordMap = new Map();
  const buf = (key: string): Buffer | null => (entries[key] !== undefined ? Buffer.from(entries[key], 'base64') : null);
  const vault = buf('vault');
  if (vault) {
    const file = JSON.parse(vault.toString('utf8')) as VaultFile;
    const secrets = JSON.parse(openWithKey(file.data as SealedData, dataKey).toString('utf8')) as VaultSecretItem[];
    for (const secret of secrets) map.set(`secret:${secret.id}`, json(secret));
    map.set('vaultkeys:main', json(vaultKeysOf(file)));
  }
  const branding = buf('branding');
  if (branding) map.set('branding:main', branding);
  const memory = buf('memory');
  if (memory) {
    for (const entry of JSON.parse(memory.toString('utf8')) as SharedAIMemoryEntry[]) {
      if (entry && typeof entry.id === 'string' && entry.id) map.set(`memory:${entry.id}`, json(entry));
    }
  }
  const projects = buf('projects');
  if (projects) {
    for (const project of JSON.parse(projects.toString('utf8')) as Array<{ id?: unknown }>) {
      if (project && typeof project.id === 'string' && project.id) map.set(`project:${project.id}`, json(project));
    }
  }
  for (const key of Object.keys(entries)) {
    if (key.startsWith('conversations/')) map.set(`conv:${key.slice('conversations/'.length)}`, buf(key)!);
    else if (key.startsWith('obsidian/')) {
      const rel = nfc(key.slice('obsidian/'.length));
      if (!OBSIDIAN_LOCAL_ONLY.some((re) => re.test(rel)) && !map.has(`obs:${rel}`)) map.set(`obs:${rel}`, buf(key)!);
    }
  }
  return map;
}

/**
 * Hint بالعربي: دالة التحقق من مسار ملف Obsidian قبل الكتابة (منع الخروج من المجلد). ترمي إن كان غير آمن.
 */
export function resolveObsidianPath(ctx: SyncContext, rel: string): string {
  const root = path.resolve(ctx.obsidianDir);
  const dest = path.resolve(root, nfc(rel));
  if (!dest.startsWith(root + path.sep)) throw new Error(`مسار غير آمن في سجل المزامنة: ${rel}`);
  if (OBSIDIAN_LOCAL_ONLY.some((re) => re.test(toPosix(path.relative(root, dest))))) throw new Error(`ملف محلي لا يُزامَن: ${rel}`);
  return dest;
}

/**
 * Hint بالعربي: دالة كتابة مجموعة سجلات على هذا الجهاز (بلا معاملة؛ استخدم applyRecordWrites).
 */
function writeRecords(ctx: SyncContext, vault: UnlockedVault, writes: RecordWrite[]): void {
  const byKind = new Map<string, RecordWrite[]>();
  for (const w of writes) {
    const kind = recordKind(w.key);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(w);
  }

  // 1) الأسرار: تُعدَّل في الجلسة الحية ثم تُحفظ مرة واحدة (فلا تكتب الواجهة لاحقاً فوقها بنسخة قديمة)
  const secretWrites = byKind.get('secret') ?? [];
  if (secretWrites.length) {
    for (const w of secretWrites) {
      const id = recordId(w.key);
      const idx = vault.secrets.findIndex((s) => s.id === id);
      if (w.content === null) {
        if (idx >= 0) vault.secrets.splice(idx, 1);
      } else {
        const item = JSON.parse(w.content.toString('utf8')) as VaultSecretItem;
        if (item.id !== id) throw new Error(`سجل سرّ لا يطابق معرّفه: ${id}`);
        if (idx >= 0) vault.secrets[idx] = item;
        else vault.secrets.push(item);
      }
    }
    persistVault(vault);
  }

  // 2) مغلّفات المفتاح: بعد حفظ الأسرار، حتى لا يكتب persistVault فوقها.
  //    3.0.0: الخزنة العائلية لا تُفقد أبداً (سجل بلا family لا يُلغيها)، وسجل يحملها يرقّي هذا الجهاز إلى v3
  //    بالمفتاح العائلي نفسه، ثم تُنقل محادثات العائلة إليه.
  for (const w of byKind.get('vaultkeys') ?? []) {
    if (w.content === null) continue; // لا يُحذف مغلّف المفتاح أبداً
    const incoming = JSON.parse(w.content.toString('utf8')) as VaultKeysRecord;
    if (!incoming.commanderWrap || (!incoming.emergencyWrap && !incoming.family)) throw new Error('سجل مغلّفات المفتاح ناقص.');
    const file = readVaultFile(ctx.vaultFile);
    const keys = mergeVaultKeys(incoming, vaultKeysOf(file));
    if (keys.family) {
      const { upgraded, previousFamilyKey } = adoptFamilyKeys(vault, keys);
      const moved = resealFamilyConversations(vault, conversationsDir(ctx), previousFamilyKey);
      const logMoved = resealFamilyLog(vault, previousFamilyKey, familyLogDir(ctx));
      if (upgraded || previousFamilyKey) logSystemInfo('Sync', `${upgraded ? 'رُقّيت الخزنة هنا إلى الخزنة العائلية (v3) بمفاتيح وصلت بالمزامنة' : 'اعتُمد مفتاح عائلي جديد وصل بالمزامنة'}، ونُقلت ${moved} محادثة عائلية و${logMoved} خطوة من سجل الطوارئ.`);
    } else {
      writeFileAtomic(ctx.vaultFile, JSON.stringify({ ...file, commanderWrap: keys.commanderWrap, emergencyWrap: keys.emergencyWrap, ...(keys.changedAt ? { keysChangedAt: keys.changedAt } : {}) }, null, 2), 5);
    }
  }

  for (const w of byKind.get('branding') ?? []) {
    if (w.content !== null) writeFileAtomic(ctx.brandingPath, w.content);
  }

  const memoryWrites = byKind.get('memory') ?? [];
  if (memoryWrites.length) {
    const all = readJsonFileSafe<SharedAIMemoryEntry[]>(memoryFile(ctx), []).filter((e) => e && typeof e.id === 'string');
    const byId = new Map(all.map((e) => [e.id, e]));
    for (const w of memoryWrites) {
      const id = recordId(w.key);
      if (w.content === null) byId.delete(id);
      else byId.set(id, JSON.parse(w.content.toString('utf8')) as SharedAIMemoryEntry);
    }
    const merged = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    writeFileAtomic(memoryFile(ctx), JSON.stringify(merged, null, 2), 2);
  }

  const projectWrites = byKind.get('project') ?? [];
  if (projectWrites.length) {
    const settings = readJsonFileSafe<Record<string, unknown>>(ctx.settingsPath, {});
    const list = (Array.isArray(settings.watchedProjects) ? settings.watchedProjects : []) as Array<Record<string, unknown>>;
    for (const w of projectWrites) {
      const id = recordId(w.key);
      const idx = list.findIndex((p) => p && p.id === id);
      if (w.content === null) {
        if (idx >= 0) list.splice(idx, 1);
      } else {
        const project = JSON.parse(w.content.toString('utf8')) as Record<string, unknown>;
        if (idx >= 0) list[idx] = project;
        else list.push(project);
      }
    }
    settings.watchedProjects = list;
    writeFileAtomic(ctx.settingsPath, JSON.stringify(settings, null, 2));
  }

  for (const w of byKind.get('conv') ?? []) {
    const name = recordId(w.key);
    if (!CONVERSATION_FILE.test(name)) throw new Error(`اسم محادثة غير صالح في سجل المزامنة: ${name}`);
    const file = path.join(conversationsDir(ctx), name);
    if (w.content === null) removePathSync(file, { force: true });
    else writeFileAtomic(file, w.content);
  }

  for (const w of byKind.get('flog') ?? []) {
    const name = recordId(w.key);
    if (!FAMILY_LOG_FILE.test(name)) throw new Error(`اسم خطوة غير صالح في سجل المزامنة: ${name}`);
    const file = path.join(familyLogDir(ctx), name);
    if (w.content === null) removePathSync(file, { force: true });
    else writeFileAtomic(file, w.content);
  }

  for (const w of byKind.get('obs') ?? []) {
    const rel = recordId(w.key);
    // ISS-025: سجل باسم غير موحّد (NFD، من 2.0.0/2.0.1 على الماك) لا يُطبَّق على القرص أبداً:
    // على الماك يشير إلى الملف الحقيقي نفسه، فحذفه كان سيحذف الملف الصحيح
    if (rel !== nfc(rel)) continue;
    const file = resolveObsidianPath(ctx, rel);
    if (w.content === null) removePathSync(file, { force: true });
    else writeFileAtomic(file, w.content);
  }

  for (const kind of byKind.keys()) {
    if (!['secret', 'vaultkeys', 'branding', 'memory', 'project', 'conv', 'flog', 'obs'].includes(kind)) {
      throw new Error(`نوع سجل غير معروف: ${kind}`);
    }
  }
}

/**
 * Hint بالعربي: دالة تطبيق سجلات على هذا الجهاز كمعاملة واحدة: تحفظ المحتوى السابق لكل سجل سيتغيّر،
 *               وإن فشل أي جزء تعيد كل شيء كما كان ثم ترمي الخطأ الأصلي.
 *               failAfter للاختبارات فقط (يحقن فشلاً بعد كتابة الأسرار للتأكد من التراجع).
 */
export function applyRecordWrites(ctx: SyncContext, vault: UnlockedVault, writes: RecordWrite[], options: { failAfterWrite?: boolean } = {}): void {
  if (!writes.length) return;
  const before = readLocalRecords(ctx, vault);
  const secretsBefore = vault.secrets.map((s) => ({ ...s }));
  try {
    writeRecords(ctx, vault, writes);
    if (options.failAfterWrite) throw new Error('فشل مُحقَن للاختبار بعد الكتابة');
  } catch (err) {
    try {
      vault.secrets.splice(0, vault.secrets.length, ...secretsBefore);
      const restore: RecordWrite[] = writes
        .filter((w) => recordKind(w.key) !== 'secret')
        .map((w) => ({ key: w.key, content: before.get(w.key) ?? null }));
      writeRecords(ctx, vault, restore);
      persistVault(vault);
    } catch (restoreErr) {
      throw new Error(
        `فشل تطبيق المزامنة، وتعذّرت إعادة الحالة السابقة تلقائياً (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}). ` +
          `استعد من آخر نسخة في data/sync-backups. الخطأ الأصلي: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    throw err;
  }
}

/**
 * Hint بالعربي: دالة توحيد أسماء ملفات Obsidian على هذا الجهاز (ISS-025). على Windows، الملف الذي وصل باسم مفكّك (NFD)
 *               صار ملفاً ثانياً بجانب الأصلي: إن وُجد الأصلي المركّب يُنقل المكرر إلى السلة ويُحذف،
 *               وإلا يُعاد تسميته بالاسم المركّب. على الماك لا شيء (نظام الملفات يعامل الصيغتين كاسم واحد).
 *               المخرجات: عدد الملفات التي عولجت.
 */
export function normalizeObsidianFileNames(ctx: SyncContext, dataKey: Buffer, deviceName: string, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'darwin' || !fs.existsSync(ctx.obsidianDir)) return 0;
  let fixed = 0;
  const touchedDirs = new Set<string>();
  for (const file of listFilesRecursive(ctx.obsidianDir)) {
    const raw = toPosix(path.relative(ctx.obsidianDir, file));
    const rel = nfc(raw);
    if (raw === rel) continue;
    const target = path.join(ctx.obsidianDir, ...rel.split('/'));
    if (fs.existsSync(target)) {
      moveToTrash(ctx, dataKey, `obs:${rel}`, fs.readFileSync(file), `${deviceName} (اسم مكرر بصيغة يونيكود أخرى)`);
      removePathSync(file);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(file, target);
    }
    touchedDirs.add(path.dirname(file));
    fixed += 1;
  }
  // حذف المجلدات المفكّكة الاسم التي فرغت
  const root = path.resolve(ctx.obsidianDir);
  for (let dir of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    while (path.resolve(dir) !== root && path.resolve(dir).startsWith(root) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      removePathSync(dir);
      dir = path.dirname(dir);
    }
  }
  return fixed;
}
