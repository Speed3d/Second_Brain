/**
 * ============================================================================
 * الملف: src/tools/install-arabic-voice.ts
 * القسم: Tools (تنزيل الصوت العربي المدمج داخل المشروع)
 * Hint بالعربي: ينزّل محرك النطق Piper (مفتوح المصدر، MIT) والصوت العربي «Kareem» من مصادرهما الرسمية فقط،
 *               ويضعهما في Second-Brain-System/vendor/ (غير مرفوع إلى Git). بعدها يعمل النطق العربي
 *               على هذا الجهاز بلا إنترنت، وفي أي متصفح. يُشغَّل مرة واحدة لكل جهاز:
 *                 node src/tools/install-arabic-voice.ts
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ar/ar_JO/kareem/medium';

/** حزمة Piper حسب النظام، مع الحجم المتوقع بالبايت للتحقق من اكتمال التنزيل */
const PIPER_PACKAGES: Record<string, { file: string; bytes: number }> = {
  'win32-x64': { file: 'piper_windows_amd64.zip', bytes: 22477236 },
  'darwin-arm64': { file: 'piper_macos_aarch64.tar.gz', bytes: 19146957 },
};
const VOICE_FILES = [
  { file: 'ar_JO-kareem-medium.onnx', bytes: 63201294 },
  { file: 'ar_JO-kareem-medium.onnx.json', bytes: 0 },
];

/**
 * Hint بالعربي: دالة تنزيل ملف إلى مسار محدد مع التحقق من الحجم المتوقع (إن عُرف).
 */
async function download(url: string, target: string, expectedBytes: number): Promise<void> {
  if (fs.existsSync(target) && (!expectedBytes || fs.statSync(target).size === expectedBytes)) {
    console.log(`✔ موجود مسبقاً: ${path.basename(target)}`);
    return;
  }
  console.log(`⬇ تنزيل ${path.basename(target)} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`فشل التنزيل (${res.status}): ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (expectedBytes && data.length !== expectedBytes) throw new Error(`حجم غير متوقع لـ ${path.basename(target)}: ${data.length} بدل ${expectedBytes}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  console.log(`✔ ${path.basename(target)} (${(data.length / 1048576).toFixed(1)} MB)`);
}

/**
 * Hint بالعربي: الدالة الرئيسية: تنزيل Piper وفك ضغطه، ثم تنزيل الصوت العربي.
 */
export async function installArabicVoice(vendorDir: string): Promise<void> {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PIPER_PACKAGES[key];
  if (!pkg) throw new Error(`هذا النظام (${key}) غير مدعوم حالياً للصوت المدمج.`);
  const downloads = path.join(vendorDir, 'downloads');
  const archive = path.join(downloads, pkg.file);
  await download(`${PIPER_RELEASE}/${pkg.file}`, archive, pkg.bytes);
  // فك الضغط بأداة tar المدمجة في Windows 10+ و macOS (تدعم zip و tar.gz)، بلا shell
  // على Windows نستخدم tar المدمج في النظام صراحة (tar الخاص بـ Git Bash يظن أن "D:" عنوان خادم بعيد)
  const tarCommand = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const extract = spawnSync(tarCommand, ['-xf', archive, '-C', vendorDir], { stdio: 'inherit' });
  if (extract.status !== 0) throw new Error('تعذر فك ضغط Piper.');
  for (const v of VOICE_FILES) await download(`${VOICE_BASE}/${v.file}`, path.join(vendorDir, 'voices', v.file), v.bytes);
  fs.rmSync(downloads, { recursive: true, force: true });
  console.log('🎉 اكتمل تثبيت الصوت العربي المدمج. أعد تحميل صفحة Second Brain.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');
  installArabicVoice(vendor).catch((err) => {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
