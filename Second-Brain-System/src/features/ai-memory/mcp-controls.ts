/**
 * ============================================================================
 * الملف: src/features/ai-memory/mcp-controls.ts
 * القسم: Features -> AI Memory (التحكم في أدوات MCP وسجل عملياتها، 3.8.0 — المرحلة 2.6 من docs/12)
 * Hint بالعربي: - مفتاح تشغيل لكل أداة من أدوات خادم الذاكرة المشتركة (MCP). المعطّلة لا تظهر في tools/list
 *                 وتُرفض في tools/call. الإعداد في settings.json تحت mcp.disabledTools (خاص بهذا الجهاز، لا يُزامَن)،
 *                 ويُقرأ عند كل طلب، فيسري فوراً بلا إعادة تشغيل. وعند تغيّره يرسل الخادم notifications/tools/list_changed
 *                 (3.8.2، ISS-043) فتصل الأداة المعادة إلى المحادثة المفتوحة أيضاً.
 *               - سجل عمليات data/logs/mcp-audit.log (سطر JSON لكل استدعاء): الوقت، والبرنامج المستدعي (من initialize)،
 *                 والأداة، والمشروع، والنتيجة، والمدة. **بلا أي محتوى** (لا المعاملات ولا الرد).
 *                 يُدوَّر 5MB × 3 كبقية السجلات.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig, readRawSettings, updateSystemSettings } from '../../core/config-manager.ts';
import { rotateLogIfLarge } from '../../core/logger.ts';
import { ensureDirectoryExists } from '../../shared/file-helpers.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';

/** نتيجة استدعاء أداة في السجل */
export type McpAuditResult = 'ok' | 'error' | 'disabled' | 'invalid' | 'unknown_tool';

/** سطر واحد في سجل العمليات */
export interface McpAuditEntry {
  at: string;
  client: string;
  clientVersion: string;
  tool: string;
  projectId: string | null;
  result: McpAuditResult;
  durationMs: number;
}

function clean(value: unknown, max: number): string {
  return redactSecrets(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).text.trim().slice(0, max);
}

/**
 * Hint بالعربي: الأدوات المعطّلة على هذا الجهاز.
 */
export function readDisabledMcpTools(): Set<string> {
  try {
    const raw = readRawSettings() as { mcp?: { disabledTools?: unknown } };
    const list = Array.isArray(raw.mcp?.disabledTools) ? raw.mcp!.disabledTools : [];
    return new Set((list as unknown[]).filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Hint بالعربي: هل الأداة مفعّلة؟ (الافتراضي: نعم)
 */
export function isMcpToolEnabled(name: string): boolean {
  return !readDisabledMcpTools().has(name);
}

/**
 * Hint بالعربي: تفعيل أداة أو تعطيلها على هذا الجهاز.
 */
export function setMcpToolEnabled(name: string, enabled: boolean): void {
  const disabled = readDisabledMcpTools();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const raw = readRawSettings() as { mcp?: Record<string, unknown> };
  updateSystemSettings({ mcp: { ...(raw.mcp ?? {}), disabledTools: [...disabled].sort() } });
}

/**
 * Hint بالعربي: مسار سجل العمليات.
 */
export function resolveMcpAuditFile(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'logs', 'mcp-audit.log');
}

/**
 * Hint بالعربي: إضافة سطر إلى سجل العمليات (لا ترمي أبداً). المشروع والبرنامج منقّيان ومقصوصان، ولا محتوى.
 */
export function appendMcpAudit(entry: { client?: unknown; clientVersion?: unknown; tool: unknown; projectId?: unknown; result: McpAuditResult; durationMs: number }, now: Date = new Date()): void {
  try {
    const file = resolveMcpAuditFile();
    ensureDirectoryExists(path.dirname(file));
    rotateLogIfLarge(file);
    const line: McpAuditEntry = {
      at: now.toISOString(),
      client: clean(entry.client, 80) || 'غير معروف',
      clientVersion: clean(entry.clientVersion, 40),
      tool: clean(entry.tool, 80),
      projectId: entry.projectId === undefined || entry.projectId === null || entry.projectId === '' ? null : clean(entry.projectId, 200),
      result: entry.result,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
    };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    // السجل لا يُفشل الأداة
  }
}

/**
 * Hint بالعربي: آخر سطور السجل (الأحدث أولاً).
 */
export function readMcpAudit(limit = 100): McpAuditEntry[] {
  try {
    const file = resolveMcpAuditFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: McpAuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as McpAuditEntry);
      } catch {
        // سطر تالف يُتجاهل
      }
    }
    return out;
  } catch {
    return [];
  }
}
