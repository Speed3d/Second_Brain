/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/sync-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المزامنة بين الأجهزة — المرحلة ج)
 * Hint بالعربي: حالة المزامنة، وتفعيلها وتحديد مجلدها (بصلاحية الإعدادات)، و«زامن الآن»،
 *               والتعارضات وحسمها، والسلة والاسترجاع منها (2.0: الكتابة من كل الأجهزة)، وتحديد مكان مشروع على هذا الجهاز.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRawSettings, setDeviceProjectPath, updateSystemSettings } from '../../../core/config-manager.ts';
import { getSyncStatus, listHeldDeletes, listSyncConflicts, listSyncTrash, resolveSyncConflict, resolveSyncHeldDeletes, restoreSyncTrash, syncNow } from '../../sync/sync-service.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';
import { requireProject } from './project-routes.ts';
import { assertSettingsAuth } from './state-routes.ts';

const PROJECT_LOCATE_PATH = /^\/api\/projects\/([a-z0-9_-]{1,80})\/locate$/;

/** اسم المجلد المعتمد داخل My Drive لكل ما يخص Second Brain (المزامنة والنسخ الإضافية) */
export const DRIVE_APP_FOLDER = 'Second Brain';

/**
 * أسماء مجلد My Drive حسب لغة Google Drive for desktop:
 * الإنجليزية «My Drive»، والعربية على الماك «ملفاتي» (جُرّب على MacBook في 2026-11-15)، و«ملفاتي في Drive» في واجهات أخرى.
 */
export const DRIVE_ROOT_NAMES = ['My Drive', 'ملفاتي', 'ملفاتي في Drive'] as const;

/**
 * Hint بالعربي: دالة اقتراح مجلدات Google Drive الموجودة على هذا الجهاز (لتسهيل الإعداد).
 *               المجلد المعتمد «My Drive/Second Brain» يأتي أولاً إن وُجد، ثم My Drive نفسه.
 */
export function detectDriveFolders(opts: { platform?: NodeJS.Platform; homeDir?: string } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const roots: string[] = [];
  if (platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const name of DRIVE_ROOT_NAMES) {
        const p = `${letter}:\\${name}`;
        if (fs.existsSync(p)) roots.push(p);
      }
    }
  } else if (platform === 'darwin') {
    const cloud = path.join(opts.homeDir ?? os.homedir(), 'Library', 'CloudStorage');
    try {
      for (const d of fs.readdirSync(cloud)) {
        if (!d.startsWith('GoogleDrive-')) continue;
        for (const name of DRIVE_ROOT_NAMES) {
          const p = path.join(cloud, d, name);
          if (fs.existsSync(p)) roots.push(p);
        }
      }
    } catch {
      // لا يوجد Google Drive
    }
  }
  const preferred = roots.map((r) => path.join(r, DRIVE_APP_FOLDER)).filter((p) => fs.existsSync(p));
  return [...preferred, ...roots];
}

function failAs400(fn: () => { messageAr: string }): { messageAr: string } {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Hint بالعربي: دالة إرجاع مسارات المزامنة.
 */
export function getSyncRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/sync/status',
      handler: ({ res }) => sendJson(res, 200, { ...getSyncStatus(), suggestedFolders: detectDriveFolders() }),
    },
    {
      method: 'POST',
      path: '/api/sync/settings',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        assertSettingsAuth(session);
        const enabled = body.enabled === true;
        const folder = readString(body, 'folder', 500).trim();
        if (enabled) {
          if (!folder || !path.isAbsolute(folder)) throw new HttpError(400, 'مجلد المزامنة يجب أن يكون مساراً كاملاً (مثل G:\\My Drive).');
          if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new HttpError(400, 'المجلد غير موجود. ثبّت Google Drive for desktop وسجّل الدخول، ثم أعد المحاولة.');
        }
        const current = (readRawSettings().sync ?? {}) as Record<string, unknown>;
        updateSystemSettings({ sync: { ...current, enabled, folder: folder || current.folder || '' } });
        sendJson(res, 200, { ok: true, status: getSyncStatus(), messageAr: enabled ? '🔄 فُعّلت المزامنة على هذا الجهاز.' : 'أُطفئت المزامنة على هذا الجهاز.' });
      },
    },
    {
      method: 'POST',
      path: '/api/sync/now',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => {
        const result = failAs400(() => syncNow(session!.vault));
        sendJson(res, 200, { ok: true, ...result, status: getSyncStatus() });
      },
    },
    {
      method: 'GET',
      path: '/api/sync/conflicts',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => sendJson(res, 200, { conflicts: listSyncConflicts(session!.vault) }),
    },
    {
      method: 'POST',
      path: '/api/sync/conflicts/resolve',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const id = readString(body, 'id', 80);
        const choice = body.choice === 'other' ? 'other' : body.choice === 'keep' ? 'keep' : null;
        if (!id || !choice) throw new HttpError(400, 'حدد التعارض والقرار (keep أو other).');
        const result = failAs400(() => resolveSyncConflict(session!.vault, id, choice));
        sendJson(res, 200, { ok: true, ...result, status: getSyncStatus() });
      },
    },
    {
      method: 'GET',
      path: '/api/sync/held',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => sendJson(res, 200, listHeldDeletes(session!.vault)),
    },
    {
      method: 'POST',
      path: '/api/sync/held/resolve',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const direction = body.direction === 'incoming' ? 'incoming' : body.direction === 'outgoing' ? 'outgoing' : null;
        const action = body.action === 'confirm' ? 'confirm' : body.action === 'reject' ? 'reject' : null;
        if (!direction || !action) throw new HttpError(400, 'حدد الاتجاه (outgoing أو incoming) والقرار (confirm أو reject).');
        const result = failAs400(() => resolveSyncHeldDeletes(session!.vault, direction, action));
        sendJson(res, 200, { ok: true, ...result, status: getSyncStatus() });
      },
    },
    {
      method: 'GET',
      path: '/api/sync/trash',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, session }) => sendJson(res, 200, { items: listSyncTrash(session!.vault) }),
    },
    {
      method: 'POST',
      path: '/api/sync/trash/restore',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const id = readString(body, 'id', 80);
        if (!id) throw new HttpError(400, 'حدد العنصر.');
        const result = failAs400(() => restoreSyncTrash(session!.vault, id));
        sendJson(res, 200, { ok: true, ...result, status: getSyncStatus() });
      },
    },
    {
      // مكان المشروع على هذا الجهاز فقط (ملف محلي غير مُزامَن)
      method: 'POST',
      path: PROJECT_LOCATE_PATH,
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, params, body }) => {
        const project = requireProject(params[0]);
        const target = readString(body, 'path', 500).trim();
        if (target) {
          if (!path.isAbsolute(target)) throw new HttpError(400, 'المسار يجب أن يكون كاملاً.');
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new HttpError(400, 'المجلد غير موجود على هذا الجهاز.');
        }
        setDeviceProjectPath(project.id, target || null);
        sendJson(res, 200, { ok: true, messageAr: target ? `📍 حُدّد مكان «${project.name}» على هذا الجهاز.` : 'أُزيل التحديد المحلي، وعاد المسار المشترك.' });
      },
    },
  ];
}
