/**
 * ============================================================================
 * الملف: src/features/knowledge/knowledge-access.ts
 * القسم: Features -> Knowledge (الوصول إلى المعرفة بلا جلسة، وقائمة المراجعة، الإصدار 4.0.1)
 * Hint بالعربي: خادم MCP برنامج منفصل تشغّله أدوات الذكاء، ولا يملك جلسة الخزنة. فبقرار القائد:
 *               - نسخة محلية من مفتاح المعرفة في data/knowledge/device-key.json على كل جهاز:
 *                 تُكتب عند كل فتح للقائد، ولا تُزامَن ولا تدخل النسخ، وصلاحيتها لصاحب الجهاز وحده.
 *                 فيعمل MCP بالمعرفة والخزنة مقفلة. والمفتاح المحلي لا يكشف مفتاح البيانات (اشتقاق باتجاه واحد).
 *               - يمكن تعطيلها من بطاقة «🧩 أدوات MCP» (mcp.knowledgeDeviceKey = false في الإعدادات، خاص بالجهاز)،
 *                 فتُحذف النسخة، ولا تُكتب ثانية، ويعمل MCP بالمعرفة عند فتح الخزنة فقط.
 *               - قائمة المراجعة: الاعتماد يكتب العقدة المقترحة وعلاقاتها، والرفض يبقي الاقتراح بحالته.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRawSettings, updateSystemSettings } from '../../core/config-manager.ts';
import { readJsonFileSafe, removePathSync, writeFileAtomic } from '../../shared/file-helpers.ts';
import { readKnowledgeGraph, resolveKnowledgeDir, writeEdge, writeNode, writeReviewItem } from './knowledge-store.ts';
import type { KnowledgeReviewItem } from './knowledge-types.ts';

const DEVICE_KEY_FORMAT = 'second-brain-knowledge-device-key';

/**
 * Hint بالعربي: مسار النسخة المحلية من مفتاح المعرفة (خارج nodes/edges/review، فلا تُسرد للمزامنة ولا للنسخ).
 */
export function resolveDeviceKeyFile(dir: string = resolveKnowledgeDir()): string {
  return path.join(dir, 'device-key.json');
}

/**
 * Hint بالعربي: هل النسخة المحلية مفعّلة على هذا الجهاز؟ (الافتراضي: نعم، قرار القائد)
 */
export function isKnowledgeDeviceKeyEnabled(): boolean {
  try {
    const raw = readRawSettings() as { mcp?: { knowledgeDeviceKey?: unknown } };
    return raw.mcp?.knowledgeDeviceKey !== false;
  } catch {
    return true;
  }
}

/**
 * Hint بالعربي: بصمة قصيرة للمفتاح، تكشف الملف التالف أو المفتاح القديم (لا تكشف المفتاح).
 */
function fingerprintOf(kk: Buffer): string {
  return crypto.createHash('sha256').update(kk).digest('hex').slice(0, 16);
}

/**
 * Hint بالعربي: دالة كتابة النسخة المحلية أو حذفها حسب الإعداد. تُستدعى عند كل فتح للقائد.
 *               على الماك و Linux تُكتب بصلاحية 600 (لصاحبها وحده).
 */
export function syncKnowledgeDeviceKey(kk: Buffer, dir: string = resolveKnowledgeDir()): 'written' | 'unchanged' | 'removed' | 'disabled' {
  const file = resolveDeviceKeyFile(dir);
  if (!isKnowledgeDeviceKeyEnabled()) {
    if (fs.existsSync(file)) {
      removePathSync(file, { force: true });
      return 'removed';
    }
    return 'disabled';
  }
  const fingerprint = fingerprintOf(kk);
  const current = readJsonFileSafe<{ fingerprint?: string } | null>(file, null);
  if (current?.fingerprint === fingerprint && readDeviceKnowledgeKey(dir)) return 'unchanged';
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, JSON.stringify({ format: DEVICE_KEY_FORMAT, version: 1, keyHex: kk.toString('hex'), fingerprint }));
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return 'written';
}

/**
 * Hint بالعربي: دالة قراءة النسخة المحلية (لخادم MCP). null إن كانت معطّلة أو غائبة أو تالفة.
 */
export function readDeviceKnowledgeKey(dir: string = resolveKnowledgeDir()): Buffer | null {
  if (!isKnowledgeDeviceKeyEnabled()) return null;
  const raw = readJsonFileSafe<{ format?: string; version?: number; keyHex?: string; fingerprint?: string } | null>(resolveDeviceKeyFile(dir), null);
  if (!raw || raw.format !== DEVICE_KEY_FORMAT || raw.version !== 1 || typeof raw.keyHex !== 'string' || !/^[a-f0-9]{64}$/.test(raw.keyHex)) return null;
  const kk = Buffer.from(raw.keyHex, 'hex');
  return fingerprintOf(kk) === raw.fingerprint ? kk : null;
}

/**
 * Hint بالعربي: تفعيل النسخة المحلية أو تعطيلها على هذا الجهاز. التعطيل يحذفها فوراً،
 *               والتفعيل يكتبها عند فتح القائد التالي (أو الآن إن أُعطي المفتاح).
 */
export function setKnowledgeDeviceKeyEnabled(enabled: boolean, kk: Buffer | null = null, dir: string = resolveKnowledgeDir()): void {
  const raw = readRawSettings() as { mcp?: Record<string, unknown> };
  updateSystemSettings({ mcp: { ...(raw.mcp ?? {}), knowledgeDeviceKey: enabled } });
  if (!enabled) removePathSync(resolveDeviceKeyFile(dir), { force: true });
  else if (kk) syncKnowledgeDeviceKey(kk, dir);
}

/**
 * Hint بالعربي: دالة قرار القائد في اقتراح: الاعتماد يكتب العقدة وعلاقاتها، والرفض يبقيه مرفوضاً.
 *               ترمي إن لم يوجد الاقتراح أو حُسم قبل ذلك.
 */
export function decideReviewItem(kk: Buffer, id: string, decision: 'approve' | 'reject', dir: string = resolveKnowledgeDir(), now: Date = new Date()): KnowledgeReviewItem {
  const graph = readKnowledgeGraph(kk, dir);
  const item = graph.reviews.get(id);
  if (!item) throw new Error('الاقتراح غير موجود.');
  if (item.status !== 'pending') throw new Error(item.status === 'approved' ? 'اعتُمد هذا الاقتراح من قبل.' : 'رُفض هذا الاقتراح من قبل.');
  if (decision === 'approve') {
    writeNode(kk, item.proposal.node, dir);
    for (const e of item.proposal.edges) writeEdge(kk, e, dir);
  }
  return writeReviewItem(kk, { ...item, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now.toISOString() }, dir);
}
