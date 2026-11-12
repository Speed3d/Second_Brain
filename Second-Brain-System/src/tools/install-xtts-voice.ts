/**
 * ============================================================================
 * الملف: src/tools/install-xtts-voice.ts
 * القسم: Tools (تثبيت الصوت العربي عالي الجودة XTTS-v2 على جهاز)
 * Hint بالعربي: ينشئ بيئة Python معزولة في Second-Brain-System/vendor/xtts-venv (غير مرفوعة إلى Git)،
 *               ويثبّت PyTorch (مع CUDA على Windows) و coqui-tts، ثم ينزّل نموذج XTTS-v2 بتشغيل العامل مرة واحدة.
 *               الحجم: نحو 4.8GB تنزيلاً و 7GB على القرص. يتطلب Python 3.12.
 *               نموذج XTTS-v2 مرخّص بـ Coqui Public Model License (استخدام غير تجاري)، لذلك يجب تمرير
 *               --accept-license صراحة بعد قراءة الرخصة: https://coqui.ai/cpml
 *                 node src/tools/install-xtts-voice.ts --accept-license
 * ============================================================================
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TORCH_VERSION = '2.6.0';
const COQUI_TTS_VERSION = '0.28.0';

/**
 * Hint بالعربي: دالة تشغيل أمر وإيقاف التثبيت عند فشله.
 */
function step(title: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n▶ ${title}`);
  const r = spawnSync(command, args, { stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`فشل: ${title}`);
}

/**
 * Hint بالعربي: الدالة الرئيسية لتثبيت XTTS-v2 في مجلد vendor.
 */
export function installXttsVoice(vendorDir: string): void {
  const isWin = process.platform === 'win32';
  const venv = path.join(vendorDir, 'xtts-venv');
  const python = isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  if (!fs.existsSync(python)) {
    if (isWin) step('إنشاء بيئة Python 3.12 معزولة', 'py', ['-3.12', '-m', 'venv', venv]);
    else step('إنشاء بيئة Python 3.12 معزولة', 'python3.12', ['-m', 'venv', venv]);
  }
  step('تحديث pip', python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  const torchArgs = ['-m', 'pip', 'install', `torch==${TORCH_VERSION}${isWin ? '+cu124' : ''}`, `torchaudio==${TORCH_VERSION}${isWin ? '+cu124' : ''}`];
  if (isWin) torchArgs.push('--index-url', 'https://download.pytorch.org/whl/cu124');
  step(`تثبيت PyTorch ${TORCH_VERSION}${isWin ? ' مع CUDA (نحو 2.5GB)' : ''}`, python, torchArgs);
  const constraints = path.join(vendorDir, 'xtts-constraints.txt');
  fs.writeFileSync(constraints, `torch==${TORCH_VERSION}${isWin ? '+cu124' : ''}\ntorchaudio==${TORCH_VERSION}${isWin ? '+cu124' : ''}\n`);
  const coquiArgs = ['-m', 'pip', 'install', `coqui-tts==${COQUI_TTS_VERSION}`, 'six', '-c', constraints];
  if (isWin) coquiArgs.push('--extra-index-url', 'https://download.pytorch.org/whl/cu124');
  step(`تثبيت coqui-tts ${COQUI_TTS_VERSION}`, python, coquiArgs);

  // تشغيل العامل مرة واحدة: ينزّل النموذج (1.87GB) ويتأكد من التحميل، ثم يخرج لأن stdin فارغ
  const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'features', 'voice', 'xtts-worker.py');
  console.log('\n▶ تنزيل نموذج XTTS-v2 (1.87GB) وتجربة تحميله');
  const r = spawnSync(python, ['-I', worker], { input: '', encoding: 'utf8', env: { ...process.env, COQUI_TOS_AGREED: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const ready = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => 'ready' in m);
  if (!ready?.ready) throw new Error(`تعذر تحميل النموذج: ${String(ready?.error ?? r.stderr.slice(-500))}`);
  fs.writeFileSync(
    path.join(vendorDir, 'xtts-ready.json'),
    JSON.stringify({ engine: 'xtts-v2', license: 'Coqui Public Model License 1.0 (non-commercial), accepted by the owner', device: ready.device, installedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`\n🎉 XTTS-v2 جاهز على ${String(ready.device)}. أعد تشغيل Second Brain.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--accept-license')) {
    console.error('نموذج XTTS-v2 مرخّص بـ Coqui Public Model License (استخدام غير تجاري): https://coqui.ai/cpml');
    console.error('بعد قراءة الرخصة والموافقة عليها، أعد التشغيل مع: --accept-license');
    process.exit(2);
  }
  const vendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');
  try {
    installXttsVoice(vendor);
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
