/**
 * ============================================================================
 * الملف: src/core/folder-permissions.ts
 * القسم: Core (فحص صلاحيات مجلد البرنامج — ISS-046)
 * Hint بالعربي: كود الخادم وسكربت التشغيل والإعدادات والبيانات كلها داخل مجلد البرنامج. إن كان هذا المجلد
 *               قابلاً للكتابة من حسابات أخرى على الجهاز (مثل Authenticated Users الموروثة من القرص D:)
 *               فأي حساب منها يزرع كوداً يعمل باسم القائد عند التشغيل التالي. هذا الملف يفحص ذلك عند بدء
 *               الخادم ويُظهر تحذيراً في الواجهة. لا يغيّر أي صلاحية بنفسه: الإصلاح أمر يشغّله القائد (docs/13).
 * ============================================================================
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** نتيجة فحص الصلاحيات */
export interface FolderPermissionStatus {
  checked: boolean;
  open: boolean;
  broadWriters: string[];
  detailAr: string;
}

/** حسابات عامة على Windows (بالمعرّف، لأن الأسماء تختلف بلغة النظام) */
const BROAD_SIDS: Record<string, string> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-7': 'Anonymous',
  'S-1-5-4': 'Interactive',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-545': 'Users',
  'S-1-5-32-546': 'Guests',
};

/**
 * بتات الكتابة في قناع صلاحيات NTFS: WriteData، AppendData، DeleteSubdirectoriesAndFiles، Delete،
 * WRITE_DAC، WRITE_OWNER، GENERIC_ALL، GENERIC_WRITE.
 */
const WRITE_MASK = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/**
 * Hint بالعربي: دالة تحليل أسطر الصلاحيات على Windows بصيغة «SID|القناع|Allow أو Deny».
 *               المخرجات: أسماء الحسابات العامة التي تملك صلاحية كتابة (بلا تكرار).
 */
export function findBroadWindowsWriters(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    const [sid, mask, type] = line.trim().split('|');
    if (!sid || type !== 'Allow' || !(sid in BROAD_SIDS)) continue;
    const bits = Number(mask) >>> 0;
    if (bits & WRITE_MASK) found.add(BROAD_SIDS[sid]);
  }
  return [...found];
}

/**
 * Hint بالعربي: دالة قراءة صلاحيات مجلد على Windows عبر Get-Acl (قراءة فقط، بالمعرّفات والأقنعة الرقمية).
 */
function readWindowsAclLines(dir: string): string[] {
  const literal = dir.replace(/'/g, "''");
  const script = `(Get-Acl -LiteralPath '${literal}').Access | ForEach-Object { try { $s = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $s = [string]$_.IdentityReference }; $s + '|' + [int]$_.FileSystemRights + '|' + $_.AccessControlType }`;
  // المسار الكامل لـ PowerShell الخاص بـ Windows، لا أول ما يجده PATH
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', timeout: 15000, windowsHide: true });
  return out.split(/\r?\n/).filter(Boolean);
}

/**
 * Hint بالعربي: دالة فحص مجلد واحد: هل يكتب فيه حساب غير صاحبه؟
 *               Windows: حسابات عامة بصلاحية كتابة. macOS/Linux: بت الكتابة للمجموعة أو للآخرين.
 *               المدخلات: المسار، وقارئ أسطر اختياري (للاختبار). لا يرمي خطأ أبداً: الفشل ← checked=false.
 */
export function checkFolderPermissions(dir: string, readAcl: (d: string) => string[] = readWindowsAclLines): FolderPermissionStatus {
  try {
    if (process.platform === 'win32') {
      const broadWriters = findBroadWindowsWriters(readAcl(dir));
      return broadWriters.length
        ? { checked: true, open: true, broadWriters, detailAr: `⚠️ مجلد البرنامج قابل للتعديل من حسابات أخرى على هذا الجهاز (${broadWriters.join('، ')}). أي حساب منها يستطيع تغيير كود الخادم فيعمل باسمك. الإصلاح في docs/13 (ISS-046).` }
        : { checked: true, open: false, broadWriters: [], detailAr: 'صلاحيات مجلد البرنامج لصاحبه وحده.' };
    }
    const mode = fs.statSync(dir).mode;
    const broadWriters = [...(mode & 0o020 ? ['group'] : []), ...(mode & 0o002 ? ['others'] : [])];
    return broadWriters.length
      ? { checked: true, open: true, broadWriters, detailAr: `⚠️ مجلد البرنامج قابل للكتابة من ${broadWriters.includes('others') ? 'كل الحسابات' : 'المجموعة'} على هذا الجهاز. الإصلاح: chmod go-w على المجلد (docs/13، ISS-046).` }
      : { checked: true, open: false, broadWriters: [], detailAr: 'صلاحيات مجلد البرنامج لصاحبه وحده.' };
  } catch {
    return { checked: false, open: false, broadWriters: [], detailAr: 'تعذّر فحص صلاحيات مجلد البرنامج.' };
  }
}

let cachedStatus: FolderPermissionStatus | null = null;

/**
 * Hint بالعربي: دالة فحص مجلد البرنامج مرة عند بدء الخادم وحفظ النتيجة لمسار /api/health.
 */
export function runStartupFolderPermissionCheck(rootDir: string): FolderPermissionStatus {
  cachedStatus = checkFolderPermissions(rootDir);
  return cachedStatus;
}

/**
 * Hint بالعربي: آخر نتيجة فحص (null إن لم يُفحص بعد، كما في الاختبارات).
 */
export function getFolderPermissionStatus(): FolderPermissionStatus | null {
  return cachedStatus;
}

/**
 * Hint بالعربي: تصفير النتيجة المحفوظة (للاختبارات فقط).
 */
export function resetFolderPermissionStatusForTests(): void {
  cachedStatus = null;
}
