/**
 * ============================================================================
 * الملف: src/features/vault/family-vault.ts
 * القسم: Features -> Vault (الخزنة العائلية: الاقتراحات وحالة الترقية)
 * Hint بالعربي: معالج «ما تحتاجه العائلة»: يقترح الأسرار المناسبة للعائلة حسب الفئة والكلمات
 *               (الاستضافة، والمتاجر، والنطاقات، والبريد، والفواتير)، والقائد يعتمد كل سرّ أو يرفضه.
 *               ومعه حالة الخزنة للواجهة (الصيغة، وعدد أسرار العائلة) وأماكن النسخ القديمة.
 * ============================================================================
 */

import * as path from 'node:path';
import type { VaultSecretItem } from '../../shared/types.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { buildSyncContext, readSyncSettings } from '../sync/sync-context.ts';
import type { OldCopiesLocations } from '../family-emergency/old-copies.ts';
import { readVaultFile, vaultExists, type UnlockedVault } from './vault-manager.ts';

/** اقتراح واحد في المعالج */
export interface FamilySuggestion {
  id: string;
  title: string;
  category: VaultSecretItem['category'];
  usernameOrEmail: string;
  suggested: boolean;
  reasonAr: string;
  familyVisible: boolean;
}

/** كلمات تدل على ما تحتاجه العائلة (عربي وإنجليزي) */
const FAMILY_HINTS: Array<{ re: RegExp; reasonAr: string }> = [
  { re: /host|hosting|استضاف|سيرفر|server|vps|cpanel|hostinger|godaddy|namecheap|cloudflare|digitalocean|hetzner/i, reasonAr: 'استضافة أو خادم' },
  { re: /domain|نطاق|دومين|dns/i, reasonAr: 'نطاق (دومين)' },
  { re: /store|متجر|play\s*console|google\s*play|app\s*store|apple|appstore|salla|zid|shopify|سلة|زد/i, reasonAr: 'متجر أو حساب نشر تطبيقات' },
  { re: /bill|فاتور|اشتراك|subscription|payment|دفع|paypal|stripe/i, reasonAr: 'فواتير أو اشتراكات' },
  { re: /mail|بريد|إيميل|ايميل|gmail|outlook/i, reasonAr: 'بريد إلكتروني' },
];

/**
 * Hint بالعربي: دالة اقتراح الأسرار المناسبة للعائلة. لا يُقترح أبداً: مفاتيح API ولا الملفات الحساسة التقنية.
 */
export function suggestFamilySecrets(secrets: VaultSecretItem[]): FamilySuggestion[] {
  return secrets
    .filter((s) => s.category !== 'critical_file' && s.category !== 'contact' && s.category !== 'family_instruction')
    .map((s) => {
      const text = `${s.title} ${s.url ?? ''} ${s.usernameOrEmail ?? ''} ${s.notesForWifeAr ?? ''}`;
      let suggested = false;
      let reasonAr = '';
      if (s.category === 'api_key') reasonAr = 'مفتاح تقني للمبرمجين: لا يُقترح للعائلة';
      else if (s.category === 'billing') {
        suggested = true;
        reasonAr = 'فواتير';
      } else {
        const hint = FAMILY_HINTS.find((h) => h.re.test(text));
        if (hint) {
          suggested = true;
          reasonAr = hint.reasonAr;
        } else if (s.category === 'email_account') {
          suggested = true;
          reasonAr = 'بريد إلكتروني';
        } else if (s.category === 'recovery_code') {
          reasonAr = 'رموز استرداد: اخترها إن كانت لحساب تحتاجه العائلة';
        }
      }
      return { id: s.id, title: s.title, category: s.category, usernameOrEmail: s.usernameOrEmail ?? '', suggested: s.familyVisible === true || suggested, reasonAr, familyVisible: s.familyVisible === true };
    })
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.title.localeCompare(b.title, 'ar'));
}

/**
 * Hint بالعربي: دالة حالة الخزنة العائلية للواجهة (بلا أي سر).
 */
export function describeFamilyVault(vault: UnlockedVault | null): { vaultFormat: 2 | 3 | null; familyCount: number | null } {
  if (!vaultExists()) return { vaultFormat: null, familyCount: null };
  try {
    const file = readVaultFile(vault?.vaultFilePath ?? loadSystemConfig().paths.encryptedVaultFile);
    return { vaultFormat: file.version, familyCount: file.version === 3 ? file.family.count : null };
  } catch {
    return { vaultFormat: null, familyCount: null };
  }
}

/**
 * Hint بالعربي: دالة أماكن البحث عن النسخ القديمة على هذا الجهاز وعلى Drive.
 */
export function resolveOldCopiesLocations(vaultFilePath: string): OldCopiesLocations {
  const config = loadSystemConfig();
  const sync = readSyncSettings();
  const ctx = buildSyncContext();
  const dirs = [config.paths.encryptedBackupsDir, config.security?.extraBackupDir, sync.folder ? path.join(sync.folder, 'Backups') : undefined].filter((d): d is string => Boolean(d));
  return { vaultFilePath, backupDirs: dirs, syncRoot: ctx?.syncRoot };
}
