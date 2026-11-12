/**
 * ============================================================================
 * الملف: src/features/assistant/providers/claude-cli-provider.ts
 * القسم: Features -> Assistant -> Providers (مزوّد Claude عبر الاشتراك — Claude Code)
 * Hint بالعربي: يشغّل برنامج Claude Code دون واجهة (claude -p) فيستخدم اشتراك Claude Pro نفسه
 *               بلا أي فاتورة API منفصلة، ويبثّ الرد من مخرجات stream-json.
 *               العزل صارم: لا أدوات، لا خوادم MCP، لا مهارات أو أوامر، لا إعدادات مستخدم أو مشروع،
 *               لا حفظ للجلسات، والتشغيل في مجلد مؤقت فارغ يُحذف بعد الرد. وإن ظهرت أي أداة أو خادم MCP
 *               في رسالة البدء يُوقَف التشغيل فوراً. مفاتيح API تُزال من البيئة حتى لا تتحول الفوترة إليها.
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIProvider, ChatTurn, ProviderChatRequest, ProviderChatResult } from './provider-types.ts';
import { ProviderError, withTimeout } from './provider-types.ts';

/** متغيرات بيئة تُزال قبل التشغيل: تمنع التحول إلى فوترة API أو إلى مزوّد آخر، وتمنع اكتشاف "جلسة متداخلة" */
const STRIPPED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
];

/**
 * Hint بالعربي: طريقة تشغيل برنامج Claude Code (الأمر ومعاملاته الأولى، ومن أين وُجد).
 */
export interface ClaudeCliLaunch {
  command: string;
  prefixArgs: string[];
  source: 'env' | 'settings' | 'path' | 'local-bin' | 'desktop-app';
}

/**
 * Hint بالعربي: دالة تحويل مسار إلى طريقة تشغيل. ملفات .js/.mjs تُشغَّل عبر Node (لمحاكي الاختبارات)،
 *               وعلى Windows لا يُقبل إلا ملف .exe لأن التشغيل يتم بلا shell.
 */
function launchFromPath(filePath: string, source: ClaudeCliLaunch['source']): ClaudeCliLaunch | null {
  const resolved = path.resolve(filePath);
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  if (/\.m?js$/i.test(resolved)) return { command: process.execPath, prefixArgs: [resolved], source };
  if (process.platform === 'win32' && !/\.exe$/i.test(resolved)) return null;
  return { command: resolved, prefixArgs: [], source };
}

/**
 * Hint بالعربي: دالة مقارنة رقمي إصدارين (مثل 2.1.321) لاختيار أحدث نسخة مضمّنة في تطبيق سطح المكتب.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Hint بالعربي: دالة البحث عن برنامج Claude Code بالترتيب:
 *               1) متغير البيئة SECOND_BRAIN_CLAUDE_CLI (القيمة none تعطّل المزوّد — تستخدمها الاختبارات)،
 *               2) المسار المخصص في الإعدادات، 3) PATH، 4) ~/.local/bin، 5) النسخة المضمّنة في تطبيق Claude لسطح المكتب.
 */
export function locateClaudeCli(settingsPath?: string, env: NodeJS.ProcessEnv = process.env): ClaudeCliLaunch | null {
  const fromEnv = env.SECOND_BRAIN_CLAUDE_CLI;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv === 'none' ? null : launchFromPath(fromEnv, 'env');
  if (settingsPath && settingsPath.trim()) return launchFromPath(settingsPath.trim(), 'settings');

  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const found = launchFromPath(path.join(dir, exeName), 'path');
    if (found) return found;
  }
  const home = os.homedir();
  const localCandidates = [path.join(home, '.local', 'bin', exeName)];
  if (process.platform === 'darwin') localCandidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  for (const candidate of localCandidates) {
    const found = launchFromPath(candidate, 'local-bin');
    if (found) return found;
  }
  if (process.platform === 'win32' && env.APPDATA) {
    const base = path.join(env.APPDATA, 'Claude', 'claude-code');
    try {
      const versions = fs.readdirSync(base).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(compareVersions).reverse();
      for (const version of versions) {
        for (const hash of fs.readdirSync(path.join(base, version))) {
          const found = launchFromPath(path.join(base, version, hash, 'claude.exe'), 'desktop-app');
          if (found) return found;
        }
      }
    } catch {
      // تطبيق سطح المكتب غير مثبّت
    }
  }
  return null;
}

/**
 * Hint بالعربي: دالة بناء بيئة التشغيل: نسخة من بيئة البرنامج بعد إزالة مفاتيح API ومتغيرات التوجيه.
 */
export function buildClaudeCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of STRIPPED_ENV_VARS) delete clean[name];
  delete clean.SECOND_BRAIN_CLAUDE_CLI;
  return clean;
}

/**
 * Hint بالعربي: دالة بناء معاملات التشغيل المعزول (مفصولة للاختبار).
 */
export function buildClaudeCliArgs(model: string, systemPromptFile: string, mcpConfigFile: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigFile,
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt-file', systemPromptFile,
    '--model', model,
  ];
}

/**
 * Hint بالعربي: دالة تحويل المحادثة إلى نص واحد يُرسل عبر stdin (الوضع دون واجهة يقبل رسالة واحدة).
 */
export function formatConversationForCli(messages: ChatTurn[]): string {
  if (messages.length <= 1) return messages[0]?.content ?? '';
  const history = messages.slice(0, -1).map((m) => `[${m.role === 'user' ? 'المستخدم' : 'المساعد'}]\n${m.content}`);
  return `سجل المحادثة السابق:\n\n${history.join('\n\n')}\n\n---\nالرسالة الحالية:\n${messages[messages.length - 1].content}`;
}

/**
 * Hint بالعربي: دالة تحويل رسالة الخطأ من Claude Code إلى سبب واضح بالعربية.
 */
export function describeClaudeCliErrorAr(raw: string, errorCode?: string): string {
  if (errorCode === 'authentication_failed' || /authenticat|log ?in|oauth|not logged/i.test(raw)) {
    return 'Claude Code غير مسجّل الدخول باشتراكك (شغّل: claude auth login)';
  }
  if (errorCode === 'rate_limit' || /usage limit|rate limit|limit reached|5-hour|weekly limit/i.test(raw)) {
    return 'تم بلوغ حد استخدام اشتراك Claude مؤقتاً';
  }
  if (/model/i.test(raw) && /not found|invalid|unknown/i.test(raw)) return `اسم نموذج Claude غير صحيح: ${raw.slice(0, 200)}`;
  return `Claude Code: ${raw.slice(0, 300) || 'خطأ غير معروف'}`;
}

/**
 * Hint بالعربي: حالة تسجيل الدخول في Claude Code.
 */
export interface ClaudeCliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  source?: ClaudeCliLaunch['source'];
  reasonAr?: string;
}

/**
 * Hint بالعربي: دالة قراءة حالة تسجيل الدخول (claude auth status) دون أي استهلاك للحصة.
 */
export async function readClaudeCliAuthStatus(launch: ClaudeCliLaunch | null, timeoutMs = 15000): Promise<ClaudeCliAuthStatus> {
  if (!launch) return { installed: false, loggedIn: false, reasonAr: 'Claude Code غير مثبّت على هذا الجهاز' };
  const result = await new Promise<{ stdout: string; error?: string }>((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(launch.command, [...launch.prefixArgs, 'auth', 'status', '--json'], {
      env: buildClaudeCliEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: os.tmpdir(),
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) resolve({ stdout, error: 'انتهت مهلة قراءة حالة Claude Code' });
      settled = true;
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, error: err.message });
      settled = true;
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout });
      settled = true;
    });
  });
  if (result.error) return { installed: true, loggedIn: false, source: launch.source, reasonAr: `تعذر تشغيل Claude Code: ${result.error}` };
  try {
    const json = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
    const loggedIn = json.loggedIn === true;
    return {
      installed: true,
      loggedIn,
      authMethod: json.authMethod,
      source: launch.source,
      reasonAr: loggedIn ? undefined : 'Claude Code غير مسجّل الدخول باشتراكك (شغّل: claude auth login)',
    };
  } catch {
    return { installed: true, loggedIn: false, source: launch.source, reasonAr: 'تعذر قراءة حالة تسجيل الدخول في Claude Code' };
  }
}

/** ذاكرة مؤقتة لحالة تسجيل الدخول (دقيقة واحدة) حتى لا يُشغَّل البرنامج مع كل تحديث للواجهة */
const AUTH_CACHE_MS = 60000;
const authCache = new Map<string, { at: number; status: ClaudeCliAuthStatus }>();

/**
 * Hint بالعربي: دالة مسح ذاكرة حالة تسجيل الدخول (بعد فشل المصادقة، وفي الاختبارات).
 */
export function resetClaudeCliStatusCache(): void {
  authCache.clear();
}

/**
 * Hint بالعربي: دالة قراءة حالة تسجيل الدخول مع ذاكرة مؤقتة لمدة دقيقة.
 */
export async function getClaudeCliAuthStatusCached(launch: ClaudeCliLaunch | null): Promise<ClaudeCliAuthStatus> {
  if (!launch) return readClaudeCliAuthStatus(null);
  const key = [launch.command, ...launch.prefixArgs].join(' ');
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.status;
  const status = await readClaudeCliAuthStatus(launch);
  authCache.set(key, { at: Date.now(), status });
  return status;
}

/**
 * Hint بالعربي: إعدادات إنشاء مزوّد Claude عبر الاشتراك.
 */
export interface ClaudeCliProviderOptions {
  launch: ClaudeCliLaunch | null;
  model: string;
  timeoutMs: number;
}

/**
 * Hint بالعربي: دالة إنشاء مزوّد Claude عبر الاشتراك (Claude Code).
 */
export function createClaudeCliProvider(options: ClaudeCliProviderOptions): AIProvider {
  const { launch } = options;
  return {
    id: 'claude-cli',
    labelAr: `Claude عبر الاشتراك (${options.model})`,
    isConfigured: () => launch !== null,
    async checkAvailability() {
      const status = await getClaudeCliAuthStatusCached(launch);
      return status.loggedIn ? { ok: true } : { ok: false, reasonAr: status.reasonAr };
    },
    async chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult> {
      if (!launch) throw new ProviderError('claude-cli', 'Claude Code غير مثبّت على هذا الجهاز');
      try {
        return await runClaudeCli(launch, options, request, onDelta);
      } catch (err) {
        if (err instanceof ProviderError && /claude auth login/.test(err.message)) resetClaudeCliStatusCache();
        throw err;
      }
    },
  };
}

/**
 * Hint بالعربي: دالة تشغيل Claude Code المعزول لطلب واحد وقراءة البثّ.
 */
async function runClaudeCli(
  launch: ClaudeCliLaunch,
  options: ClaudeCliProviderOptions,
  request: ProviderChatRequest,
  onDelta?: (text: string) => void
): Promise<ProviderChatResult> {
  // مجلد مؤقت فارغ: مكان التشغيل + ملف تعليمات النظام + إعداد MCP فارغ؛ يُحذف دائماً بعد الرد
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-claude-'));
  const systemFile = path.join(workDir, 'system-prompt.txt');
  const mcpFile = path.join(workDir, 'mcp-none.json');
  fs.writeFileSync(systemFile, request.system, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }), { encoding: 'utf8', mode: 0o600 });
  const signal = withTimeout(request.signal, options.timeoutMs);

  try {
    return await new Promise<ProviderChatResult>((resolve, reject) => {
      const child = spawn(launch.command, [...launch.prefixArgs, ...buildClaudeCliArgs(options.model, systemFile, mcpFile)], {
        cwd: workDir,
        env: buildClaudeCliEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let text = '';
      let model = options.model;
      let finalResult: string | undefined;
      let resultIsError = false;
      let errorCode: string | undefined;
      let fatal: ProviderError | undefined;
      let stderr = '';
      let buffer = '';

      const abort = (): void => {
        fatal ??= new ProviderError('claude-cli', 'أُلغي الطلب أو انتهت مهلته.', { retryable: true });
        child.kill();
      };
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line) as Record<string, any>;
        } catch {
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (typeof msg.model === 'string' && msg.model) model = msg.model;
          const tools = Array.isArray(msg.tools) ? msg.tools : [];
          const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
          if (tools.length || servers.length) {
            fatal = new ProviderError('claude-cli', 'أوقف Second Brain تشغيل Claude Code لأنه حمّل أدوات أو خوادم MCP رغم العزل.');
            child.kill();
          }
        } else if (msg.type === 'stream_event') {
          const ev = msg.event ?? {};
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            const piece = String(ev.delta.text);
            text += piece;
            onDelta?.(piece);
          }
        } else if (msg.type === 'assistant' && msg.error) {
          errorCode = String(msg.error);
        } else if (msg.type === 'result') {
          finalResult = typeof msg.result === 'string' ? msg.result : '';
          resultIsError = msg.is_error === true;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        signal.removeEventListener('abort', abort);
        reject(new ProviderError('claude-cli', `تعذر تشغيل Claude Code: ${err.message}`));
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort);
        handleLine(buffer);
        if (fatal) return reject(fatal);
        if (resultIsError || errorCode) {
          return reject(new ProviderError('claude-cli', describeClaudeCliErrorAr(finalResult || stderr.trim(), errorCode), { retryable: errorCode === 'rate_limit' }));
        }
        if (!text.trim() && finalResult?.trim()) {
          text = finalResult;
          onDelta?.(finalResult);
        }
        if (!text.trim()) {
          return reject(new ProviderError('claude-cli', describeClaudeCliErrorAr(stderr.trim() || `انتهى بلا رد (رمز ${code ?? '?'})`)));
        }
        resolve({ text, model });
      });
      child.stdin.on('error', () => {
        // قد يُغلق البرنامج stdin مبكراً عند الخطأ؛ يُعالج الخطأ في close
      });
      child.stdin.end(formatConversationForCli(request.messages), 'utf8');
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
