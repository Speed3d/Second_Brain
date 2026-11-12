/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/state-routes.ts
 * القسم: Features -> Dashboard App -> Routes (الصفحة، الملفات الثابتة، حالة الواجهة، والإعدادات)
 * Hint بالعربي: - يخدم صفحة الواجهة وملفاتها الثابتة (قائمة بيضاء فقط) من مجلد public/.
 *               - /api/state: بيانات العرض (الهوية، المشاريع، الذاكرة) بصيغة JSON تُعرض في المتصفح عبر textContent.
 *               - /api/settings: قراءة وتعديل الإعدادات المسموح بتعديلها فقط (لا المسارات)، مع تحقق صارم.
 *                 بعد إنشاء الخزنة يتطلب التعديل جلسة القائد.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AIProviderId } from '../../../shared/types.ts';
import { loadSystemConfig, updateBrandingIdentity, updateSystemSettings, readRawSettings } from '../../../core/config-manager.ts';
import { querySharedAIMemory } from '../../ai-memory/shared-memory-service.ts';
import { countSecuredFiles } from '../../project-indexer/obsidian-sync.ts';
import { scanAndAnalyzeProject } from '../../project-indexer/project-scanner.ts';
import { unlockVault, vaultExists, verifyMasterPassword } from '../../vault/vault-manager.ts';
import { buildSessionCookie, HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';
import {
  getVaultSession,
  grantSettingsAuth,
  hasSettingsAuth,
  openVaultSession,
  recordUnlockFailure,
  recordUnlockSuccess,
  SETTINGS_AUTH_MS,
  type VaultSession,
} from '../session-manager.ts';
import { assertUnlockAllowed } from './vault-routes.ts';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** الملفات الثابتة المسموح بخدمتها فقط (لا يمكن طلب أي ملف آخر) */
export const STATIC_ASSETS: Record<string, string> = {
  'styles.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'hologram.js': 'text/javascript; charset=utf-8',
};

/**
 * Hint بالعربي: سياسة أمان المحتوى الصارمة للواجهة: لا سكربتات ولا أنماط مضمّنة، ولا اتصال بأي موقع خارجي.
 */
export const STRICT_DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Hint بالعربي: دالة قراءة ملف من مجلد الواجهة الثابتة.
 */
export function readPublicFile(name: string): Buffer {
  return fs.readFileSync(path.join(PUBLIC_DIR, name));
}

/**
 * Hint بالعربي: دالة التحقق من قيمة نصية في الإعدادات: نوعها وطولها ونمطها.
 */
export function validateSettingString(value: unknown, field: string, options: { max?: number; pattern?: RegExp; allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new HttpError(400, `الحقل ${field} يجب أن يكون نصاً.`);
  const v = value.trim();
  if (!v && !options.allowEmpty) throw new HttpError(400, `الحقل ${field} مطلوب.`);
  if (v.length > (options.max ?? 100)) throw new HttpError(400, `الحقل ${field} أطول من المسموح.`);
  if (v && options.pattern && !options.pattern.test(v)) throw new HttpError(400, `قيمة الحقل ${field} غير صالحة.`);
  return v;
}

/**
 * Hint بالعربي: دالة التحقق من رقم صحيح ضمن مدى محدد.
 */
export function validateSettingInt(value: unknown, field: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `الحقل ${field} يجب أن يكون بين ${min} و ${max}.`);
  return n;
}

/**
 * Hint بالعربي: دالة التحقق من عنوان Ollama: يجب أن يكون على هذا الجهاز فقط (حتى لا تُرسل الأسئلة لخادم خارجي بالخطأ).
 */
export function validateLocalEndpoint(value: unknown): string {
  const v = validateSettingString(value, 'ollamaEndpoint', { max: 200 });
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new HttpError(400, 'عنوان Ollama غير صالح.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new HttpError(400, 'عنوان Ollama يجب أن يكون على هذا الجهاز (127.0.0.1 أو localhost).');
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Hint بالعربي: دالة التأكد من صلاحية الإعدادات: قبل إنشاء الخزنة مسموح (أول تشغيل)،
 *               وبعدها تُطلب كلمة المرور الرئيسية حديثاً (خلال 5 دقائق) — مفتاح الطوارئ لا يكفي.
 */
export function assertSettingsAuth(session: VaultSession | null): void {
  if (!vaultExists()) return;
  if (!hasSettingsAuth(session)) {
    throw new HttpError(401, 'أدخل كلمة المرور الرئيسية لفتح الإعدادات.', { needsSettingsAuth: true });
  }
}

/**
 * Hint بالعربي: دالة بناء الإعدادات القابلة للتعديل من الواجهة (بدون المسارات والمشاريع).
 */
export function buildEditableSettings(): Record<string, unknown> {
  const c = loadSystemConfig();
  return {
    identity: {
      appName: c.appName,
      appTitleAr: c.appTitleAr,
      assistantName: c.assistantName,
      assistantNameAr: c.assistantNameAr,
      commanderName: c.commanderName,
      familyMemberTitle: c.familyMemberTitle,
    },
    ai: {
      defaultMode: c.aiConfig.defaultMode,
      cloudProvider: c.aiConfig.cloudProvider,
      providerOrder: c.aiConfig.providerOrder ?? null,
      claudeModel: c.aiConfig.claudeModel,
      claudeEffort: c.aiConfig.claudeEffort,
      geminiModel: c.aiConfig.geminiModel,
      ollamaEndpoint: c.aiConfig.ollamaEndpoint,
      ollamaModel: c.aiConfig.ollamaModel,
      voiceEnabled: c.aiConfig.voiceEnabled,
      voiceLang: c.aiConfig.voiceLang,
    },
    connectors: { antigravity: c.connectors?.antigravity?.enabled !== false, claudeCode: c.connectors?.claudeCode?.enabled !== false },
    watcher: c.watcher,
    security: { autoLockMinutes: c.security?.autoLockMinutes ?? 10, backupRetention: c.security?.backupRetention ?? 10, extraBackupDir: c.security?.extraBackupDir ?? '' },
    readOnly: { serverPort: c.serverPort, paths: c.paths },
  };
}

/**
 * Hint بالعربي: دالة إرجاع مسارات الصفحة والملفات الثابتة والحالة والإعدادات.
 */
export function getStateRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/',
      handler: ({ res }) => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': STRICT_DASHBOARD_CSP,
          'Cache-Control': 'no-store',
        });
        res.end(readPublicFile('index.html'));
      },
    },
    {
      method: 'GET',
      path: /^\/assets\/([a-z-]+\.(?:css|js))$/,
      handler: ({ res, params }) => {
        const type = STATIC_ASSETS[params[0]];
        if (!type) throw new HttpError(404, 'الملف غير موجود');
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(readPublicFile(params[0]));
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      handler: ({ res }) => {
        const config = loadSystemConfig();
        const projects = config.watchedProjects.map((p) => {
          const r = scanAndAnalyzeProject(p);
          return {
            id: p.id,
            name: p.name,
            path: p.path,
            descriptionAr: p.descriptionAr,
            wifeSummaryAr: p.wifeSummaryAr,
            monthlyIncome: p.monthlyIncome,
            billingNotes: p.billingNotes,
            stack: r.detectedStack,
            runCommand: r.runCommands[0] ?? null,
            criticalFiles: r.criticalFilesFound.map((c) => ({ path: c.relativePath, reasonAr: c.reasonAr })),
            securedCount: countSecuredFiles(r),
            gitBranch: r.gitBranch ?? null,
            lastCommitMessage: r.lastCommitMessage ?? null,
            lastCommitDate: r.lastCommitDate ?? null,
            uncommittedChanges: r.uncommittedChanges ?? null,
            trackedByGit: r.criticalFilesTrackedByGit ?? [],
          };
        });
        const memories = querySharedAIMemory()
          .slice(0, 50)
          .map((m) => ({ id: m.id, sourceAI: m.sourceAI, projectId: m.projectId, title: m.title, summaryAr: m.summaryAr, createdAt: m.createdAt }));
        sendJson(res, 200, {
          app: {
            appName: config.appName,
            appTitleAr: config.appTitleAr,
            assistantNameAr: config.assistantNameAr,
            commanderName: config.commanderName,
            familyMemberTitle: config.familyMemberTitle,
            version: config.version,
            voiceEnabled: config.aiConfig.voiceEnabled,
            voiceLang: config.aiConfig.voiceLang,
          },
          projects,
          memories,
          memoryCount: querySharedAIMemory().length,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/settings/auth',
      handler: ({ res, body, session }) => {
        // يقبل كلمة المرور الرئيسية فقط؛ وإن كانت الخزنة مقفلة تُفتح بها أيضاً حتى لا تُطلب مرتين
        if (!vaultExists()) {
          sendJson(res, 200, { ok: true, settingsAuthSeconds: null });
          return;
        }
        assertUnlockAllowed();
        const password = readString(body, 'password', 512);
        if (!password || !verifyMasterPassword(password)) {
          recordUnlockFailure();
          throw new HttpError(401, 'كلمة المرور الرئيسية غير صحيحة.');
        }
        recordUnlockSuccess();
        let active = session;
        const headers: Record<string, string> = {};
        if (!active || active.vault.unlockedBy !== 'commander') {
          const token = openVaultSession(unlockVault(password));
          headers['Set-Cookie'] = buildSessionCookie(token);
          active = getVaultSession(token);
        }
        grantSettingsAuth(active!);
        sendJson(res, 200, { ok: true, settingsAuthSeconds: SETTINGS_AUTH_MS / 1000 }, headers);
      },
    },
    {
      method: 'POST',
      path: '/api/settings/lock',
      handler: ({ res, session }) => {
        // عند مغادرة قسم الإعدادات تُلغى الصلاحية فوراً
        if (session) session.settingsAuthUntil = 0;
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/settings',
      handler: ({ res, session }) => {
        assertSettingsAuth(session);
        sendJson(res, 200, buildEditableSettings());
      },
    },
    {
      method: 'POST',
      path: '/api/settings',
      handler: ({ res, body, session }) => {
        assertSettingsAuth(session);
        const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
        const identity = obj(body.identity);
        const ai = obj(body.ai);
        const connectors = obj(body.connectors);
        const watcher = obj(body.watcher);
        const security = obj(body.security);
        const modelPattern = /^[A-Za-z0-9._:\/-]{1,100}$/;

        const providerOrder = ai.providerOrder === null || ai.providerOrder === undefined
          ? undefined
          : Array.isArray(ai.providerOrder)
            ? ai.providerOrder.map((p) => {
                if (!['claude', 'gemini', 'ollama', 'local'].includes(String(p))) throw new HttpError(400, `مزوّد غير معروف: ${String(p)}`);
                return p as AIProviderId;
              })
            : (() => { throw new HttpError(400, 'providerOrder يجب أن يكون قائمة.'); })();

        const extraBackupDir = validateSettingString(security.extraBackupDir ?? '', 'extraBackupDir', { max: 500, allowEmpty: true });
        if (extraBackupDir && !path.isAbsolute(extraBackupDir)) throw new HttpError(400, 'مجلد النسخ الإضافي يجب أن يكون مساراً كاملاً (مثل E:\\Backups).');

        updateBrandingIdentity({
          appName: validateSettingString(identity.appName, 'appName'),
          appTitleAr: validateSettingString(identity.appTitleAr, 'appTitleAr', { max: 150 }),
          assistantName: validateSettingString(identity.assistantName, 'assistantName'),
          assistantNameAr: validateSettingString(identity.assistantNameAr, 'assistantNameAr'),
          commanderName: validateSettingString(identity.commanderName, 'commanderName'),
          familyMemberTitle: validateSettingString(identity.familyMemberTitle, 'familyMemberTitle'),
        });

        const raw = readRawSettings();
        const currentAi = obj(raw.aiConfig);
        const newAi: Record<string, unknown> = {
          ...currentAi,
          defaultMode: ['hybrid', 'cloud', 'local'].includes(String(ai.defaultMode)) ? ai.defaultMode : 'hybrid',
          cloudProvider: ai.cloudProvider === 'gemini' ? 'gemini' : 'claude',
          claudeModel: validateSettingString(ai.claudeModel, 'claudeModel', { pattern: modelPattern }),
          claudeEffort: ['low', 'medium', 'high'].includes(String(ai.claudeEffort)) ? ai.claudeEffort : 'medium',
          geminiModel: validateSettingString(ai.geminiModel, 'geminiModel', { pattern: modelPattern }),
          ollamaEndpoint: validateLocalEndpoint(ai.ollamaEndpoint),
          ollamaModel: validateSettingString(ai.ollamaModel, 'ollamaModel', { pattern: modelPattern }),
          voiceEnabled: ai.voiceEnabled === true,
          voiceLang: validateSettingString(ai.voiceLang, 'voiceLang', { max: 10, pattern: /^[a-z]{2,3}(-[A-Z]{2})?$/ }),
        };
        if (providerOrder) newAi.providerOrder = providerOrder;
        else delete newAi.providerOrder;

        updateSystemSettings({
          aiConfig: newAi,
          connectors: { antigravity: { enabled: connectors.antigravity === true }, claudeCode: { enabled: connectors.claudeCode === true } },
          watcher: {
            enabled: watcher.enabled === true,
            intervalMinutes: validateSettingInt(watcher.intervalMinutes, 'intervalMinutes', 1, 1440),
            harvestTranscripts: watcher.harvestTranscripts === true,
          },
          security: {
            autoLockMinutes: validateSettingInt(security.autoLockMinutes, 'autoLockMinutes', 1, 120),
            backupRetention: validateSettingInt(security.backupRetention, 'backupRetention', 1, 100),
            ...(extraBackupDir ? { extraBackupDir } : {}),
          },
        });
        sendJson(res, 200, { ok: true, settings: buildEditableSettings(), messageAr: '✅ حُفظت الإعدادات. تغيير فترة المراقب يُطبَّق بعد إعادة تشغيل البرنامج.' });
      },
    },
  ];
}
