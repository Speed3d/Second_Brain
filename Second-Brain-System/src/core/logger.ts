/**
 * ============================================================================
 * الملف: src/core/logger.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: مسجل الأحداث والأخطاء المركزي في النظام؛ يطبع رسائل واضحة بالعربية
 *               ويحفظ سجل العمليات لربطها بالتوثيق وفحص الأخطاء.
 *               3.7.0 (المرحلة 2.5 من docs/12):
 *               - كل سطر يمرّ على redactSecrets قبل الكتابة (مفاتيح API، وكلمات المرور في الروابط، ومفاتيح الطوارئ...).
 *               - تدوير: runtime.log حتى 5MB، ثم runtime.log.1 و runtime.log.2 (3 ملفات على الأكثر).
 *               - مخرجات الطرفية (التي تصير server.log عبر المشغّل أو launchd) تُنقّى أيضاً، ويُدوَّر server.log عند بدء الخادم.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectoryExists, formatTimestampIso } from '../shared/file-helpers.ts';
import { redactSecrets } from '../shared/secret-redaction.ts';
import { loadSystemConfig } from './config-manager.ts';

/** الحد الأقصى لملف السجل قبل التدوير */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** عدد ملفات السجل المحتفظ بها (الحالي + المدوَّرة) */
export const LOG_FILES_KEPT = 3;

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
    rotateLogIfLarge(logFile);
    fs.appendFileSync(logFile, redactSecrets(line).text + '\n', 'utf-8');
  } catch {
    // في حال عدم إمكانية الكتابة على القرص لا نوقف النظام
  }
}

/**
 * Hint بالعربي: دالة تدوير ملف سجل إن تجاوز الحد: file ← file.1 ← file.2 (ويُحذف الأقدم).
 *               copyTruncate: يُنسخ الملف ثم يُفرَّغ مكانه بدل نقله (لملف تكتب فيه عملية أخرى مفتوحة، مثل launchd).
 *               المخرجات: true إن دُوِّر.
 */
export function rotateLogIfLarge(file: string, options: { maxBytes?: number; keep?: number; copyTruncate?: boolean } = {}): boolean {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const keep = Math.max(1, options.keep ?? LOG_FILES_KEPT);
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= maxBytes) return false;
    if (keep === 1) {
      fs.truncateSync(file, 0);
      return true;
    }
    for (let i = keep - 1; i >= 1; i--) {
      const src = i === 1 ? null : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (src === null) {
        if (options.copyTruncate) {
          fs.copyFileSync(file, dst);
          fs.truncateSync(file, 0);
        } else {
          fs.renameSync(file, dst);
        }
      } else if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
    return true;
  } catch {
    return false;
  }
}

let consoleRedactionInstalled = false;

/**
 * Hint بالعربي: دالة تنقية مخرجات الطرفية (stdout و stderr) من الأسرار، ومنها رسائل الأعطال غير المتوقعة،
 *               لأنها تُكتب في server.log. تُثبَّت مرة واحدة عند بدء الخادم.
 */
export function installConsoleRedaction(): void {
  if (consoleRedactionInstalled) return;
  consoleRedactionInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stream as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') return original(redactSecrets(chunk).text, ...rest);
      if (chunk instanceof Uint8Array) return original(redactSecrets(Buffer.from(chunk).toString('utf8')).text, ...rest);
      return original(chunk, ...rest);
    };
  }
  // ISS-041: Node يطبع رسالة العطل غير المتوقع مباشرة دون المرور على process.stderr.write، فقد تحمل سراً.
  // نطبعها نحن منقّاة عبر stderr الملفوف، ثم نخرج بالرمز 1 كما يفعل Node (فيعيد المشغّل التشغيل كالمعتاد).
  process.on('uncaughtException', (err: unknown) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try {
      process.stderr.write(`[${formatTimestampIso()}] [FATAL] عطل غير متوقع: ${text}\n`);
      appendLogLineSafe(`[${formatTimestampIso()}] [FATAL] [Process] عطل غير متوقع: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      process.exit(1);
    }
  });
}
