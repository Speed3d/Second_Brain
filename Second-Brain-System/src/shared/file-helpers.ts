/**
 * ============================================================================
 * الملف: src/shared/file-helpers.ts
 * القسم: Shared (الدوال المساعدة المشتركة)
 * Hint بالعربي: يوفر هذا الملف دوال آمنة ومشتركة للتعامل مع الملفات والمجلدات
 *               والتواريخ في النظام، بحيث لا تتكرر أكواد القراءة والكتابة في الأقسام الأخرى.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Hint بالعربي: دالة للتأكد من وجود المجلد على القرص، وإذا لم يكن موجوداً تقوم بإنشائه تلقائياً
 * مع كافة المجلدات الأبوية اللازمة.
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Hint بالعربي: دالة لقراءة ملف JSON بأمان؛ إذا لم يكن الملف موجوداً أو كان تالفاً
 * تعيد القيمة الافتراضية (fallback) بدلاً من إيقاف البرنامج.
 */
export function readJsonFileSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(rawContent) as T;
  } catch {
    return fallback;
  }
}

/**
 * Hint بالعربي: دالة لحفظ كائن بيانات بصيغة JSON منسقة داخل ملف، مع إنشاء المجلد الأب تلقائياً.
 */
export function writeJsonFileSafe(filePath: string, data: unknown): void {
  const parentDir = path.dirname(filePath);
  ensureDirectoryExists(parentDir);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Hint بالعربي: دالة كتابة ذرّية (Atomic Write): تكتب المحتوى في ملف مؤقت ثم تستبدل به الملف الأصلي
 *               دفعة واحدة، فلا يتلف الملف أبداً لو انقطعت الكهرباء أثناء الحفظ.
 *               المدخلات: المسار، المحتوى، وعدد النسخ السابقة المحفوظة (file.bak-1 هي الأحدث).
 */
export function writeFileAtomic(filePath: string, content: string | Buffer, keepBackups: number = 0): void {
  ensureDirectoryExists(path.dirname(filePath));

  if (keepBackups > 0 && fs.existsSync(filePath)) {
    for (let i = keepBackups - 1; i >= 1; i--) {
      const older = `${filePath}.bak-${i}`;
      if (fs.existsSync(older)) fs.renameSync(older, `${filePath}.bak-${i + 1}`);
    }
    fs.copyFileSync(filePath, `${filePath}.bak-1`);
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

/**
 * Hint بالعربي: دالة لكتابة نص (مثل ملفات Markdown الخاصة بـ Obsidian) بأمان كامل بترميز UTF-8.
 */
export function writeTextFileSafe(filePath: string, content: string): void {
  const parentDir = path.dirname(filePath);
  ensureDirectoryExists(parentDir);
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Hint بالعربي: دالة للبحث المتفرع داخل أي مجلد وإرجاع قائمة بجميع الملفات الموجودة بداخله
 * مع تجاهل المجلدات الثقيلة غير المهمة مثل node_modules و .git.
 */
export function listFilesRecursive(
  rootDir: string,
  ignoreDirs: string[] = ['node_modules', '.git', 'dist', 'build', '.next', '.dart_tool']
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) {
    return results;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.includes(entry.name)) {
        results.push(...listFilesRecursive(fullPath, ignoreDirs));
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Hint بالعربي: دالة تحويل أي نص (مثل اسم مشروع) إلى اسم مجلد/ملف صالح على Windows و Obsidian:
 *               تستبدل الرموز الممنوعة < > : " / \ | ? * وأقواس الروابط [ ] # ^ والمحارف الخفية،
 *               وتمنع الأسماء المحجوزة (CON, NUL...) والنقاط والمسافات في النهاية.
 */
export function toSafeFileName(name: string, fallback: string = 'Untitled'): string {
  let safe = name
    .replace(/[<>:"/\\|?*\[\]#^\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[-. ]+/, '')
    .slice(0, 100);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = `${safe}-project`;
  return safe || fallback;
}

/**
 * Hint بالعربي: دالة لتنسيق التاريخ والوقت الحالي بصيغة واضحة ومقروءة للسجلات والتقارير.
 */
export function formatTimestampIso(): string {
  return new Date().toISOString();
}
