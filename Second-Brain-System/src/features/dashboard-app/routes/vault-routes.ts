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
import {
  changeMasterPassword,
  createVault,
  deleteVaultSecret,
  rotateEmergencyKey,
  unlockVault,
  upsertVaultSecret,
  vaultExists,
} from '../../vault/vault-manager.ts';
import { buildSessionCookie, HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';
import {
  closeVaultSession,
  getSecondsUntilAutoLock,
  getUnlockRetryAfterMs,
  openVaultSession,
  recordUnlockFailure,
  recordUnlockSuccess,
} from '../session-manager.ts';

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
            messageAr: 'تم إنشاء الخزنة. هذا مفتاح الطوارئ لزوجتك — لن يُعرض مرة أخرى، اطبع كتيب الطوارئ الآن.',
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
        const token = openVaultSession(vault);
        sendJson(
          res,
          200,
          { ok: true, unlockedBy: vault.unlockedBy, secretsCount: vault.secrets.length },
          { 'Set-Cookie': buildSessionCookie(token) }
        );
      },
    },
    {
      method: 'POST',
      path: '/api/vault/lock',
      handler: ({ res }) => {
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
