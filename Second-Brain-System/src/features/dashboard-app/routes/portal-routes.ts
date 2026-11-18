/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/portal-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات بوابة العائلة، 3.1.0)
 * Hint بالعربي: - عرض البوابة (جهات الاتصال، والتعليمات، والفواتير المتكررة، والمشاريع، وسجل الخطوات)
 *                 لأي جلسة مفتوحة: القائد يرى ما ستراه العائلة بالضبط.
 *               - إضافة وتعديل وحذف جهات الاتصال والتعليمات: للقائد فقط، وبعد الترقية إلى الخزنة العائلية.
 *               - ملاحظة في سجل الخطوات: لأي جلسة مفتوحة (العائلة تكتب ما فعلته).
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import type { VaultSecretItem } from '../../../shared/types.ts';
import {
  appendFamilyLog,
  buildFamilyPortal,
  FAMILY_LOG_LABELS,
  isPortalCategory,
  readFamilyLog,
} from '../../family-emergency/family-portal.ts';
import { deleteVaultSecret, readVaultFile, upsertVaultSecret } from '../../vault/vault-manager.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة إرجاع مسارات بوابة العائلة.
 */
export function getPortalRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/family/portal',
      requiresSession: true,
      handler: ({ res, session }) => {
        const vault = session!.vault;
        let vaultFormat: number | null = null;
        try {
          vaultFormat = readVaultFile(vault.vaultFilePath).version;
        } catch {
          vaultFormat = null;
        }
        const portal = buildFamilyPortal(vault, loadSystemConfig());
        const log = readFamilyLog(vault);
        sendJson(res, 200, {
          vaultFormat,
          ...portal,
          log: log.entries.map((e) => ({ ...e, labelAr: FAMILY_LOG_LABELS[e.action] ?? e.action })),
          logTotal: log.total,
          logUnreadable: log.unreadable,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/family/portal/item',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (readVaultFile(vault.vaultFilePath).version !== 3) throw new HttpError(400, 'رقِّ الخزنة إلى الخزنة العائلية أولاً (من بطاقة «👪 الخزنة العائلية»).');
        const category = readString(body, 'category', 40);
        if (!isPortalCategory(category)) throw new HttpError(400, 'نوع عنصر البوابة غير صحيح.');
        const id = readString(body, 'id', 120) || `FAM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const existing = vault.secrets.find((s) => s.id === id);
        if (existing && !isPortalCategory(existing.category)) throw new HttpError(400, 'هذا المعرّف لسرّ في الخزنة، لا لعنصر في البوابة.');
        const title = readString(body, 'title', 200).trim();
        const textAr = readString(body, 'textAr', 8000).trim();
        if (!title) throw new HttpError(400, category === 'contact' ? 'اسم جهة الاتصال مطلوب.' : 'عنوان التعليمة مطلوب.');
        if (category === 'family_instruction' && !textAr) throw new HttpError(400, 'نص التعليمة مطلوب.');
        const saved = upsertVaultSecret(vault, {
          id,
          category: category as VaultSecretItem['category'],
          title,
          usernameOrEmail: readString(body, 'contact', 300).trim(),
          secretValue: '',
          url: readString(body, 'url', 500).trim(),
          notesForCommanderAr: '',
          notesForWifeAr: textAr,
          projectId: readString(body, 'projectId', 120).trim() || undefined,
          // عناصر البوابة للعائلة دائماً
          familyVisible: true,
          createdAt: existing?.createdAt,
        });
        sendJson(res, 200, { ok: true, id: saved.id, messageAr: `👪 حُفظ (${saved.title}) في بوابة العائلة.` });
      },
    },
    {
      method: 'POST',
      path: '/api/family/portal/item/delete',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        const id = readString(body, 'id', 120);
        const item = vault.secrets.find((s) => s.id === id);
        if (!item || !isPortalCategory(item.category)) throw new HttpError(404, 'العنصر غير موجود في البوابة.');
        deleteVaultSecret(vault, id);
        sendJson(res, 200, { ok: true, messageAr: `🗑️ حُذف (${item.title}) من بوابة العائلة.` });
      },
    },
    {
      method: 'POST',
      path: '/api/family/log',
      requiresSession: true,
      handler: ({ res, body, session }) => {
        const text = readString(body, 'detailAr', 1000).trim();
        if (!text) throw new HttpError(400, 'اكتبي ما فعلتِه أولاً.');
        const entry = appendFamilyLog(session!.vault, { action: 'note', detailAr: text });
        if (!entry) throw new HttpError(400, 'سجل الخطوات يعمل بعد الترقية إلى الخزنة العائلية.');
        sendJson(res, 200, { ok: true, entry: { ...entry, labelAr: FAMILY_LOG_LABELS.note }, messageAr: '📝 سُجّلت الخطوة.' });
      },
    },
  ];
}
