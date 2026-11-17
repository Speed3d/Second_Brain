/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/vault-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الخزنة)
 * Hint بالعربي: مسارات إنشاء الخزنة، فتحها وقفلها، وإدارة الأسرار (عرض، إضافة، تعديل، حذف)،
 *               وتغيير كلمة المرور وتدوير مفتاح الطوارئ. كل ما يخص الأسرار يتطلب جلسة مفتوحة.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import type { VaultSecretItem } from '../../../shared/types.ts';
import * as path from 'node:path';
import {
  changeMasterPassword,
  createVault,
  deleteVaultSecret,
  migrateVaultToFamilyV3,
  readVaultFile,
  rotateEmergencyKey,
  unlockVault,
  upsertVaultSecret,
  vaultExists,
  verifyMasterPassword,
} from '../../vault/vault-manager.ts';
import { describeFamilyVault, resolveOldCopiesLocations, suggestFamilySecrets } from '../../vault/family-vault.ts';
import { listOldFullAccessCopies, removeOldFullAccessCopies } from '../../family-emergency/old-copies.ts';
import { createEncryptedSystemBackup } from '../../family-emergency/backup-service.ts';
import { resealFamilyConversations } from '../../conversations/conversation-store.ts';
import { buildSessionCookie, HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';
import {
  closeVaultSession,
  getSecondsUntilAutoLock,
  getUnlockRetryAfterMs,
  openVaultSession,
  peekActiveVault,
  recordUnlockFailure,
  recordUnlockSuccess,
} from '../session-manager.ts';
import { syncOnUnlock, syncTick } from '../../sync/sync-service.ts';

const ALLOWED_CATEGORIES: VaultSecretItem['category'][] = ['email_account', 'password', 'api_key', 'recovery_code', 'billing'];

/**
 * Hint بالعربي: دالة تحويل السر إلى شكل آمن للإرسال للواجهة (الملفات الحساسة تُرسل بدون محتواها).
 */
export function toClientSecret(s: VaultSecretItem): Record<string, unknown> {
  const base = {
    id: s.id,
    category: s.category,
    title: s.title,
    projectId: s.projectId ?? null,
    usernameOrEmail: s.usernameOrEmail ?? '',
    url: s.url ?? '',
    notesForWifeAr: s.notesForWifeAr,
    notesForCommanderAr: s.notesForCommanderAr,
    familyVisible: s.familyVisible === true,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt,
  };
  if (s.category === 'critical_file') {
    return { ...base, originalFilePath: s.originalFilePath ?? '', versionsCount: (s.fileVersions?.length ?? 0) + 1 };
  }
  return { ...base, secretValue: s.secretValue };
}

/**
 * Hint بالعربي: دالة التأكد من عدم وجود تأخير بسبب محاولات فاشلة سابقة (ترمي 429 إذا كان هناك انتظار).
 */
export function assertUnlockAllowed(): void {
  const retryAfterMs = getUnlockRetryAfterMs();
  if (retryAfterMs > 0) {
    throw new HttpError(429, `محاولات كثيرة خاطئة. انتظر ${Math.ceil(retryAfterMs / 1000)} ثانية ثم حاول مجدداً.`, {
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    });
  }
}

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات الخزنة لتسجيلها في الموجّه الرئيسي.
 */
export function getVaultRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/vault/status',
      handler: ({ res, session }) => {
        sendJson(res, 200, {
          exists: vaultExists(),
          unlocked: Boolean(session),
          unlockedBy: session?.vault.unlockedBy ?? null,
          secretsCount: session?.vault.secrets.length ?? null,
          secondsUntilAutoLock: session ? getSecondsUntilAutoLock(session) : null,
          // 3.0.0: صيغة الخزنة (2 قبل الترقية، 3 مع الخزنة العائلية) وعدد أسرار العائلة
          ...describeFamilyVault(session?.vault ?? null),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/vault/setup',
      handler: ({ res, body }) => {
        const masterPassword = readString(body, 'masterPassword', 512);
        const confirmPassword = readString(body, 'confirmPassword', 512);
        if (confirmPassword && confirmPassword !== masterPassword) {
          throw new HttpError(400, 'تأكيد كلمة المرور غير مطابق.');
        }
        const { emergencyRecoveryKey, vault } = createVault(masterPassword);
        const token = openVaultSession(vault);
        sendJson(
          res,
          200,
          {
            ok: true,
            emergencyRecoveryKey,
            messageAr: 'تم إنشاء الخزنة. هذا مفتاح الطوارئ لزوجتك (يفتح الخزنة العائلية فقط) — لن يُعرض مرة أخرى، اطبع كتيب الطوارئ الآن.',
          },
          { 'Set-Cookie': buildSessionCookie(token) }
        );
      },
    },
    {
      method: 'POST',
      path: '/api/vault/unlock',
      handler: ({ res, body }) => {
        assertUnlockAllowed();
        const key = readString(body, 'key', 512);
        if (!key) throw new HttpError(400, 'يرجى إدخال كلمة المرور أو مفتاح الطوارئ.');
        if (!vaultExists()) throw new HttpError(404, 'لا توجد خزنة بعد. أنشئ الخزنة أولاً.');
        let vault;
        try {
          vault = unlockVault(key);
        } catch {
          recordUnlockFailure();
          throw new HttpError(401, 'كلمة المرور الرئيسية أو مفتاح الطوارئ غير صحيح!');
        }
        recordUnlockSuccess();
        // المزامنة: استيراد أي إصدار أحدث من الأجهزة الأخرى قبل إنشاء الجلسة، ثم فتح الخزنة من الملف الجديد
        const sync = syncOnUnlock(vault);
        if (sync.imported) {
          try {
            vault = unlockVault(key);
          } catch {
            throw new HttpError(401, 'استُوردت خزنة أحدث من جهاز آخر وكلمة مرورها مختلفة. استخدم كلمة المرور الجديدة.');
          }
        }
        const token = openVaultSession(vault);
        sendJson(
          res,
          200,
          { ok: true, unlockedBy: vault.unlockedBy, secretsCount: vault.secrets.length, syncMessageAr: sync.messageAr ?? null },
          { 'Set-Cookie': buildSessionCookie(token) }
        );
      },
    },
    {
      method: 'POST',
      path: '/api/vault/lock',
      handler: ({ res }) => {
        // نشر آخر التغييرات قبل إغلاق الخزنة (إن كان هذا الجهاز حامل الكتابة)
        syncTick(peekActiveVault());
        closeVaultSession();
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': buildSessionCookie(null) });
      },
    },
    {
      method: 'GET',
      path: '/api/vault/secrets',
      requiresSession: true,
      handler: ({ res, session }) => {
        sendJson(res, 200, { unlockedBy: session!.vault.unlockedBy, secrets: session!.vault.secrets.map(toClientSecret) });
      },
    },
    {
      method: 'POST',
      path: '/api/vault/secrets',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        const id = readString(body, 'id', 120) || `SEC-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const existing = vault.secrets.find((s) => s.id === id);
        if (existing?.category === 'critical_file') throw new HttpError(400, 'لا يمكن تعديل الملفات الحساسة من هنا.');
        const category = readString(body, 'category', 40) as VaultSecretItem['category'];
        if (!ALLOWED_CATEGORIES.includes(category)) throw new HttpError(400, 'تصنيف السر غير صحيح.');
        const title = readString(body, 'title', 200).trim();
        const secretValue = readString(body, 'secretValue', 20000);
        if (!title || !secretValue) throw new HttpError(400, 'العنوان والقيمة السرية مطلوبان.');
        const saved = upsertVaultSecret(vault, {
          id,
          category,
          title,
          usernameOrEmail: readString(body, 'usernameOrEmail', 300).trim(),
          secretValue,
          url: readString(body, 'url', 500).trim(),
          notesForCommanderAr: readString(body, 'notesForCommanderAr', 2000),
          notesForWifeAr: readString(body, 'notesForWifeAr', 2000),
          // 3.0.0: «👪 يظهر للعائلة»: يُنسخ إلى الخزنة العائلية فيفتحه مفتاح الطوارئ
          familyVisible: body.familyVisible === true,
          createdAt: existing?.createdAt,
        });
        sendJson(res, 200, { ok: true, secret: toClientSecret(saved), messageAr: `🔒 تم تشفير وحفظ (${saved.title}).` });
      },
    },
    {
      method: 'POST',
      path: '/api/vault/secrets/delete',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const removed = deleteVaultSecret(session!.vault, readString(body, 'id', 120));
        if (!removed) throw new HttpError(404, 'العنصر غير موجود.');
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/vault/change-password',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        changeMasterPassword(session!.vault, readString(body, 'currentPassword', 512), readString(body, 'newPassword', 512));
        sendJson(res, 200, { ok: true, messageAr: 'تم تغيير كلمة المرور الرئيسية. مفتاح الطوارئ المطبوع ما زال صالحاً.' });
      },
    },
    {
      // 3.0.0: حالة الخزنة العائلية واقتراحات المعالج والنسخ القديمة
      method: 'GET',
      path: '/api/vault/family',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        const vault = session!.vault;
        const info = describeFamilyVault(vault);
        const oldCopies = info.vaultFormat === 3 ? listOldFullAccessCopies(resolveOldCopiesLocations(vault.vaultFilePath)) : [];
        sendJson(res, 200, {
          ...info,
          suggestions: suggestFamilySecrets(vault.secrets),
          oldCopies: oldCopies.map((c) => ({ fileName: path.basename(c.filePath), kind: c.kind, labelAr: c.labelAr, sizeBytes: c.sizeBytes, modifiedAt: c.modifiedAt })),
        });
      },
    },
    {
      // 3.0.0: الترقية إلى الخزنة العائلية (مرة واحدة، على جهاز واحد)
      method: 'POST',
      path: '/api/vault/family/migrate',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (body.confirmSingleDevice !== true) throw new HttpError(400, 'أكّد أنك تنفّذ الترقية على جهاز واحد فقط.');
        const ids = Array.isArray(body.secretIds) ? body.secretIds.filter((x): x is string => typeof x === 'string').slice(0, 2000) : [];
        // أولاً مزامنة: إن رقّى جهاز آخر خزنته، تصل مفاتيحه هنا فلا يُولَّد مفتاح طوارئ ثانٍ
        syncTick(vault);
        if (readVaultFile(vault.vaultFilePath).version === 3) {
          throw new HttpError(409, 'وصلت الخزنة العائلية من جهاز آخر (رُقّيت هناك). لا حاجة للترقية هنا، ومفتاح الطوارئ هو المطبوع من ذلك الجهاز.');
        }
        let result;
        try {
          result = migrateVaultToFamilyV3(vault, readString(body, 'masterPassword', 512), ids);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        const resealed = resealFamilyConversations(vault);
        let backupAr = '';
        try {
          const backup = createEncryptedSystemBackup(vault);
          backupAr = `أُنشئت نسخة طوارئ جديدة بالصيغة 3 (${backup.filesIncluded} ملف).`;
        } catch (err) {
          backupAr = `تعذّر إنشاء نسخة طوارئ جديدة الآن (${err instanceof Error ? err.message : String(err)}). أنشئها من «💾 نسخة احتياطية الآن».`;
        }
        syncTick(vault); // نشر المفاتيح الجديدة إلى الأجهزة الأخرى
        const oldCount = listOldFullAccessCopies(resolveOldCopiesLocations(vault.vaultFilePath)).length;
        sendJson(res, 200, {
          ok: true,
          emergencyRecoveryKey: result.emergencyRecoveryKey,
          familyCount: result.familyCount,
          resealedConversations: resealed,
          oldCopiesCount: oldCount,
          messageAr: `👪 تمت الترقية إلى الخزنة العائلية: ${result.familyCount} سرّاً للعائلة، ونُقلت ${resealed} محادثة عائلية. ${backupAr} اطبع الكتيب الجديد الآن وأتلف الورقة القديمة.`,
        });
      },
    },
    {
      // 3.0.0: حذف النسخ القديمة التي يفتحها مفتاح الطوارئ القديم (بموافقة القائد وكلمة المرور)
      method: 'POST',
      path: '/api/vault/family/old-copies/delete',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const vault = session!.vault;
        if (readVaultFile(vault.vaultFilePath).version !== 3) throw new HttpError(400, 'رقِّ الخزنة إلى الخزنة العائلية أولاً.');
        if (!verifyMasterPassword(readString(body, 'masterPassword', 512), vault.vaultFilePath)) throw new HttpError(400, 'كلمة المرور الرئيسية غير صحيحة.');
        const result = removeOldFullAccessCopies(resolveOldCopiesLocations(vault.vaultFilePath));
        syncTick(vault); // نسخة مزامنة كاملة جديدة (v3) إن حُذفت القديمة
        sendJson(res, 200, {
          ok: true,
          ...result,
          messageAr: `🗑️ حُذفت ${result.removed} نسخة قديمة${result.failed.length ? `، وتعذّر حذف ${result.failed.length} (أعد المحاولة بعد قليل)` : ''}. مفتاح الطوارئ القديم لم يعد يفتح شيئاً على هذا الجهاز.`,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/vault/rotate-emergency-key',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const newKey = rotateEmergencyKey(session!.vault, readString(body, 'masterPassword', 512));
        sendJson(res, 200, {
          ok: true,
          emergencyRecoveryKey: newKey,
          messageAr: 'تم إنشاء مفتاح طوارئ جديد وأُبطل القديم. اطبع كتيب الطوارئ الجديد الآن وأتلف الورقة القديمة.',
        });
      },
    },
  ];
}
