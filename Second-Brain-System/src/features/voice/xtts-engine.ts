/**
 * ============================================================================
 * الملف: src/features/voice/xtts-engine.ts
 * القسم: Features -> Voice (محرك XTTS-v2 — الصوت العربي عالي الجودة)
 * Hint بالعربي: يدير عامل Python دائماً (xtts-worker.py) يحمّل نموذج XTTS-v2 مرة واحدة ويبقى في الذاكرة،
 *               فتُولَّد كل جملة في ثوانٍ. يبدأ التحميل عند تشغيل البرنامج، ويُطفأ بعد 30 دقيقة بلا استخدام
 *               لتحرير ذاكرة كرت الشاشة، ثم يعود عند أول طلب. الطلبات تمر عبر stdin بصيغة JSON (بلا shell).
 *               الأصوات المعتمدة: Suad Qasim (الافتراضي) و Damien Black — اختيار القائد.
 * ============================================================================
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logSystemInfo } from '../../core/logger.ts';

/** الأصوات المعتمدة (اختارها القائد بعد سماع العيّنات) */
export const XTTS_SPEAKERS = ['Suad Qasim', 'Damien Black'] as const;
export type XttsSpeaker = (typeof XTTS_SPEAKERS)[number];
export const DEFAULT_XTTS_SPEAKER: XttsSpeaker = 'Suad Qasim';
/** أقصى طول لجملة واحدة (حد XTTS للعربية نحو 166 حرفاً) */
export const XTTS_MAX_CHARS = 160;

const IDLE_UNLOAD_MS = 30 * 60 * 1000;
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 90 * 1000;

/**
 * Hint بالعربي: طريقة تشغيل العامل: Python البيئة المعزولة + سكربت العامل (أو محاكي .mjs في الاختبارات).
 */
export interface XttsLaunch {
  command: string;
  args: string[];
}

/**
 * Hint بالعربي: دالة البحث عن XTTS المثبّت في vendor (البيئة المعزولة + علامة اكتمال التثبيت).
 */
export function resolveXttsLaunch(vendorDir: string, env: NodeJS.ProcessEnv = process.env): XttsLaunch | null {
  const fake = env.SECOND_BRAIN_XTTS_WORKER;
  if (fake) return fs.existsSync(fake) ? { command: process.execPath, args: [fake] } : null;
  if (env.SECOND_BRAIN_TTS === 'piper-only' || env.SECOND_BRAIN_TTS === 'none') return null;
  const python =
    process.platform === 'win32' ? path.join(vendorDir, 'xtts-venv', 'Scripts', 'python.exe') : path.join(vendorDir, 'xtts-venv', 'bin', 'python');
  if (!fs.existsSync(python) || !fs.existsSync(path.join(vendorDir, 'xtts-ready.json'))) return null;
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xtts-worker.py');
  return { command: python, args: ['-I', worker] };
}

type WorkerState = 'stopped' | 'loading' | 'ready' | 'failed';

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Hint بالعربي: عامل XTTS الدائم (نسخة واحدة لكل البرنامج).
 */
class XttsWorker {
  state: WorkerState = 'stopped';
  device = '';
  lastError = '';
  private child: ChildProcessWithoutNullStreams | null = null;
  private launchKey = '';
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  /** يبدأ التحميل إن لم يكن قد بدأ؛ يُرجع وعداً يكتمل عند الجاهزية */
  start(launch: XttsLaunch): Promise<void> {
    const key = [launch.command, ...launch.args].join('\u0000');
    if (this.ready && this.launchKey === key && this.state !== 'failed') return this.ready;
    this.stop();
    this.launchKey = key;
    this.state = 'loading';
    this.lastError = '';
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COQUI_TOS_AGREED: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      const loadTimer = setTimeout(() => {
        this.fail('انتهت مهلة تحميل نموذج XTTS.');
        reject(new Error(this.lastError));
      }, LOAD_TIMEOUT_MS);
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line) continue;
          let msg: Record<string, any>;
          try {
            msg = JSON.parse(line) as Record<string, any>;
          } catch {
            continue;
          }
          if ('ready' in msg) {
            clearTimeout(loadTimer);
            if (msg.ready) {
              this.state = 'ready';
              this.device = String(msg.device ?? '');
              logSystemInfo('Voice', `XTTS جاهز على ${this.device} خلال ${msg.loadSeconds ?? '?'} ث.`);
              this.touch();
              resolve();
            } else {
              this.fail(`تعذر تحميل XTTS: ${String(msg.error ?? '')}`);
              reject(new Error(this.lastError));
            }
          } else if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (!p) continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve();
            else p.reject(new Error(`XTTS: ${String(msg.error ?? 'خطأ')}`));
          }
        }
      });
      child.stderr.on('data', () => undefined); // رسائل المكتبات التشخيصية: تُتجاهل
      child.on('error', (err) => {
        clearTimeout(loadTimer);
        this.fail(`تعذر تشغيل XTTS: ${err.message}`);
        reject(new Error(this.lastError));
      });
      child.on('exit', (code) => {
        clearTimeout(loadTimer);
        if (this.child !== child) return;
        this.child = null;
        if (this.state === 'loading') {
          this.fail(`توقف XTTS أثناء التحميل (رمز ${code ?? '?'}).`);
          reject(new Error(this.lastError));
        } else if (this.state === 'ready') {
          this.state = 'stopped';
          this.ready = null;
        }
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('توقف XTTS.'));
        }
        this.pending.clear();
      });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  /** توليد جملة إلى ملف WAV (العامل يجب أن يكون جاهزاً) */
  synthesize(text: string, speaker: XttsSpeaker, outFile: string): Promise<void> {
    if (this.state !== 'ready' || !this.child) return Promise.reject(new Error('XTTS غير جاهز.'));
    this.touch();
    const id = this.nextId++;
    const child = this.child;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('انتهت مهلة توليد الصوت بـ XTTS.'));
      }, SYNTH_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, text, speaker, out: outFile })}\n`, 'utf8');
    });
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.stdin.end();
      c.kill();
    }
    this.state = 'stopped';
    this.ready = null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logSystemInfo('Voice', 'أُطفئ XTTS بعد 30 دقيقة بلا استخدام (لتحرير ذاكرة كرت الشاشة).');
      this.stop();
    }, IDLE_UNLOAD_MS);
    this.idleTimer.unref();
  }

  private fail(message: string): void {
    this.state = 'failed';
    this.lastError = message;
    logSystemInfo('Voice', message);
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.kill();
    }
  }
}

export const xttsWorker = new XttsWorker();

/**
 * Hint بالعربي: دالة التحقق من اسم الصوت المطلوب (يعيد الافتراضي إن كان غير معتمد).
 */
export function normalizeXttsSpeaker(value: unknown): XttsSpeaker {
  return XTTS_SPEAKERS.includes(value as XttsSpeaker) ? (value as XttsSpeaker) : DEFAULT_XTTS_SPEAKER;
}
