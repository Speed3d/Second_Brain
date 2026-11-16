/**
 * ============================================================================
 * الملف: src/features/dashboard-app/http-utils.ts
 * القسم: Features -> Dashboard App (أدوات HTTP المشتركة لخادم سطح المكتب)
 * Hint بالعربي: دوال الرد بصيغة JSON/HTML، قراءة جسم الطلب بحد أقصى للحجم، الكوكيز،
 *               رؤوس الأمان، والتحقق من أن الطلب قادم من واجهة البرنامج نفسها فقط
 *               (حماية من CSRF ومن هجمات DNS Rebinding).
 * ============================================================================
 */

import type * as http from 'node:http';
import type { VaultSession } from './session-manager.ts';

/** الحد الأقصى لحجم جسم الطلب (1 ميجابايت) */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
/** اسم كوكي جلسة الخزنة */
export const SESSION_COOKIE_NAME = 'sb_session';

/**
 * Hint بالعربي: سياسة أمان المحتوى (CSP) الافتراضية لأي صفحة HTML: لا سكربتات ولا أنماط مضمّنة،
 *               ولا تحميل أو إرسال لأي موقع خارجي.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  // الصوت العربي المولّد محلياً يُشغَّل من blob: (لا مصادر خارجية)
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Hint بالعربي: خطأ HTTP يحمل رمز الحالة المناسب (400، 401، 403، 413، 429...).
 */
export class HttpError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Hint بالعربي: سياق الطلب الذي يصل لكل معالج مسار (الطلب، الرد، البيانات، والجلسة المفتوحة إن وُجدت).
 */
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  session: VaultSession | null;
  params: string[];
}

/**
 * Hint بالعربي: تعريف مسار API: الطريقة، المسار، هل يتطلب خزنة مفتوحة، وهل هو للقائد فقط.
 */
export interface RouteDefinition {
  method: 'GET' | 'POST';
  path: string | RegExp;
  requiresSession?: boolean;
  commanderOnly?: boolean;
  handler: (ctx: RouteContext) => Promise<void> | void;
}

/**
 * Hint بالعربي: دالة إرسال رد JSON مع منع التخزين المؤقت.
 */
export function sendJson(res: http.ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

/**
 * Hint بالعربي: دالة إرسال صفحة HTML مع سياسة أمان المحتوى المحددة.
 */
export function sendHtml(res: http.ServerResponse, status: number, html: string, csp: string = DASHBOARD_CSP): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * Hint بالعربي: دالة إضافة رؤوس الأمان العامة لكل رد.
 */
export function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/**
 * Hint بالعربي: دالة قراءة جسم طلب JSON مع حد أقصى للحجم. ترمي 413 للحجم الكبير و 400 للصيغة الخاطئة.
 */
export function readRequestBodyJson(req: http.IncomingMessage, limitBytes: number = MAX_REQUEST_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        reject(new HttpError(413, 'حجم الطلب أكبر من الحد المسموح.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'جسم الطلب يجب أن يكون كائن JSON.'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'صيغة JSON غير صحيحة.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Hint بالعربي: دالة قراءة الكوكيز من رأس الطلب إلى كائن (اسم -> قيمة).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

/**
 * Hint بالعربي: دالة بناء كوكي الجلسة (HttpOnly + SameSite=Strict) أو مسحه عند القفل.
 */
export function buildSessionCookie(token: string | null): string {
  if (!token) return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Hint بالعربي: دالة التحقق من أن رأس Host هو عنوان البرنامج المحلي نفسه (يمنع هجمات DNS Rebinding).
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return allowed.has(hostHeader.toLowerCase());
}

/**
 * Hint بالعربي: دالة التحقق من أن طلب الكتابة (POST) قادم من صفحة البرنامج نفسها وليس من موقع آخر (CSRF).
 *               إذا لم يرسل العميل رأس Origin (مثل أدوات سطر الأوامر) نعتمد على Sec-Fetch-Site.
 */
export function isSameOriginRequest(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
    return allowed.has(origin.toLowerCase());
  }
  const fetchSite = req.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}

/**
 * Hint بالعربي: دالة قراءة نص من جسم الطلب بأمان مع حد أقصى للطول وإزالة المسافات الزائدة.
 */
export function readString(body: Record<string, unknown>, key: string, maxLength: number = 4000): string {
  const value = body[key];
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (text.length > maxLength) throw new HttpError(400, `الحقل (${key}) أطول من المسموح.`);
  return text;
}
