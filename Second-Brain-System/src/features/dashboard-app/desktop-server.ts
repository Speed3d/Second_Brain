/**
 * ============================================================================
 * الملف: src/features/dashboard-app/desktop-server.ts
 * القسم: Features -> Dashboard App (خادم تطبيق سطح المكتب المحلي)
 * Hint بالعربي: موجّه صغير يستقبل الطلبات على 127.0.0.1 فقط (لا يصل إليه أي جهاز آخر على الشبكة)،
 *               ويطبّق طبقات الحماية بالترتيب: رؤوس الأمان ← التحقق من Host ← التحقق من مصدر
 *               طلبات الكتابة (CSRF) ← الجلسة المفتوحة ← صلاحية القائد ← معالج المسار.
 *               المعالجات نفسها موزعة على ملفات routes/ حسب الميزة.
 * ============================================================================
 */

import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadSystemConfig, loadSystemConfigWithWarnings } from '../../core/config-manager.ts';
import { startProjectWatcher } from '../project-indexer/project-watcher.ts';
import { warmUpVoice } from '../voice/tts-service.ts';
import { syncTick } from '../sync/sync-service.ts';
import { installConsoleRedaction, logSystemError, logSystemInfo, rotateLogIfLarge } from '../../core/logger.ts';
import { getRuntimeVersionStatus, requestServerRestart } from '../../core/runtime-version.ts';
import {
  applySecurityHeaders,
  HttpError,
  isAllowedHost,
  isSameOriginRequest,
  parseCookies,
  readRequestBodyJson,
  sendJson,
  SESSION_COOKIE_NAME,
  type RouteDefinition,
} from './http-utils.ts';
import { getAssistantRoutes } from './routes/assistant-routes.ts';
import { getEmergencyRoutes } from './routes/emergency-routes.ts';
import { getMemoryRoutes } from './routes/memory-routes.ts';
import { getProjectRoutes } from './routes/project-routes.ts';
import { getMaintenanceRoutes } from './routes/maintenance-routes.ts';
import { getConversationRoutes } from './routes/conversation-routes.ts';
import { getVoiceRoutes } from './routes/voice-routes.ts';
import { getSyncRoutes } from './routes/sync-routes.ts';
import { getVaultRoutes } from './routes/vault-routes.ts';
import { getPortalRoutes } from './routes/portal-routes.ts';
import { getAuthRoutes } from './routes/auth-routes.ts';
import { getMcpRoutes } from './routes/mcp-routes.ts';
import { getStateRoutes } from './routes/state-routes.ts';
import { getVaultSession, peekActiveVault } from './session-manager.ts';

/** العنوان الوحيد الذي يستمع عليه الخادم */
export const SERVER_HOST = '127.0.0.1';

/**
 * Hint بالعربي: دالة بناء جدول المسارات الكامل (الصفحة الرئيسية + فحص الحالة + مسارات الميزات).
 */
export function buildRouteTable(): RouteDefinition[] {
  return [
    ...getStateRoutes(),
    {
      method: 'GET',
      path: '/api/health',
      handler: ({ res }) => {
        const config = loadSystemConfig();
        // ISS-032: version هو إصدار الكود الذي يعمل فعلاً، لا ما على القرص
        const v = getRuntimeVersionStatus();
        sendJson(res, 200, { status: 'ok', appName: config.appName, version: v.runningVersion, diskVersion: v.diskVersion, restartRequired: v.restartRequired, startedAt: v.startedAt });
      },
    },
    {
      // ISS-032: إعادة تشغيل الخادم من الواجهة بعد تحديث البرنامج (يعيده المشغّل بالكود الجديد)
      method: 'POST',
      path: '/api/system/restart',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        const v = getRuntimeVersionStatus();
        logSystemInfo('DesktopServer', `إعادة تشغيل الخادم بطلب القائد (يعمل ${v.runningVersion}، وعلى القرص ${v.diskVersion}).`);
        sendJson(res, 200, { ok: true, messageAr: '🔄 يُعاد تشغيل الخادم الآن. افتح الخزنة من جديد بعد ثوانٍ.', ...v });
        requestServerRestart();
      },
    },
    ...getVaultRoutes(),
    ...getProjectRoutes(),
    ...getMemoryRoutes(),
    ...getAssistantRoutes(),
    ...getEmergencyRoutes(),
    ...getPortalRoutes(),
    ...getAuthRoutes(),
    ...getMcpRoutes(),
    ...getMaintenanceRoutes(),
    ...getConversationRoutes(),
    ...getVoiceRoutes(),
    ...getSyncRoutes(),
  ];
}

/**
 * Hint بالعربي: دالة البحث عن المسار المطابق للطلب. المخرجات: المسار ومعاملاته، أو null.
 */
export function matchRoute(
  routes: RouteDefinition[],
  method: string,
  pathname: string
): { route: RouteDefinition; params: string[] } | { methodNotAllowed: true } | null {
  let pathMatched = false;
  for (const route of routes) {
    let params: string[] | null = null;
    if (typeof route.path === 'string') {
      if (route.path === pathname) params = [];
    } else {
      const m = pathname.match(route.path);
      if (m) params = m.slice(1);
    }
    if (!params) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

/**
 * Hint بالعربي: دالة إنشاء خادم HTTP لواجهة سطح المكتب مع جميع طبقات الحماية.
 */
export function createSecondBrainDesktopServer(): http.Server {
  const routes = buildRouteTable();
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      const port = (server.address() as AddressInfo | null)?.port ?? 0;
      if (!isAllowedHost(req.headers.host, port)) {
        throw new HttpError(403, 'طلب مرفوض: عنوان غير مسموح.');
      }

      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const matched = matchRoute(routes, method, url.pathname);
      if (!matched) throw new HttpError(404, 'المسار غير موجود');
      if ('methodNotAllowed' in matched) throw new HttpError(405, 'طريقة الطلب غير مسموحة لهذا المسار.');

      if (method !== 'GET') {
        if (!isSameOriginRequest(req, port)) throw new HttpError(403, 'طلب مرفوض: مصدر الطلب ليس واجهة البرنامج.');
        const contentType = String(req.headers['content-type'] ?? '');
        const contentLength = Number(req.headers['content-length'] ?? '0');
        if (contentLength > 0 && !contentType.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'نوع المحتوى يجب أن يكون application/json.');
        }
      }

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
      const session = getVaultSession(token);
      const { route, params } = matched;
      if (route.requiresSession && !session) {
        throw new HttpError(401, 'الخزنة مقفلة. افتح الخزنة أولاً.', { locked: true });
      }
      if (route.commanderOnly && session && session.vault.unlockedBy !== 'commander') {
        throw new HttpError(403, 'هذه العملية متاحة للقائد فقط (بكلمة المرور الرئيسية).');
      }

      const body = method === 'GET' ? {} : await readRequestBodyJson(req);
      await route.handler({ req, res, method, pathname: url.pathname, query: url.searchParams, body, session, params });
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}) });
        return;
      }
      logSystemError('DesktopServer', 'خطأ أثناء معالجة الطلب في خادم سطح المكتب', err);
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'حدث خطأ غير متوقع' });
    }
  });
  return server;
}

/**
 * Hint بالعربي: دالة تشغيل الخادم على 127.0.0.1 والمنفذ المحدد (أو منفذ الإعدادات). المخرجات: الخادم بعد بدء الاستماع.
 */
export function startSecondBrainDesktopServer(port: number = loadSystemConfig().serverPort): Promise<http.Server> {
  const server = createSecondBrainDesktopServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, SERVER_HOST, () => resolve(server));
  });
}

// تشغيل الخادم إذا تم استدعاء الملف مباشرة
if (process.argv[1] && process.argv[1].endsWith('desktop-server.ts')) {
  // 3.7.0: مخرجات الطرفية (server.log) تُنقّى من الأسرار، و server.log يُدوَّر بالنسخ ثم التفريغ (launchd يبقيه مفتوحاً على الماك)
  installConsoleRedaction();
  const { config, warnings } = loadSystemConfigWithWarnings();
  rotateLogIfLarge(path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'logs', 'server.log'), { copyTruncate: true });
  startSecondBrainDesktopServer(config.serverPort)
    .then(() => {
      logSystemInfo('DesktopServer', `تم تشغيل واجهة سطح المكتب على الرابط: http://localhost:${config.serverPort}`);
      console.log(`\n🛡️  ${config.appTitleAr}`);
      console.log(`🚀 الواجهة تعمل الآن على: http://localhost:${config.serverPort} (متاحة لهذا الجهاز فقط)`);
      for (const w of warnings) console.log(`⚠️  ${w}`);
      const watcher = startProjectWatcher(peekActiveVault);
      if (watcher.intervalMinutes) console.log(`👁️  المراقب الدوري يعمل كل ${watcher.intervalMinutes} دقيقة.`);
      // تحميل الصوت العربي عالي الجودة (XTTS) في الخلفية، فيكون جاهزاً لأول رد
      warmUpVoice();
      // المزامنة متعددة الكتابة (2.0): نشر ودمج التغييرات كل دقيقتين
      syncTick(peekActiveVault());
      setInterval(() => syncTick(peekActiveVault()), 2 * 60 * 1000).unref();
      console.log('');
    })
    .catch((err) => {
      console.error(`❌ تعذر تشغيل الخادم على المنفذ ${config.serverPort}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
