/**
 * ============================================================================
 * الملف: src/tools/restore-drill.ts
 * القسم: Tools (تمرين الاستعادة — قرار القائد في docs/11، والخطة docs/12 البند 1.4)
 * Hint بالعربي: نجاح إنشاء النسخة الاحتياطية لا يكفي؛ يجب أن نعرف أنها تُستعاد فعلاً.
 *               التمرين يستعيد نسخة حقيقية إلى مجلد مؤقت معزول، ثم يتحقق من ست نقاط:
 *               1) فتح الخزنة  2) سلامة كل المحادثات  3) اكتمال الذاكرة  4) المشاريع
 *               5) سلامة ملفات Obsidian (بصمة كل ملف)  6) عدم فقدان أي ملف أثناء الاستعادة،
 *               ومقارنة إعلامية مع حالة الجهاز الحالية. ثم يحذف المجلد المؤقت ويحفظ تقريراً بلا أسرار.
 *               يُفضَّل تشغيله على جهاز غير الذي أنشأ النسخة (مثلاً الماك يستعيد نسخة Windows).
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openWithKey } from '../core/crypto-engine.ts';
import { logSystemInfo } from '../core/logger.ts';
import { listFilesRecursive, removePathSync, writeFileAtomic } from '../shared/file-helpers.ts';
import type { SealedData } from '../shared/types.ts';
import { listEncryptedBackups, openEncryptedBackup, restoreEncryptedBackup } from '../features/family-emergency/backup-service.ts';
import { unlockVault } from '../features/vault/vault-manager.ts';

/** نسخة احتياطية وُجدت في أحد مجلدات النسخ */
export interface BackupCandidate {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  location: 'local' | 'extra' | 'drive';
}

/** عمر النسخة الذي يُنبَّه بعده */
export const BACKUP_AGE_WARNING_DAYS = 7;

/**
 * Hint بالعربي: دالة جمع النسخ الاحتياطية من كل الأماكن (ISS-030): مجلد النسخ المحلي، والمجلد الإضافي من الإعدادات،
 *               ومجلد Backups على Drive بجانب مجلد المزامنة (`<مجلد المزامنة>/Backups`) حتى بلا أي إعداد،
 *               لأن الجهاز الآخر (الماك، أو جهاز جديد بعد كارثة) قد لا يملك نسخة محلية حديثة.
 *               النسخة نفسها في مكانين تظهر مرة واحدة. الترتيب: الأحدث أولاً (الاسم يحمل التاريخ).
 */
export function findBackupCandidates(dirs: { localDir?: string; extraDir?: string; syncFolder?: string }): BackupCandidate[] {
  const seen = new Map<string, BackupCandidate>();
  const add = (dir: string | undefined, location: BackupCandidate['location']): void => {
    if (!dir) return;
    for (const b of listEncryptedBackups(dir)) {
      if (!seen.has(b.fileName)) seen.set(b.fileName, { fileName: b.fileName, filePath: b.filePath, sizeBytes: b.sizeBytes, location });
    }
  };
  add(dirs.localDir, 'local');
  add(dirs.extraDir, 'extra');
  add(dirs.syncFolder ? path.join(dirs.syncFolder, 'Backups') : undefined, 'drive');
  return [...seen.values()].sort((a, b) => b.fileName.localeCompare(a.fileName));
}

/**
 * Hint بالعربي: دالة عمر النسخة بالأيام (من تاريخ إنشائها داخل النسخة)، ورسالة تنبيه إن تجاوزت 7 أيام.
 */
export function describeBackupAge(createdAt: string, now: number = Date.now()): { ageDays: number; warningAr?: string } {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return { ageDays: -1, warningAr: 'تاريخ إنشاء النسخة غير معروف.' };
  const ageDays = Math.floor((now - ms) / (24 * 3600 * 1000));
  return ageDays > BACKUP_AGE_WARNING_DAYS
    ? { ageDays, warningAr: `⚠️ هذه النسخة عمرها ${ageDays} يوماً، فهي لا تحتوي آخر بياناتك. أنشئ نسخة جديدة من «💾 نسخة احتياطية الآن» ثم أعد التمرين.` }
    : { ageDays };
}

/** نتيجة فحص واحد في التمرين */
export interface DrillCheck {
  nameAr: string;
  ok: boolean;
  detailAr: string;
}

/** تقرير التمرين (يُحفظ بلا أي سر) */
export interface RestoreDrillReport {
  backupFile: string;
  backupCreatedAt: string;
  ranAt: string;
  device: string;
  filesCount: number;
  /** عمر النسخة بالأيام، وتنبيه إن كانت أقدم من 7 أيام (ISS-030) */
  backupAgeDays: number;
  ageWarningAr?: string;
  /** مكان النسخة: محلي، أو المجلد الإضافي، أو Drive */
  location?: BackupCandidate['location'];
  durationMs: number;
  ok: boolean;
  checks: DrillCheck[];
  /** مقارنة إعلامية مع حالة الجهاز الآن (النسخة قد تكون أقدم، فهذا ليس فشلاً) */
  comparedWithLive?: { obsidianFilesOnlyLive: number; conversationsOnlyLive: number; memoryOnlyLive: number };
}

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Hint بالعربي: دالة تشغيل تمرين الاستعادة. المدخلات: ملف النسخة، وكلمة المرور الرئيسية (أو مفتاح الطوارئ)،
 *               ومجلد الجهاز الحالي للمقارنة (اختياري)، ومجلد حفظ التقارير (اختياري).
 */
export function runRestoreDrill(
  backupFilePath: string,
  passwordOrKey: string,
  options: { liveRootDir?: string; reportsDir?: string; deviceName?: string; location?: BackupCandidate['location']; now?: number } = {}
): RestoreDrillReport {
  const started = Date.now();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-drill-'));
  const target = path.join(tempRoot, 'restored');
  const checks: DrillCheck[] = [];
  let backupCreatedAt = '';
  let filesCount = 0;
  let comparedWithLive: RestoreDrillReport['comparedWithLive'];
  try {
    const snapshot = openEncryptedBackup(backupFilePath, passwordOrKey);
    backupCreatedAt = snapshot.createdAt;
    const restored = restoreEncryptedBackup(backupFilePath, passwordOrKey, target);
    filesCount = restored.files.length;
    const rels = Object.keys(snapshot.filesMap);

    // 1) فتح الخزنة
    const vaultRel = rels.find((r) => /(^|\/)encrypted-vault\/[^/]+\.json$/.test(r));
    let dataKey: Buffer | null = null;
    if (!vaultRel) {
      checks.push({ nameAr: 'فتح الخزنة', ok: false, detailAr: 'لا يوجد ملف خزنة داخل النسخة.' });
    } else {
      try {
        const vault = unlockVault(passwordOrKey, path.join(target, vaultRel));
        dataKey = vault.dataKey;
        checks.push({ nameAr: 'فتح الخزنة', ok: true, detailAr: `فُتحت الخزنة المستعادة (${vault.secrets.length} سرّاً).` });
      } catch (err) {
        checks.push({ nameAr: 'فتح الخزنة', ok: false, detailAr: `تعذّر فتح الخزنة المستعادة: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // 2) المحادثات
    const convRels = rels.filter((r) => /(^|\/)data\/conversations\/[a-z0-9-]{8,64}\.enc\.json$/.test(r));
    let convOk = 0;
    const convBad: string[] = [];
    for (const rel of convRels) {
      try {
        const file = JSON.parse(fs.readFileSync(path.join(target, rel), 'utf8')) as { sealed: SealedData };
        if (!dataKey) throw new Error('no key');
        openWithKey(file.sealed, dataKey);
        convOk += 1;
      } catch {
        convBad.push(path.posix.basename(rel));
      }
    }
    checks.push({
      nameAr: 'سلامة المحادثات',
      ok: convBad.length === 0,
      detailAr: convRels.length ? `${convOk} من ${convRels.length} محادثة تُفتح سليمة${convBad.length ? `، وتعذّر فتح: ${convBad.slice(0, 5).join('، ')}` : ''}.` : 'لا محادثات في هذه النسخة (النسخ قبل 2.0 لم تكن تضمها — ISS-020).',
    });

    // 3) الذاكرة
    const memRel = rels.find((r) => r.endsWith('data/ai-memory-store.json'));
    let memoryIds: string[] = [];
    if (!memRel) checks.push({ nameAr: 'اكتمال الذاكرة', ok: true, detailAr: 'لا ذاكرة مشتركة في النسخة بعد.' });
    else {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(target, memRel), 'utf8')) as Array<{ id?: string }>;
        memoryIds = arr.map((e) => String(e.id ?? '')).filter(Boolean);
        const dupes = memoryIds.length - new Set(memoryIds).size;
        checks.push({ nameAr: 'اكتمال الذاكرة', ok: dupes === 0, detailAr: `${memoryIds.length} سجلاً${dupes ? `، منها ${dupes} مكرر` : ''}.` });
      } catch (err) {
        checks.push({ nameAr: 'اكتمال الذاكرة', ok: false, detailAr: `ملف الذاكرة تالف: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // 4) المشاريع
    const settingsRel = rels.find((r) => r.endsWith('config/settings.json'));
    if (!settingsRel) checks.push({ nameAr: 'المشاريع', ok: false, detailAr: 'ملف الإعدادات (المشاريع) غير موجود في النسخة.' });
    else {
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(target, settingsRel), 'utf8')) as { watchedProjects?: Array<{ id?: string; name?: string }> };
        const projects = settings.watchedProjects ?? [];
        const broken = projects.filter((p) => !p.id || !p.name).length;
        checks.push({ nameAr: 'المشاريع', ok: broken === 0, detailAr: `${projects.length} مشروعاً${broken ? `، منها ${broken} ناقص البيانات` : ''}.` });
      } catch (err) {
        checks.push({ nameAr: 'المشاريع', ok: false, detailAr: `ملف الإعدادات تالف: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // 5) Obsidian: بصمة كل ملف مستعاد تطابق النسخة
    const obsRels = rels.filter((r) => r.startsWith('Obsidian-Vault/'));
    const mismatched = obsRels.filter((r) => sha(fs.readFileSync(path.join(target, r))) !== sha(Buffer.from(snapshot.filesMap[r], 'base64')));
    checks.push({ nameAr: 'سلامة ملفات Obsidian', ok: mismatched.length === 0, detailAr: `${obsRels.length - mismatched.length} من ${obsRels.length} ملفاً مطابقاً للنسخة.` });

    // 6) لا فقد أثناء الاستعادة: كل ملف في النسخة موجود على القرص بعد الاستعادة
    const onDisk = new Set(listFilesRecursive(target).map((f) => path.relative(target, f).replace(/\\/g, '/')));
    const missing = rels.filter((r) => !onDisk.has(r));
    checks.push({ nameAr: 'عدم فقدان أي ملف', ok: missing.length === 0, detailAr: missing.length ? `${missing.length} ملفاً لم يُستعد.` : `كل الملفات (${rels.length}) استُعيدت.` });

    // مقارنة إعلامية مع الجهاز الحالي
    if (options.liveRootDir) {
      const liveObs = path.join(options.liveRootDir, 'Obsidian-Vault');
      const liveObsRels = fs.existsSync(liveObs) ? listFilesRecursive(liveObs).map((f) => `Obsidian-Vault/${path.relative(liveObs, f).replace(/\\/g, '/')}`) : [];
      const liveConvDir = path.join(options.liveRootDir, 'Second-Brain-System', 'data', 'conversations');
      const liveConv = fs.existsSync(liveConvDir) ? fs.readdirSync(liveConvDir).filter((n) => n.endsWith('.enc.json')) : [];
      const backupConvNames = new Set(convRels.map((r) => path.posix.basename(r)));
      let liveMemory: string[] = [];
      try {
        liveMemory = (JSON.parse(fs.readFileSync(path.join(options.liveRootDir, 'Second-Brain-System', 'data', 'ai-memory-store.json'), 'utf8')) as Array<{ id?: string }>).map((e) => String(e.id ?? ''));
      } catch {
        liveMemory = [];
      }
      const memSet = new Set(memoryIds);
      const obsSet = new Set(obsRels);
      comparedWithLive = {
        obsidianFilesOnlyLive: liveObsRels.filter((r) => !obsSet.has(r) && !/\/\.obsidian\/workspace|\/\.trash\//.test(r)).length,
        conversationsOnlyLive: liveConv.filter((n) => !backupConvNames.has(n)).length,
        memoryOnlyLive: liveMemory.filter((id) => id && !memSet.has(id)).length,
      };
    }
  } catch (err) {
    checks.push({ nameAr: 'فتح النسخة واستعادتها', ok: false, detailAr: err instanceof Error ? err.message : String(err) });
  } finally {
    removePathSync(tempRoot, { recursive: true, force: true });
  }

  const age = backupCreatedAt ? describeBackupAge(backupCreatedAt, options.now) : { ageDays: -1 };
  const report: RestoreDrillReport = {
    backupFile: path.basename(backupFilePath),
    backupCreatedAt,
    backupAgeDays: age.ageDays,
    ageWarningAr: age.warningAr,
    location: options.location,
    ranAt: new Date().toISOString(),
    device: options.deviceName ?? os.hostname(),
    filesCount,
    durationMs: Date.now() - started,
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checks,
    comparedWithLive,
  };
  if (options.reportsDir) {
    writeFileAtomic(path.join(options.reportsDir, `drill-${report.ranAt.replace(/[:.]/g, '-').slice(0, 19)}.json`), JSON.stringify(report, null, 2));
  }
  logSystemInfo('RestoreDrill', `تمرين استعادة ${report.ok ? 'ناجح' : 'فيه مشكلات'} للنسخة ${report.backupFile} (${filesCount} ملفاً، ${report.durationMs}ms).`);
  return report;
}
