/**
 * ============================================================================
 * الملف: src/core/logger.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: مسجل الأحداث والأخطاء المركزي في النظام؛ يطبع رسائل واضحة بالعربية
 *               ويحفظ سجل العمليات لربطها بالتوثيق وفحص الأخطاء.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectoryExists, formatTimestampIso } from '../shared/file-helpers.ts';
import { loadSystemConfig } from './config-manager.ts';

/**
 * Hint بالعربي: دالة لتسجيل رسالة معلوماتية أو عملية ناجحة داخل سجل النظام.
 */
export function logSystemInfo(moduleName: string, messageAr: string): void {
  const timestamp = formatTimestampIso();
  const formatted = `[${timestamp}] [INFO] [${moduleName}] ${messageAr}`;
  appendLogLineSafe(formatted);
}

/**
 * Hint بالعربي: دالة لتسجيل أي خطأ تقني يحدث أثناء التشغيل مع حفظ تفاصيله للمراجعة والصيانة.
 */
export function logSystemError(moduleName: string, errorMessageAr: string, errorObj?: unknown): void {
  const timestamp = formatTimestampIso();
  const detail = errorObj instanceof Error ? errorObj.message : String(errorObj ?? '');
  const formatted = `[${timestamp}] [ERROR] [${moduleName}] ${errorMessageAr} | التفاصيل: ${detail}`;
  appendLogLineSafe(formatted);
}

/**
 * Hint بالعربي: دالة داخلية مساعدة لإضافة سطر السجل إلى ملف runtime.log بأمان.
 */
export function appendLogLineSafe(line: string): void {
  try {
    const config = loadSystemConfig();
    const logDir = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'logs');
    ensureDirectoryExists(logDir);
    const logFile = path.join(logDir, 'runtime.log');
    fs.appendFileSync(logFile, line + '\n', 'utf-8');
  } catch {
    // في حال عدم إمكانية الكتابة على القرص لا نوقف النظام
  }
}
