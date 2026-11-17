/**
 * ============================================================================
 * الملف: src/core/runtime-version.ts
 * القسم: Core (هل الكود الذي يعمل هو الكود الموجود على القرص؟)
 * Hint بالعربي: ISS-032: بعد `git pull` يتغيّر الكود على القرص، لكن الخادم يبقى بالكود الذي حمّله عند بدئه
 *               حتى يُعاد تشغيله. تكرر هذا أربع مرات، وإحداها حذفت ملفات حقيقية (ISS-028).
 *               هنا يُحفظ إصدار الكود عند بدء العملية، ويُقارن بإصدار القرص في كل طلب:
 *               إن اختلفا ← «يحتاج إعادة تشغيل»، فتتوقف المزامنة ويظهر شريط في الواجهة.
 * ============================================================================
 */

import { readAppVersion } from './config-manager.ts';

/** رمز الخروج الذي يعني «أعد تشغيلي» (مثبّت Windows والماك يعيدان تشغيل الخادم عند أي رمز غير الصفر) */
export const RESTART_EXIT_CODE = 75;

let runningVersion = readAppVersion();
const startedAt = new Date().toISOString();

/** حالة الإصدار للواجهة و /api/health */
export interface RuntimeVersionStatus {
  /** إصدار الكود الذي يعمل الآن في هذه العملية */
  runningVersion: string;
  /** إصدار الكود على القرص الآن (يتغيّر بعد git pull) */
  diskVersion: string;
  startedAt: string;
  restartRequired: boolean;
}

/**
 * Hint بالعربي: دالة حالة الإصدار: هل الكود على القرص أحدث من الذي يعمل؟
 */
export function getRuntimeVersionStatus(): RuntimeVersionStatus {
  const diskVersion = readAppVersion();
  return { runningVersion, diskVersion, startedAt, restartRequired: diskVersion !== runningVersion };
}

/**
 * Hint بالعربي: رسالة عربية لحالة «يحتاج إعادة تشغيل» (أو null إن كان كل شيء متطابقاً).
 */
export function describeRestartRequired(status: RuntimeVersionStatus = getRuntimeVersionStatus()): string | null {
  if (!status.restartRequired) return null;
  return `حُدّث البرنامج على القرص إلى ${status.diskVersion}، لكن الخادم ما زال يعمل بالإصدار ${status.runningVersion}. المزامنة متوقفة حتى تعيد تشغيل الخادم (زر «🔄 أعد تشغيل الخادم» أعلى الصفحة).`;
}

/**
 * Hint بالعربي: للاختبارات فقط: محاكاة خادم بدأ بإصدار أقدم من القرص.
 */
export function setRunningVersionForTests(version: string | null): void {
  runningVersion = version ?? readAppVersion();
}

let restartHandler: () => void = () => {
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
};

/**
 * Hint بالعربي: دالة طلب إعادة تشغيل الخادم: يخرج برمز 75 بعد إرسال الرد، فيعيده المشغّل
 *               (run-server.ps1 على Windows، و LaunchAgent بـ KeepAlive على الماك) بالكود الجديد من القرص.
 */
export function requestServerRestart(): void {
  restartHandler();
}

/**
 * Hint بالعربي: للاختبارات فقط: استبدال الخروج الفعلي بدالة تسجّل الطلب.
 */
export function setRestartHandlerForTests(handler: (() => void) | null): void {
  restartHandler = handler ?? (() => setTimeout(() => process.exit(RESTART_EXIT_CODE), 300));
}

