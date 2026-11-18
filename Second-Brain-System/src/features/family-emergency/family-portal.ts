/**
 * ============================================================================
 * الملف: src/features/family-emergency/family-portal.ts
 * القسم: Features -> Family Emergency (بوابة العائلة، 3.1.0)
 * Hint بالعربي: ما تحتاجه العائلة في الطوارئ، كله داخل الخزنة العائلية (يفتحه مفتاح الطوارئ وحده):
 *               - جهات الاتصال المهمة (category = contact)
 *               - تعليمات التعامل مع المطورين والشركات (category = family_instruction)
 *               وكلاهما عنصر في الخزنة نفسها، معلَّم دائماً «يظهر للعائلة»، فيُزامَن ويُنسخ احتياطياً
 *               ويُحسم تعارضه كأي سرّ (بلا فائز تلقائي).
 *               - الفواتير المتكررة: أسرار الفواتير العائلية + فواتير كل مشروع من الإعدادات.
 *               - سجل خطوات الطوارئ المنفّذة: كل إجراء في وضع العائلة يُسجَّل تلقائياً، ومعه ملاحظات
 *                 يكتبها أي من الطرفين. كل خطوة ملف مستقل في data/family-log/ مختوم بالمفتاح العائلي،
 *                 فتكتبه جلسة العائلة (التي لا تملك مفتاح البيانات) ويقرؤه القائد. لا يُعدَّل ولا يُحذف.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { openWithKey, sealWithKey } from '../../core/crypto-engine.ts';
import { ensureDirectoryExists, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { SealedData, SystemBrandingConfig, VaultSecretItem } from '../../shared/types.ts';
import { readDeviceInfo } from '../sync/sync-context.ts';
import { resolveFamilyKey, type UnlockedVault } from '../vault/vault-manager.ts';

/** فئات عناصر البوابة (ليست أسراراً بالمعنى المعتاد، فلا تظهر في قائمة الأسرار) */
export const PORTAL_CATEGORIES = ['contact', 'family_instruction'] as const;
export type PortalCategory = (typeof PORTAL_CATEGORIES)[number];

/** اسم ملف خطوة واحدة في السجل: flog-<وقت بالملّي ثانية>-<8 خانات عشوائية>.enc.json */
export const FAMILY_LOG_FILE = /^flog-[0-9]{13}-[a-f0-9]{8}\.enc\.json$/;
/** أقصى طول لنص الخطوة */
const MAX_LOG_DETAIL = 1000;

/**
 * Hint بالعربي: هل هذا التصنيف من عناصر البوابة؟
 */
export function isPortalCategory(category: string): category is PortalCategory {
  return (PORTAL_CATEGORIES as readonly string[]).includes(category);
}

/** الإجراءات التي تُسجَّل في السجل */
export type FamilyLogAction = 'family_unlock' | 'family_lock' | 'assistant_question' | 'conversation_saved' | 'conversation_deleted' | 'note';

/** خطوة واحدة في السجل (بعد فك الختم) */
export interface FamilyLogEntry {
  id: string;
  at: string;
  deviceName: string;
  actor: 'family' | 'commander';
  action: FamilyLogAction;
  detailAr: string;
}

/** شكل الملف على القرص: الخطوة كلها مختومة بالمفتاح العائلي */
interface FamilyLogFile {
  format: 'second-brain-family-log';
  version: 1;
  sealed: SealedData;
}

/** وصف كل إجراء بالعربية (يظهر في السجل) */
export const FAMILY_LOG_LABELS: Record<FamilyLogAction, string> = {
  family_unlock: '🔓 فُتحت الخزنة العائلية بمفتاح الطوارئ',
  family_lock: '🔒 قُفلت الخزنة العائلية',
  assistant_question: '💬 سؤال للمساعد',
  conversation_saved: '🗂 حُفظت محادثة',
  conversation_deleted: '🗑️ حُذفت محادثة',
  note: '📝 ملاحظة',
};

/**
 * Hint بالعربي: مجلد سجل خطوات الطوارئ على هذا الجهاز.
 */
export function resolveFamilyLogDir(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'family-log');
}

function currentDeviceName(): string {
  try {
    const dataDir = path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data');
    return readDeviceInfo(dataDir)?.deviceName ?? os.hostname();
  } catch {
    return os.hostname();
  }
}

/**
 * Hint بالعربي: المفتاح العائلي للجلسة (جلسة العائلة تحمله مباشرة، والقائد يفكّه من الخزنة). null قبل الترقية.
 */
function familyKeyOf(vault: UnlockedVault): Buffer | null {
  try {
    const key = resolveFamilyKey(vault);
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: دالة إضافة خطوة إلى السجل. لا ترمي أبداً (السجل لا يُفشل الإجراء نفسه).
 *               المخرجات: الخطوة المكتوبة، أو null إن لم تكن الخزنة عائلية بعد (v2) أو فشلت الكتابة.
 */
export function appendFamilyLog(
  vault: UnlockedVault,
  entry: { action: FamilyLogAction; detailAr?: string; actor?: 'family' | 'commander' },
  dir: string = resolveFamilyLogDir(),
  now: number = Date.now()
): FamilyLogEntry | null {
  const key = familyKeyOf(vault);
  if (!key) return null;
  try {
    const rand = crypto.randomBytes(4).toString('hex');
    const name = `flog-${String(now).padStart(13, '0')}-${rand}.enc.json`;
    const item: FamilyLogEntry = {
      id: name.replace(/\.enc\.json$/, ''),
      at: new Date(now).toISOString(),
      deviceName: currentDeviceName(),
      actor: entry.actor ?? (vault.unlockedBy === 'commander' ? 'commander' : 'family'),
      action: entry.action,
      detailAr: String(entry.detailAr ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_LOG_DETAIL),
    };
    const file: FamilyLogFile = { format: 'second-brain-family-log', version: 1, sealed: sealWithKey(JSON.stringify(item), key) };
    ensureDirectoryExists(dir);
    writeFileAtomic(path.join(dir, name), JSON.stringify(file));
    return item;
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: دالة قراءة السجل (الأحدث أولاً). الملف الذي لا يُفتح بالمفتاح الحالي يُعدّ ولا يُعرض.
 */
export function readFamilyLog(vault: UnlockedVault, dir: string = resolveFamilyLogDir(), limit = 200): { entries: FamilyLogEntry[]; unreadable: number; total: number } {
  const key = familyKeyOf(vault);
  if (!key || !fs.existsSync(dir)) return { entries: [], unreadable: 0, total: 0 };
  const names = fs.readdirSync(dir).filter((n) => FAMILY_LOG_FILE.test(n)).sort().reverse();
  const entries: FamilyLogEntry[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (entries.length >= limit) break;
    try {
      const file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FamilyLogFile;
      entries.push(JSON.parse(openWithKey(file.sealed, key).toString('utf8')) as FamilyLogEntry);
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable, total: names.length };
}

/**
 * Hint بالعربي: دالة إعادة ختم السجل بالمفتاح العائلي الحالي إن تغيّر (مفتاح عائلي جديد وصل بالمزامنة).
 *               المخرجات: عدد الملفات التي أُعيد ختمها.
 */
export function resealFamilyLog(vault: UnlockedVault, previousFamilyKey: Buffer | null, dir: string = resolveFamilyLogDir()): number {
  const key = familyKeyOf(vault);
  if (!key || !previousFamilyKey || !fs.existsSync(dir)) return 0;
  let moved = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!FAMILY_LOG_FILE.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FamilyLogFile;
      try {
        openWithKey(file.sealed, key);
        continue; // مختوم بالمفتاح الحالي
      } catch {
        const plain = openWithKey(file.sealed, previousFamilyKey);
        writeFileAtomic(filePath, JSON.stringify({ ...file, sealed: sealWithKey(plain, key) }));
        moved += 1;
      }
    } catch {
      // ملف تالف أو بمفتاح آخر: يُترك كما هو
    }
  }
  return moved;
}

/** جهة اتصال أو تعليمة كما تُعرض في البوابة */
export interface PortalItem {
  id: string;
  category: PortalCategory;
  title: string;
  contact: string;
  url: string;
  textAr: string;
  projectId: string | null;
  updatedAt: string;
}

/** فاتورة متكررة في البوابة */
export interface PortalBill {
  source: 'secret' | 'project';
  title: string;
  detailAr: string;
  url: string;
}

/** محتوى البوابة كاملاً */
export interface FamilyPortal {
  contacts: PortalItem[];
  instructions: PortalItem[];
  bills: PortalBill[];
  projects: Array<{ id: string; name: string; summaryAr: string; monthlyIncome: string; billingNotes: string }>;
}

function toPortalItem(s: VaultSecretItem): PortalItem {
  return {
    id: s.id,
    category: s.category as PortalCategory,
    title: s.title,
    contact: s.usernameOrEmail ?? '',
    url: s.url ?? '',
    textAr: s.notesForWifeAr ?? '',
    projectId: s.projectId ?? null,
    updatedAt: s.updatedAt,
  };
}

/**
 * Hint بالعربي: دالة بناء محتوى البوابة من الخزنة المفتوحة (القائد يرى ما ستراه العائلة بالضبط:
 *               العناصر المعلَّمة للعائلة فقط) ومن مشاريع الإعدادات.
 */
export function buildFamilyPortal(vault: UnlockedVault, config: Pick<SystemBrandingConfig, 'watchedProjects'>): FamilyPortal {
  const visible = vault.secrets.filter((s) => vault.unlockedBy !== 'commander' || s.familyVisible === true);
  const byTitle = (a: PortalItem, b: PortalItem): number => a.title.localeCompare(b.title, 'ar');
  const bills: PortalBill[] = visible
    .filter((s) => s.category === 'billing')
    .map((s) => ({ source: 'secret' as const, title: s.title, detailAr: s.notesForWifeAr ?? '', url: s.url ?? '' }));
  for (const p of config.watchedProjects ?? []) {
    if (p.billingNotes && p.billingNotes.trim()) bills.push({ source: 'project', title: p.name, detailAr: p.billingNotes.trim(), url: '' });
  }
  return {
    contacts: visible.filter((s) => s.category === 'contact').map(toPortalItem).sort(byTitle),
    instructions: visible.filter((s) => s.category === 'family_instruction').map(toPortalItem).sort(byTitle),
    bills,
    projects: (config.watchedProjects ?? []).map((p) => ({ id: p.id, name: p.name, summaryAr: p.wifeSummaryAr ?? '', monthlyIncome: p.monthlyIncome ?? '', billingNotes: p.billingNotes ?? '' })),
  };
}

/**
 * Hint بالعربي: نص البوابة للمساعد العائلي (جهات الاتصال والتعليمات)، بلا أي قيمة سرية.
 */
export function describePortalForAssistant(portal: FamilyPortal): string {
  const contacts = portal.contacts.map((c) => `- ${c.title}${c.contact ? ` (${c.contact})` : ''}${c.textAr ? `: ${c.textAr}` : ''}`).join('\n');
  const instructions = portal.instructions.map((i) => `- ${i.title}: ${i.textAr}`).join('\n');
  return `جهات الاتصال المهمة:\n${contacts || '- لم يُضِف القائد جهات اتصال بعد.'}\n\nتعليمات القائد للتعامل مع المطورين والشركات:\n${instructions || '- لم يُضِف القائد تعليمات بعد.'}`;
}
