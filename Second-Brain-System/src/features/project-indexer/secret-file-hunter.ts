/**
 * ============================================================================
 * الملف: src/features/project-indexer/secret-file-hunter.ts
 * القسم: Features -> Project Indexer (ميزة صيد الملفات الحساسة التي لا تُعوض)
 * Hint بالعربي: يقوم هذا الملف بالبحث داخل أي مشروع عن الملفات الحرجة التي لا تُرفع
 *               على GitHub (مثل .env، مفاتيح التوقيع keystore، شهادات السيرفر)
 *               والتي لو ضاعت لتوقف المشروع، ليتم تشفيرها وحفظها في الخزنة تلقائياً.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriticalFileEntry } from '../../shared/types.ts';
import { listFilesRecursive } from '../../shared/file-helpers.ts';

/**
 * Hint بالعربي: قائمة القواعد التي تحدد ما إذا كان الملف حساساً ولا يمكن تعويضه مع شرح أهميته بالعربية.
 */
/** ملفات قوالب لا تحتوي أسراراً حقيقية فلا تُعد حساسة */
const TEMPLATE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

const CRITICAL_PATTERNS: Array<{ test: (fileName: string) => boolean; reasonAr: string }> = [
  {
    test: (name) =>
      (name === '.env' || name.startsWith('.env.')) && !TEMPLATE_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    reasonAr: 'ملف متغيرات البيئة والأسرار (.env) — يحتوي على مفاتيح الربط وروابط قواعد البيانات السرية غير المرفوعة على Git.',
  },
  {
    test: (name) => name.endsWith('.jks') || name.endsWith('.keystore') || name === 'key.properties',
    reasonAr: 'مفتاح التوقيع الرسمي للتطبيق (Keystore) — لو ضاع هذا الملف يستحيل تحديث التطبيق في متجر Google Play للأبد!',
  },
  {
    test: (name) => name === 'google-services.json' || name === 'GoogleService-Info.plist' || name.includes('service-account'),
    reasonAr: 'ملف ربط خدمات Firebase / Google Cloud — ضروري لعمل الإشعارات وقاعدة البيانات والمصادقة.',
  },
  {
    test: (name) => name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.pfx') || name === 'id_rsa',
    reasonAr: 'مفتاح تشفير أو شهادة اتصال بالسيرفر (SSH / SSL Private Key) — لا يمكن الدخول للسيرفر بدونه.',
  },
  {
    test: (name) => name.endsWith('.secret.json') || name === 'secrets.json',
    reasonAr: 'ملف أسرار خاص بالمشروع.',
  },
];

/**
 * Hint بالعربي: دالة لفحص مجلد مشروع كامل واستخراج كافة الملفات الحساسة التي تحتاج تأميناً في الخزنة.
 *               الروابط الرمزية (symlinks) لا تُتبع لأن listFilesRecursive تتجاهلها.
 */
export function huntCriticalProjectFiles(projectRootPath: string): CriticalFileEntry[] {
  const discovered: CriticalFileEntry[] = [];
  if (!fs.existsSync(projectRootPath)) {
    return discovered;
  }

  const allFiles = listFilesRecursive(projectRootPath, ['node_modules', '.git', 'dist', 'build', 'encrypted-vault', 'encrypted-backups']);
  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);
    for (const rule of CRITICAL_PATTERNS) {
      if (rule.test(fileName)) {
        const stats = fs.statSync(filePath);
        discovered.push({
          relativePath: path.relative(projectRootPath, filePath),
          absolutePath: filePath,
          reasonAr: rule.reasonAr,
          sizeBytes: stats.size,
          securedState: 'detected',
        });
        break;
      }
    }
  }

  return discovered;
}
