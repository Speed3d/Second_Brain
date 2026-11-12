/**
 * ============================================================================
 * الملف: src/features/maintenance/reset-service.ts
 * القسم: Features -> Maintenance (وضع التطوير: التصفير إلى السلة والاسترجاع)
 * Hint بالعربي: خلال مرحلة التطوير يمكن "تصفير" البرنامج للبدء من جديد، لكن دون حذف أي شيء:
 *               كل البيانات الشخصية تُنقل إلى سلة `data/_trash/<التاريخ>/` مع بيان (manifest.json)
 *               بمكان كل عنصر الأصلي، فيمكن استرجاع آخر تصفير، أو إفراغ السلة نهائياً بزر منفصل.
 *               ما يُنقل: الخزنة، كتيبات الطوارئ، الإعدادات الشخصية، الذاكرة وحالة السحب والفحص، السجلات،
 *               وما ولّده البرنامج في Obsidian. لا يُمس: الكود، الوثائق، ملف القائد وأدلة العائلة المكتوبة يدوياً،
 *               ولا النسخ الاحتياطية المشفرة.
 *               إعدادات مسارات الجهاز (paths, serverPort) تبقى حتى يعرف البرنامج أين يعمل بعد التصفير.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, readRawSettings, resolveDefaultConfigPath, resolveSettingsPath } from '../../core/config-manager.ts';
import { writeFileAtomic } from '../../shared/file-helpers.ts';

/** عبارات التأكيد التي يجب كتابتها حرفياً (تُقارن بعد توحيد الهمزات والمسافات) */
export const RESET_CONFIRM_PHRASE = 'تصفير';
export const EMPTY_TRASH_CONFIRM_PHRASE = 'إفراغ السلة';
export const FINALIZE_CONFIRM_PHRASE = 'اعتماد نهائي';

/**
 * Hint بالعربي: عنصر واحد داخل دفعة في السلة: مساره الأصلي، واسمه داخل الدفعة.
 */
export interface TrashItem {
  original: string;
  stored: string;
}

/**
 * Hint بالعربي: بيان دفعة في السلة (تصفير، أو حالة محفوظة قبل الاسترجاع).
 */
export interface TrashManifest {
  id: string;
  kind: 'reset' | 'before-restore';
  createdAt: string;
  items: TrashItem[];
}

/**
 * Hint بالعربي: دالة توحيد عبارة التأكيد (الهمزات والمسافات) حتى لا تفشل بسبب طريقة الكتابة.
 */
export function normalizeConfirmPhrase(text: unknown): string {
  return String(text ?? '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hint بالعربي: دالة التحقق من عبارة التأكيد. المخرجات: true إذا طابقت.
 */
export function matchesConfirmPhrase(input: unknown, phrase: string): boolean {
  return normalizeConfirmPhrase(input) === normalizeConfirmPhrase(phrase);
}

/**
 * Hint بالعربي: دالة معرفة هل وضع التطوير مفعّل (يُطفأ مرة واحدة عند الاعتماد النهائي).
 */
export function isDeveloperModeEnabled(): boolean {
  return loadSystemConfig().developerMode !== false;
}

/**
 * Hint بالعربي: دالة تحديد مجلد بيانات البرنامج ومجلد السلة.
 */
export function resolveSystemDataDir(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data');
}

export function resolveTrashDir(): string {
  return path.join(resolveSystemDataDir(), '_trash');
}

/**
 * Hint بالعربي: دالة سرد كل المسارات التي يشملها التصفير (الموجودة فعلاً فقط).
 */
export function listResetTargets(configPath: string = resolveDefaultConfigPath()): string[] {
  const config = loadSystemConfig(configPath);
  const dataDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data');
  const obsidian = config.paths.obsidianVaultDir;
  const configDir = path.dirname(configPath);
  const configNames = [path.basename(configPath), path.basename(resolveSettingsPath(configPath))];

  const targets = [
    path.dirname(config.paths.encryptedVaultFile),
    config.paths.emergencyKitsDir,
    path.join(dataDir, 'ai-memory-store.json'),
    path.join(dataDir, 'conversations'),
    path.join(dataDir, 'harvest-state.json'),
    path.join(dataDir, 'project-scan-state.json'),
    path.join(dataDir, 'logs'),
    path.join(obsidian, '02-Projects'),
    path.join(obsidian, '03-AI-Shared-Memory', 'Antigravity-Sessions'),
    path.join(obsidian, '03-AI-Shared-Memory', 'Claude-Code-Sessions'),
    path.join(obsidian, '03-AI-Shared-Memory', 'Memory-Stream.md'),
  ];
  // ملفات الإعدادات الشخصية ونسخها السابقة والمؤقتة
  if (fs.existsSync(configDir)) {
    for (const name of fs.readdirSync(configDir)) {
      if (configNames.some((base) => name === base || name.startsWith(`${base}.bak-`) || name.startsWith(`${base}.tmp-`))) {
        targets.push(path.join(configDir, name));
      }
    }
  }
  const trash = path.resolve(path.join(dataDir, '_trash'));
  const backups = path.resolve(config.paths.encryptedBackupsDir);
  return [...new Set(targets.map((t) => path.resolve(t)))].filter(
    (t) => fs.existsSync(t) && t !== trash && t !== backups && !backups.startsWith(t + path.sep) && !trash.startsWith(t + path.sep)
  );
}

/**
 * Hint بالعربي: دالة نقل ملف أو مجلد (مع بديل النسخ ثم الحذف إن تعذّر النقل المباشر بين الأقراص).
 */
export function moveEntry(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Hint بالعربي: دالة إنشاء دفعة جديدة في السلة ونقل المسارات إليها مع كتابة البيان.
 */
function moveToNewBatch(targets: string[], kind: TrashManifest['kind']): TrashManifest {
  const createdAt = new Date().toISOString();
  let id = `${createdAt.replace(/[:.]/g, '-')}-${kind}`;
  const trashDir = resolveTrashDir();
  for (let n = 2; fs.existsSync(path.join(trashDir, id)); n++) id = `${createdAt.replace(/[:.]/g, '-')}-${kind}-${n}`;
  const batchDir = path.join(trashDir, id);
  fs.mkdirSync(batchDir, { recursive: true });
  const manifest: TrashManifest = { id, kind, createdAt, items: [] };
  targets.forEach((target, i) => {
    const stored = `${String(i).padStart(2, '0')}-${path.basename(target)}`;
    moveEntry(target, path.join(batchDir, stored));
    manifest.items.push({ original: target, stored });
    // يُكتب البيان بعد كل عنصر حتى لا يضيع مكان أي عنصر إن توقفت العملية في المنتصف
    fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  });
  fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Hint بالعربي: دالة تصفير البرنامج: نقل كل البيانات الشخصية إلى السلة، مع إبقاء إعدادات مسارات الجهاز.
 *               المخرجات: بيان الدفعة.
 */
export function resetToTrash(configPath: string = resolveDefaultConfigPath()): TrashManifest {
  const raw = readRawSettings(configPath);
  const keep: Record<string, unknown> = {};
  if (raw.paths) keep.paths = raw.paths;
  if (raw.serverPort) keep.serverPort = raw.serverPort;
  const manifest = moveToNewBatch(listResetTargets(configPath), 'reset');
  if (Object.keys(keep).length) writeFileAtomic(resolveSettingsPath(configPath), JSON.stringify(keep, null, 2), 0);
  return manifest;
}

/**
 * Hint بالعربي: دالة سرد دفعات السلة (الأحدث أولاً) مع عدد العناصر.
 */
export function listTrashBatches(): TrashManifest[] {
  const trashDir = resolveTrashDir();
  if (!fs.existsSync(trashDir)) return [];
  const batches: TrashManifest[] = [];
  for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      batches.push(JSON.parse(fs.readFileSync(path.join(trashDir, entry.name, 'manifest.json'), 'utf-8')) as TrashManifest);
    } catch {
      /* دفعة بلا بيان صالح: تُتجاهل في القائمة وتبقى في السلة */
    }
  }
  return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/**
 * Hint بالعربي: دالة استرجاع آخر دفعة في السلة. الحالة الحالية لا تُحذف بل تُنقل أولاً إلى دفعة جديدة
 *               (قبل الاسترجاع)، فيمكن التبديل بينهما مرة أخرى. المخرجات: الدفعة المسترجعة.
 */
export function restoreLastBatch(configPath: string = resolveDefaultConfigPath()): TrashManifest {
  const last = listTrashBatches()[0];
  if (!last) throw new Error('السلة فارغة؛ لا يوجد تصفير لاسترجاعه.');
  const batchDir = path.join(resolveTrashDir(), last.id);
  for (const item of last.items) {
    if (!fs.existsSync(path.join(batchDir, item.stored))) throw new Error(`عنصر مفقود من السلة: ${item.stored}`);
  }
  // تُحفظ الحالة الحالية أولاً (بما فيها أي عنصر سيُستبدل) حتى لا يضيع شيء
  const current = new Set(listResetTargets(configPath));
  for (const item of last.items) if (fs.existsSync(item.original)) current.add(path.resolve(item.original));
  const outer = [...current].filter((p) => ![...current].some((q) => q !== p && p.startsWith(q + path.sep)));
  if (outer.length) moveToNewBatch(outer, 'before-restore');
  for (const item of last.items) moveEntry(path.join(batchDir, item.stored), item.original);
  fs.rmSync(batchDir, { recursive: true, force: true });
  return last;
}

/**
 * Hint بالعربي: دالة إفراغ السلة نهائياً (حذف لا رجعة فيه). المخرجات: عدد الدفعات المحذوفة.
 */
export function emptyTrash(): number {
  const count = listTrashBatches().length;
  fs.rmSync(resolveTrashDir(), { recursive: true, force: true });
  return count;
}
