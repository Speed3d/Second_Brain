/**
 * ============================================================================
 * الملف: src/features/dashboard-app/session-manager.ts
 * القسم: Features -> Dashboard App (مدير جلسة الخزنة المفتوحة)
 * Hint بالعربي: يحتفظ بالخزنة المفتوحة في الذاكرة فقط (لا تُكتب على القرص أبداً) مع:
 *               - رمز جلسة عشوائي يُرسل للمتصفح في كوكي HttpOnly.
 *               - قفل تلقائي بعد مدة خمول (10 دقائق افتراضياً) مع مسح المفتاح من الذاكرة.
 *               - تأخير متصاعد بعد محاولات الفتح الفاشلة لمنع التخمين.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { wipeUnlockedVault, type UnlockedVault } from '../vault/vault-manager.ts';

/**
 * Hint بالعربي: بيانات جلسة الخزنة المفتوحة.
 */
export interface VaultSession {
  token: string;
  vault: UnlockedVault;
  createdAt: number;
  lastActivityAt: number;
}

let activeSession: VaultSession | null = null;
let failedUnlockAttempts = 0;
let lockedUntil = 0;

/**
 * Hint بالعربي: دالة حساب مدة القفل التلقائي بالمللي ثانية من الإعدادات (افتراضياً 10 دقائق).
 */
export function getAutoLockMs(): number {
  const minutes = loadSystemConfig().security?.autoLockMinutes ?? 10;
  return Math.max(1, minutes) * 60 * 1000;
}

/**
 * Hint بالعربي: دالة فتح جلسة جديدة للخزنة (تُغلق أي جلسة سابقة وتمسح مفتاحها). المخرجات: رمز الجلسة.
 */
export function openVaultSession(vault: UnlockedVault): string {
  closeVaultSession();
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  activeSession = { token, vault, createdAt: now, lastActivityAt: now };
  logSystemInfo('SessionManager', `تم فتح جلسة خزنة جديدة (${vault.unlockedBy}).`);
  return token;
}

/**
 * Hint بالعربي: دالة جلب الجلسة المفتوحة إذا طابق الرمز ولم تنتهِ مدة الخمول، مع تحديث وقت آخر نشاط.
 */
export function getVaultSession(token: string | undefined | null, touch: boolean = true): VaultSession | null {
  if (!token || !activeSession) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(activeSession.token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const now = Date.now();
  if (now - activeSession.lastActivityAt > getAutoLockMs()) {
    logSystemInfo('SessionManager', 'تم قفل الخزنة تلقائياً بعد انتهاء مدة الخمول.');
    closeVaultSession();
    return null;
  }
  if (touch) activeSession.lastActivityAt = now;
  return activeSession;
}

/**
 * Hint بالعربي: دالة إرجاع الخزنة المفتوحة حالياً للمهام الخلفية (مثل المراقب الدوري) دون تمديد الجلسة؛
 *               إذا انتهت مدة الخمول تُقفل الخزنة وتُرجع null.
 */
export function peekActiveVault(): UnlockedVault | null {
  if (!activeSession) return null;
  if (Date.now() - activeSession.lastActivityAt > getAutoLockMs()) {
    closeVaultSession();
    return null;
  }
  return activeSession.vault;
}

/**
 * Hint بالعربي: دالة قفل الخزنة فوراً ومسح مفتاح البيانات من الذاكرة.
 */
export function closeVaultSession(): void {
  if (activeSession) {
    wipeUnlockedVault(activeSession.vault);
    activeSession = null;
  }
}

/**
 * Hint بالعربي: دالة حساب الثواني المتبقية قبل القفل التلقائي للجلسة.
 */
export function getSecondsUntilAutoLock(session: VaultSession): number {
  return Math.max(0, Math.round((session.lastActivityAt + getAutoLockMs() - Date.now()) / 1000));
}

/**
 * Hint بالعربي: دالة معرفة كم يجب الانتظار (بالمللي ثانية) قبل السماح بمحاولة فتح جديدة. صفر = مسموح.
 */
export function getUnlockRetryAfterMs(): number {
  return Math.max(0, lockedUntil - Date.now());
}

/**
 * Hint بالعربي: دالة تسجيل محاولة فتح فاشلة: بعد 3 محاولات يبدأ تأخير يتضاعف (2، 4، 8... حتى 5 دقائق).
 */
export function recordUnlockFailure(): void {
  failedUnlockAttempts++;
  if (failedUnlockAttempts >= 3) {
    const delayMs = Math.min(5 * 60 * 1000, 1000 * 2 ** (failedUnlockAttempts - 2));
    lockedUntil = Date.now() + delayMs;
  }
}

/**
 * Hint بالعربي: دالة تصفير عداد المحاولات الفاشلة بعد فتح ناجح.
 */
export function recordUnlockSuccess(): void {
  failedUnlockAttempts = 0;
  lockedUntil = 0;
}

/**
 * Hint بالعربي: دالة إعادة ضبط حالة الجلسات والمحاولات (تُستخدم في الاختبارات فقط).
 */
export function resetSessionStateForTests(): void {
  closeVaultSession();
  failedUnlockAttempts = 0;
  lockedUntil = 0;
}
