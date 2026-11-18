/**
 * ============================================================================
 * الملف: src/features/auth/passkey-probe.ts
 * القسم: Features -> Auth (قياس دعم Passkeys وامتداد PRF، 3.2.0 — المرحلة 2.2 من docs/12)
 * Hint بالعربي: قبل بناء «افتح بالبصمة أو الوجه» نقيس على كل جهاز ومتصفح:
 *               - هل يوجد WebAuthn ومصادق مدمج (Windows Hello أو Touch ID)؟
 *               - هل يعطي امتداد PRF سرّاً ثابتاً (نفسه في كل مرة) بعد التحقق من المستخدم (UV)؟
 *               القياس يجري في المتصفح، ويُرسل إلى الخادم **الخلاصة فقط** (نعم/لا وأطوال وأسماء أخطاء)،
 *               ولا يُرسل ناتج PRF نفسه أبداً. الخلاصة تُصنَّف إلى:
 *               - prf:       الطريقة الأولى ممكنة (مفتاح يُشتق من PRF ويلفّ مفتاح البيانات).
 *               - keystore:  Passkey يعمل بلا PRF، فالبديل: مفتاح البيانات في مخزن مفاتيح النظام
 *                            (DPAPI أو Keychain) ولا يُفك إلا بعد توقيع Passkey ناجح.
 *               - unsupported: لا Passkey على هذا الجهاز أو المتصفح.
 *               التقارير محلية في data/passkey-probe/ (لا تُزامَن ولا تحوي أي سر).
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { ensureDirectoryExists, readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';

/** نوع المصادق المطلوب في القياس */
export type ProbeAttachment = 'platform' | 'cross-platform';

/** نتيجة التصنيف */
export type ProbeVerdict = 'prf' | 'keystore' | 'unsupported';

/** تقرير القياس كما يُحفظ (بلا أي سر) */
export interface PasskeyProbeReport {
  id: string;
  at: string;
  deviceName: string;
  requested: ProbeAttachment;
  userAgent: string;
  platform: string;
  origin: string;
  webauthn: boolean;
  platformAuthenticator: boolean | null;
  clientPrfCapability: boolean | null;
  created: boolean;
  attachment: string | null;
  createPrfEnabled: boolean | null;
  getPrfReturned: boolean;
  prfLength: number;
  prfStable: boolean;
  userVerified: boolean;
  errorName: string | null;
  errorStep: string | null;
  verdict: ProbeVerdict;
  verdictAr: string;
}

const ERROR_NAMES = new Set(['NotAllowedError', 'SecurityError', 'InvalidStateError', 'NotSupportedError', 'AbortError', 'ConstraintError', 'UnknownError', 'TypeError', 'Error']);
const ERROR_STEPS = new Set(['capabilities', 'create', 'get-1', 'get-2']);

function bool(v: unknown): boolean {
  return v === true;
}
function boolOrNull(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}
function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}

/**
 * Hint بالعربي: دالة تصنيف نتيجة القياس إلى الطريقة الممكنة على هذا الجهاز، مع شرح بالعربية.
 */
export function classifyProbe(r: Pick<PasskeyProbeReport, 'webauthn' | 'created' | 'getPrfReturned' | 'prfLength' | 'prfStable' | 'userVerified' | 'errorName' | 'errorStep' | 'origin'>): { verdict: ProbeVerdict; verdictAr: string } {
  if (!r.webauthn) return { verdict: 'unsupported', verdictAr: '❌ هذا المتصفح لا يدعم Passkeys (WebAuthn).' };
  if (r.errorName === 'SecurityError') {
    return { verdict: 'unsupported', verdictAr: `❌ رفض المتصفح الطلب لأسباب أمنية. افتح البرنامج على http://localhost (لا 127.0.0.1) ثم أعد القياس. (العنوان الحالي: ${r.origin || '؟'})` };
  }
  if (!r.created) {
    if (r.errorName === 'NotAllowedError') return { verdict: 'unsupported', verdictAr: '⚠️ أُلغي الطلب أو انتهى وقته قبل إنشاء Passkey. أعد القياس وأكمل نافذة النظام (الوجه أو البصمة أو الرمز).' };
    return { verdict: 'unsupported', verdictAr: `❌ تعذّر إنشاء Passkey على هذا الجهاز${r.errorName ? ` (${r.errorName})` : ''}.` };
  }
  if (r.getPrfReturned && r.prfStable && r.prfLength === 32 && r.userVerified) {
    return { verdict: 'prf', verdictAr: '✅ PRF مدعوم: سرّ ثابت بعد التحقق منك. يمكن أن تفتح البصمة أو الوجه الخزنة بتشفير حقيقي (الطريقة الأولى).' };
  }
  if (r.errorStep === 'get-1' || r.errorStep === 'get-2') {
    if (r.errorName === 'NotAllowedError') return { verdict: 'unsupported', verdictAr: '⚠️ أُنشئ Passkey، لكن أُلغي التحقق الثاني أو انتهى وقته. أعد القياس وأكمل النافذتين.' };
  }
  if (!r.userVerified) {
    return { verdict: 'unsupported', verdictAr: '❌ أُنشئ Passkey بلا تحقق من المستخدم (لا وجه ولا بصمة ولا رمز)، فلا يصلح لفتح الخزنة.' };
  }
  if (r.getPrfReturned && !r.prfStable) {
    return { verdict: 'keystore', verdictAr: '⚠️ PRF أعاد قيمة تتغيّر بين مرتين، فلا يصلح مفتاحاً. البديل: مفتاح البيانات في مخزن مفاتيح النظام، ولا يُفك إلا بعد توقيع Passkey.' };
  }
  return { verdict: 'keystore', verdictAr: '⚠️ Passkey يعمل مع التحقق منك، لكن بلا PRF. البديل: مفتاح البيانات في مخزن مفاتيح النظام (DPAPI أو Keychain)، ولا يُفك إلا بعد توقيع Passkey ناجح.' };
}

/**
 * Hint بالعربي: دالة تنظيف التقرير القادم من المتصفح (قائمة بيضاء للحقول، وأطوال محدودة) ثم تصنيفه.
 *               ترفض أي حقل يشبه ناتج PRF نفسه (لا يُخزَّن ولا يُقبل).
 */
export function normalizeProbeReport(input: Record<string, unknown>, deviceName: string, now: Date = new Date()): PasskeyProbeReport {
  for (const k of Object.keys(input)) {
    if (/prf(output|value|bytes|result)s?$/i.test(k) || /^(first|second)$/i.test(k)) throw new Error('التقرير لا يحمل ناتج PRF أبداً.');
  }
  const errorName = text(input.errorName, 40);
  const errorStep = text(input.errorStep, 20);
  const base = {
    requested: (input.requested === 'cross-platform' ? 'cross-platform' : 'platform') as ProbeAttachment,
    userAgent: text(input.userAgent, 300),
    platform: text(input.platform, 60),
    origin: text(input.origin, 120),
    webauthn: bool(input.webauthn),
    platformAuthenticator: boolOrNull(input.platformAuthenticator),
    clientPrfCapability: boolOrNull(input.clientPrfCapability),
    created: bool(input.created),
    attachment: input.attachment === 'platform' || input.attachment === 'cross-platform' ? (input.attachment as string) : null,
    createPrfEnabled: boolOrNull(input.createPrfEnabled),
    getPrfReturned: bool(input.getPrfReturned),
    prfLength: typeof input.prfLength === 'number' && Number.isInteger(input.prfLength) && input.prfLength >= 0 && input.prfLength <= 128 ? input.prfLength : 0,
    prfStable: bool(input.prfStable),
    userVerified: bool(input.userVerified),
    errorName: errorName && ERROR_NAMES.has(errorName) ? errorName : errorName ? 'Error' : null,
    errorStep: errorStep && ERROR_STEPS.has(errorStep) ? errorStep : null,
  };
  const { verdict, verdictAr } = classifyProbe(base);
  return { id: `probe-${now.getTime()}`, at: now.toISOString(), deviceName: text(deviceName, 80), ...base, verdict, verdictAr };
}

/**
 * Hint بالعربي: مجلد تقارير القياس على هذا الجهاز.
 */
export function resolveProbeDir(): string {
  return path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data', 'passkey-probe');
}

/**
 * Hint بالعربي: دالة حفظ تقرير (ملف لكل قياس).
 */
export function saveProbeReport(report: PasskeyProbeReport, dir: string = resolveProbeDir()): string {
  ensureDirectoryExists(dir);
  const file = path.join(dir, `${report.id}.json`);
  writeFileAtomic(file, JSON.stringify(report, null, 2));
  return file;
}

/**
 * Hint بالعربي: دالة سرد التقارير (الأحدث أولاً).
 */
export function listProbeReports(dir: string = resolveProbeDir(), limit = 30): PasskeyProbeReport[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^probe-\d{13}\.json$/.test(n))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((n) => readJsonFileSafe<PasskeyProbeReport | null>(path.join(dir, n), null))
    .filter((r): r is PasskeyProbeReport => Boolean(r && r.id));
}
