/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/second-factor-gate.ts
 * القسم: Dashboard App (بوابة الرمز الثاني المشتركة)
 * Hint بالعربي: كل مسار يحوّل كلمة المرور الرئيسية إلى جلسة قائد جديدة يمرّ من هنا، حتى لا تُكتب
 *               بوابة المصادقة الثنائية في مسار واحد وتُنسى في آخر (ISS-047: /api/settings/auth
 *               كان يفتح جلسة قائد بكلمة المرور وحدها رغم تفعيل 2FA).
 * ============================================================================
 */

import { isTwoFactorEnabled, verifySecondFactor } from '../../auth/two-factor.ts';
import { recordUnlockFailure } from '../session-manager.ts';
import { wipeUnlockedVault, type UnlockedVault } from '../../vault/vault-manager.ts';
import { HttpError, readString } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة فرض الرمز الثاني على خزنة فُتحت بكلمة المرور قبل منح جلسة.
 *               المدخلات: الخزنة المفتوحة، وجسم الطلب (الحقل twoFactorCode).
 *               المخرجات: ملاحظة عربية إن استُعمل رمز احتياطي، أو null. عند الرفض تُمسح الخزنة
 *               من الذاكرة ويُرمى 401 مع twoFactorRequired، والرمز الخاطئ يُحتسب محاولة فاشلة.
 */
export function enforceSecondFactor(vault: UnlockedVault, body: Record<string, unknown>): string | null {
  if (!isTwoFactorEnabled(vault)) return null;
  const second = readString(body, 'twoFactorCode', 40).trim();
  if (!second) {
    wipeUnlockedVault(vault);
    throw new HttpError(401, 'اكتب رمز المصادقة الثنائية (6 أرقام من التطبيق) أو رمزاً احتياطياً.', { twoFactorRequired: true });
  }
  const check = verifySecondFactor(vault, second);
  if (!check.ok) {
    wipeUnlockedVault(vault);
    recordUnlockFailure();
    throw new HttpError(401, 'رمز المصادقة الثنائية غير صحيح أو استُخدم من قبل.', { twoFactorRequired: true });
  }
  if (check.method === 'backup') return `🔑 استُخدم رمز احتياطي. بقي ${check.backupLeft} رمزاً${check.backupLeft! <= 3 ? '؛ أنشئ رموزاً جديدة قريباً' : ''}.`;
  return null;
}
