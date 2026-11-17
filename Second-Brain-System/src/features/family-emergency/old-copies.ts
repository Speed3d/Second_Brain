/**
 * ============================================================================
 * الملف: src/features/family-emergency/old-copies.ts
 * القسم: Features -> Family Emergency (النسخ القديمة بعد الترقية إلى الخزنة العائلية)
 * Hint بالعربي: بعد الترقية إلى الخزنة العائلية (v3) يبقى مفتاح الطوارئ القديم قادراً على فتح كل نسخة
 *               كُتبت قبلها، لأنها تحمل غلاف الطوارئ القديم (emergencyWrap) الذي يفتح مفتاح البيانات نفسه.
 *               هذا الملف يحصي تلك النسخ ليعرضها على القائد، ويحذفها بموافقته فقط:
 *               - نسخ الطوارئ بالصيغة 2 (المحلية، والمجلد الإضافي، و Backups على Drive).
 *               - النسخ السابقة لملف الخزنة (vault.aes256.json.bak-N) بالصيغة 2.
 *               - نسخ المزامنة الكاملة (snapshots-v2) والنسخ القديمة بصيغة 1.9 (snapshots) على Drive.
 *               نسخ «قبل الاستيراد» المحلية مختومة بمفتاح البيانات وحده، فلا يفتحها مفتاح الطوارئ، ولا تُعرض.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFileSafe, removePathSync } from '../../shared/file-helpers.ts';
import { logSystemInfo } from '../../core/logger.ts';

/** نسخة قديمة يفتحها مفتاح الطوارئ القديم */
export interface OldFullAccessCopy {
  filePath: string;
  kind: 'backup' | 'vault-backup' | 'sync-snapshot' | 'legacy-snapshot';
  labelAr: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** أماكن البحث */
export interface OldCopiesLocations {
  vaultFilePath: string;
  backupDirs: string[];
  /** مجلد Second-Brain-Sync على Drive (إن وُجد) */
  syncRoot?: string;
}

const KIND_LABEL: Record<OldFullAccessCopy['kind'], string> = {
  backup: 'نسخة طوارئ قديمة (الصيغة 2)',
  'vault-backup': 'نسخة سابقة من ملف الخزنة',
  'sync-snapshot': 'نسخة مزامنة كاملة قديمة على Drive',
  'legacy-snapshot': 'نسخة مزامنة بصيغة 1.9 على Drive',
};

function hasOldEmergencyWrap(filePath: string): boolean {
  const json = readJsonFileSafe<Record<string, unknown> | null>(filePath, null);
  if (!json) return false;
  const keys = (json.vaultKeys ?? json) as Record<string, unknown>;
  return Boolean(keys && typeof keys === 'object' && keys.emergencyWrap);
}

function entry(filePath: string, kind: OldFullAccessCopy['kind']): OldFullAccessCopy {
  const st = fs.statSync(filePath);
  return { filePath, kind, labelAr: KIND_LABEL[kind], sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
}

function listJson(dir: string, test: (name: string) => boolean): string[] {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(test)
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile());
}

/**
 * Hint بالعربي: دالة حصر كل النسخ التي ما زال يفتحها مفتاح الطوارئ القديم (تحمل emergencyWrap).
 */
export function listOldFullAccessCopies(loc: OldCopiesLocations): OldFullAccessCopy[] {
  const out: OldFullAccessCopy[] = [];
  const seen = new Set<string>();
  const push = (p: string, kind: OldFullAccessCopy['kind']): void => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (hasOldEmergencyWrap(p)) out.push(entry(p, kind));
  };
  const vaultDir = path.dirname(loc.vaultFilePath);
  const vaultBase = path.basename(loc.vaultFilePath);
  for (const p of listJson(vaultDir, (n) => n.startsWith(`${vaultBase}.bak-`))) push(p, 'vault-backup');
  for (const dir of loc.backupDirs) for (const p of listJson(dir, (n) => n.startsWith('Second-Brain-Backup-') && n.endsWith('.enc.json'))) push(p, 'backup');
  if (loc.syncRoot) {
    for (const p of listJson(path.join(loc.syncRoot, 'snapshots-v2'), (n) => n.endsWith('.enc.json'))) push(p, 'sync-snapshot');
    for (const p of listJson(path.join(loc.syncRoot, 'snapshots'), (n) => n.endsWith('.enc.json'))) push(p, 'legacy-snapshot');
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Hint بالعربي: دالة حذف النسخ القديمة (بعد موافقة القائد). تعيد الحصر قبل الحذف، فلا تحذف إلا ما يحمل
 *               غلاف الطوارئ القديم فعلاً. المخرجات: عدد المحذوف وما تعذّر حذفه.
 */
export function removeOldFullAccessCopies(loc: OldCopiesLocations): { removed: number; failed: string[] } {
  let removed = 0;
  const failed: string[] = [];
  for (const copy of listOldFullAccessCopies(loc)) {
    try {
      removePathSync(copy.filePath, { force: true });
      if (fs.existsSync(copy.filePath)) failed.push(copy.filePath);
      else removed += 1;
    } catch {
      failed.push(copy.filePath);
    }
  }
  logSystemInfo('OldCopies', `حُذفت ${removed} نسخة قديمة يفتحها مفتاح الطوارئ القديم${failed.length ? `، وتعذّر حذف ${failed.length}` : ''}.`);
  return { removed, failed };
}
