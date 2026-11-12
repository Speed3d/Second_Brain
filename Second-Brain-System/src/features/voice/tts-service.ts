/**
 * ============================================================================
 * الملف: src/features/voice/tts-service.ts
 * القسم: Features -> Voice (النطق العربي المحلي من جهة الخادم)
 * Hint بالعربي: يولّد صوت الرد العربي على الجهاز نفسه (بلا إنترنت وبلا خدمة خارجية) ويعيده ملف WAV،
 *               فلا يعتمد على أصوات المتصفح (Chrome لا يرى أصوات Windows الحديثة). المحركات بالترتيب:
 *               1) XTTS-v2: أعلى جودة (أصوات Suad Qasim و Damien Black)، عامل دائم على كرت الشاشة (xtts-engine.ts).
 *                  أثناء تحميله أول مرة يُستخدم Piper حتى لا يتأخر الرد.
 *               2) Piper: محرك نطق عصبي مفتوح المصدر مع صوت عربي، يُنزَّل داخل المشروع في vendor/ (غير مرفوع إلى Git).
 *               3) أصوات Windows الحديثة (OneCore) عبر WinRT، إن كان صوت عربي مثبّتاً في Windows.
 *               4) أصوات macOS عبر الأمر say، إن كان صوت عربي مثبّتاً (مثل Majed).
 *               يُمرَّر النص دائماً عبر stdin (لا عبر سطر الأوامر)، والتشغيل بلا shell، وطلب واحد في كل مرة.
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { normalizeXttsSpeaker, resolveXttsLaunch, XTTS_MAX_CHARS, XTTS_SPEAKERS, xttsWorker } from './xtts-engine.ts';

/** أقصى طول للنص في طلب واحد (الواجهة تقسّم الرد إلى جمل) */
export const MAX_TTS_CHARS = 1500;
const SYNTH_TIMEOUT_MS = 60000;
const DETECT_CACHE_MS = 60000;

/** اسم ملف الصوت العربي لـ Piper */
export const PIPER_VOICE_FILE = 'ar_JO-kareem-medium.onnx';

/**
 * Hint بالعربي: المحرك المتاح وصوته.
 */
export interface TtsStatus {
  available: boolean;
  engine: 'xtts' | 'piper' | 'windows' | 'macos' | null;
  voiceName?: string;
  reasonAr?: string;
  /** لـ XTTS: الأصوات المتاحة، وحالة العامل، والمحرك الاحتياطي أثناء التحميل */
  speakers?: string[];
  workerState?: string;
  fallbackEngine?: TtsStatus['engine'];
  /** أقصى طول للجملة الواحدة التي ترسلها الواجهة */
  maxChars: number;
}

/**
 * Hint بالعربي: دالة مسار مجلد الأدوات المنزَّلة (vendor) — قابل للتغيير في الاختبارات.
 */
export function resolveVendorDir(): string {
  return process.env.SECOND_BRAIN_VENDOR_DIR || path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'vendor');
}

/**
 * Hint بالعربي: دالة مسارات Piper: البرنامج والصوت العربي (ملف .mjs مقبول لمحاكي الاختبارات).
 */
export function resolvePiperPaths(): { command: string; prefixArgs: string[]; model: string } | null {
  const vendor = resolveVendorDir();
  const model = path.join(vendor, 'voices', PIPER_VOICE_FILE);
  if (!fs.existsSync(model) || !fs.existsSync(`${model}.json`)) return null;
  const fake = path.join(vendor, 'piper', 'piper.mjs');
  if (fs.existsSync(fake)) return { command: process.execPath, prefixArgs: [fake], model };
  const exe = path.join(vendor, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
  return fs.existsSync(exe) ? { command: exe, prefixArgs: [], model } : null;
}

/** سكربت PowerShell لأصوات Windows الحديثة (WinRT): سرد الأصوات العربية أو توليد WAV من نص stdin */
const WINDOWS_TTS_SCRIPT = String.raw`param([string]$OutFile = '', [switch]$List)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -like 'ar*' } | Sort-Object { if ($_.Language -eq 'ar-SA') { 0 } else { 1 } })
if ($List) { $voices | ForEach-Object { $_.DisplayName + '|' + $_.Language }; exit 0 }
if ($voices.Count -eq 0) { [Console]::Error.WriteLine('NO_ARABIC_VOICE'); exit 3 }
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$text = $reader.ReadToEnd()
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voices[0]
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [uint32]$stream.Size
$dr = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
[void](Await ($dr.LoadAsync($size)) ([uint32]))
$bytes = New-Object byte[] $size
$dr.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($OutFile, $bytes)
`;

/**
 * Hint بالعربي: دالة تشغيل أمر بلا shell مع نص على stdin ومهلة قصوى؛ تُرجع المخرجات ورمز الخروج.
 */
function run(command: string, args: string[], stdinText: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinText, 'utf8');
  });
}

let windowsScriptPath: string | null = null;
function ensureWindowsScript(): string {
  if (windowsScriptPath && fs.existsSync(windowsScriptPath)) return windowsScriptPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-tts-'));
  windowsScriptPath = path.join(dir, 'winrt-tts.ps1');
  // BOM حتى يقرأ PowerShell 5.1 السكربت بترميز UTF-8
  fs.writeFileSync(windowsScriptPath, `﻿${WINDOWS_TTS_SCRIPT}`, 'utf8');
  return windowsScriptPath;
}

function powershellArgs(extra: string[]): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureWindowsScript(), ...extra];
}

let cache: { at: number; status: TtsStatus } | null = null;

/**
 * Hint بالعربي: دالة مسح ذاكرة اكتشاف المحرك (بعد تنزيل الصوت، وفي الاختبارات).
 */
export function resetTtsCache(): void {
  cache = null;
}

/**
 * Hint بالعربي: دالة اكتشاف أفضل محرك نطق عربي متاح على هذا الجهاز (مع ذاكرة مؤقتة لمدة دقيقة).
 */
export async function detectTtsEngine(): Promise<TtsStatus> {
  if (process.env.SECOND_BRAIN_TTS === 'none') return { available: false, engine: null, reasonAr: 'النطق من الخادم معطّل.', maxChars: 280 };
  const base = await detectBaseEngine();
  if (resolveXttsLaunch(resolveVendorDir())) {
    return {
      available: true,
      engine: 'xtts',
      voiceName: 'XTTS-v2',
      speakers: [...XTTS_SPEAKERS],
      workerState: xttsWorker.state,
      fallbackEngine: base.available ? base.engine : null,
      maxChars: XTTS_MAX_CHARS,
    };
  }
  return base;
}

/**
 * Hint بالعربي: دالة اكتشاف المحرك الأساسي (غير XTTS) مع ذاكرة مؤقتة لمدة دقيقة.
 */
async function detectBaseEngine(): Promise<TtsStatus> {
  if (cache && Date.now() - cache.at < DETECT_CACHE_MS) return cache.status;
  let status: TtsStatus;
  if (resolvePiperPaths()) {
    status = { available: true, engine: 'piper', voiceName: 'Piper — Kareem (عربي)', maxChars: 280 };
  } else if (process.platform === 'win32' && process.env.SECOND_BRAIN_TTS !== 'piper-only') {
    const r = await run('powershell.exe', powershellArgs(['-List']), '', 20000);
    const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    status = first
      ? { available: true, engine: 'windows', voiceName: first.split('|')[0], maxChars: 280 }
      : { available: false, engine: null, reasonAr: 'لا يوجد صوت عربي في Windows، ولم يُنزَّل الصوت العربي المدمج (Piper) بعد.', maxChars: 280 };
  } else if (process.platform === 'darwin' && process.env.SECOND_BRAIN_TTS !== 'piper-only') {
    const r = await run('say', ['-v', '?'], '', 10000);
    const line = r.stdout.split('\n').find((l) => /\sar[_-]/.test(l));
    status = line
      ? { available: true, engine: 'macos', voiceName: line.trim().split(/\s{2,}/)[0], maxChars: 280 }
      : { available: false, engine: null, reasonAr: 'لا يوجد صوت عربي في macOS، ولم يُنزَّل الصوت العربي المدمج (Piper) بعد.', maxChars: 280 };
  } else {
    status = { available: false, engine: null, reasonAr: 'لم يُنزَّل الصوت العربي المدمج (Piper) بعد.', maxChars: 280 };
  }
  cache = { at: Date.now(), status };
  return status;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Hint بالعربي: دالة بدء تحميل XTTS في الخلفية عند تشغيل البرنامج (إن كان مثبّتاً)، فيكون جاهزاً لأول رد.
 */
export function warmUpVoice(): void {
  const launch = resolveXttsLaunch(resolveVendorDir());
  if (launch) xttsWorker.start(launch).catch(() => undefined);
}

/**
 * Hint بالعربي: دالة توليد صوت WAV لنص عربي بالمحرك المتاح. طلب واحد في كل مرة (طابور)،
 *               وملف الإخراج المؤقت يُحذف بعد قراءته.
 */
export function synthesizeSpeech(text: string, speakerInput?: unknown): Promise<{ wav: Buffer; engine: TtsStatus['engine'] }> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TTS_CHARS);
  if (!clean) return Promise.reject(new Error('لا يوجد نص للنطق.'));
  const job = queue.then(async () => {
    let status = await detectTtsEngine();
    if (!status.available) throw new Error(status.reasonAr ?? 'لا يوجد محرك نطق عربي.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-tts-out-'));
    const out = path.join(dir, 'speech.wav');
    try {
      if (status.engine === 'xtts') {
        const launch = resolveXttsLaunch(resolveVendorDir())!;
        const ready = xttsWorker.start(launch);
        // أثناء التحميل الأول: نستخدم المحرك الاحتياطي حتى لا يتأخر الرد، وإلا ننتظر XTTS
        if (xttsWorker.state !== 'ready' && status.fallbackEngine) {
          status = await detectBaseEngine();
        } else {
          try {
            await ready;
            await xttsWorker.synthesize(clean, normalizeXttsSpeaker(speakerInput), out);
            return { wav: fs.readFileSync(out), engine: 'xtts' as const };
          } catch (err) {
            if (!status.fallbackEngine) throw err;
            status = await detectBaseEngine();
          }
        }
      }
      let r: { code: number | null; stderr: string };
      if (status.engine === 'piper') {
        const p = resolvePiperPaths()!;
        r = await run(p.command, [...p.prefixArgs, '--model', p.model, '--output_file', out], clean, SYNTH_TIMEOUT_MS);
      } else if (status.engine === 'windows') {
        r = await run('powershell.exe', powershellArgs(['-OutFile', out]), clean, SYNTH_TIMEOUT_MS);
      } else {
        const aiff = path.join(dir, 'speech-input.txt');
        fs.writeFileSync(aiff, clean, 'utf8');
        r = await run('say', ['-v', status.voiceName ?? 'Majed', '-f', aiff, '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050'], '', SYNTH_TIMEOUT_MS);
      }
      if (r.code !== 0 || !fs.existsSync(out)) {
        resetTtsCache();
        throw new Error(`تعذر توليد الصوت (${status.engine}): ${r.stderr.trim().slice(0, 200) || `رمز ${r.code}`}`);
      }
      return { wav: fs.readFileSync(out), engine: status.engine };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
