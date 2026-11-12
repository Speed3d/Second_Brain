/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/project-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات المشاريع)
 * Hint بالعربي: إضافة مشروع جديد للمراقبة بعد التحقق من مساره، وإعادة فحص كل المشاريع
 *               وتحديث وثائقها في Obsidian. إذا كانت الخزنة مفتوحة تُؤمَّن الملفات الحساسة فعلاً.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchedProjectConfig } from '../../../shared/types.ts';
import { registerWatchedProject, unregisterWatchedProject } from '../../../core/config-manager.ts';
import { generateProjectSummary } from '../../assistant/assistant-engine.ts';
import { countSecuredFiles, syncProjectWithChanges } from '../../project-indexer/obsidian-sync.ts';
import { buildProjectSummaryContext, findWatchedProject, getProjectDetails, readProjectConversation } from '../../project-indexer/project-details.ts';
import { openProjectLocation } from '../../project-indexer/project-launcher.ts';
import { scanAndAnalyzeProject } from '../../project-indexer/project-scanner.ts';
import { rescanAllProjects } from '../../project-indexer/project-watcher.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';

/**
 * Hint بالعربي: دالة التحقق من مسار المشروع: موجود، مجلد، وليس جذر قرص كامل (مثل D:\).
 *               المخرجات: المسار المطلق الموحَّد.
 */
export function validateProjectPath(rawPath: string): string {
  if (!rawPath.trim()) throw new HttpError(400, 'يرجى إدخال مسار المشروع.');
  const resolved = path.resolve(rawPath.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new HttpError(400, `المسار غير موجود أو ليس مجلداً: ${resolved}`);
  }
  if (path.parse(resolved).root === resolved || resolved === path.parse(resolved).root.replace(/[\\/]$/, '')) {
    throw new HttpError(400, 'لا يمكن مراقبة قرص كامل؛ اختر مجلد المشروع نفسه.');
  }
  return resolved;
}

/**
 * Hint بالعربي: دالة توليد معرّف آمن للمشروع من اسمه (مع بديل عشوائي للأسماء العربية).
 */
export function buildProjectId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `proj-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Hint بالعربي: دالة إرجاع قائمة مسارات المشاريع.
 */
export function getProjectRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/projects/add',
      commanderOnly: true,
      handler: ({ res, body, session }) => {
        const name = readString(body, 'name', 120).trim();
        if (!name) throw new HttpError(400, 'يرجى إدخال اسم المشروع.');
        const projectPath = validateProjectPath(readString(body, 'path', 500));
        const project: WatchedProjectConfig = {
          id: buildProjectId(name),
          name,
          path: projectPath,
          descriptionAr: readString(body, 'descriptionAr', 2000).trim() || 'مشروع مضاف للمراقبة الذكية',
          wifeSummaryAr: readString(body, 'wifeSummaryAr', 2000).trim() || 'تطبيق برمجي مسجل في النظام',
          monthlyIncome: readString(body, 'monthlyIncome', 300).trim() || 'غير محدد بعد',
          billingNotes: readString(body, 'billingNotes', 2000).trim() || 'راجع تفاصيل الاستضافة في الخزنة',
        };
        registerWatchedProject(project);
        const report = scanAndAnalyzeProject(project, session?.vault);
        syncProjectWithChanges(project, report);
        const secured = countSecuredFiles(report);
        const tracked = report.criticalFilesTrackedByGit ?? [];
        sendJson(res, 200, {
          ok: true,
          messageAr: `✅ تم فحص مشروع (${name}) وتوثيقه في Obsidian. ملفات حساسة: ${report.criticalFilesFound.length}، مؤمَّن منها: ${secured}${
            session ? '' : ' (افتح الخزنة ثم أعد الفحص لتأمين الباقي)'
          }.${tracked.length ? `\n⚠️ ملفات حساسة مرفوعة على Git: ${tracked.join('، ')}` : ''}`,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/rescan',
      handler: ({ res, session }) => {
        sendJson(res, 200, { ok: true, vaultUnlocked: Boolean(session), projects: rescanAllProjects(session?.vault) });
      },
    },
    {
      method: 'GET',
      path: PROJECT_ID_PATH,
      handler: ({ res, params }) => sendJson(res, 200, getProjectDetails(requireProject(params[0]))),
    },
    {
      method: 'GET',
      path: /^\/api\/projects\/([a-z0-9_-]{1,80})\/conversations\/([^/]{1,200})$/,
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, params }) => {
        const content = readProjectConversation(requireProject(params[0]), decodeURIComponent(params[1]));
        if (content === null) throw new HttpError(404, 'المحادثة غير موجودة.');
        sendJson(res, 200, { content });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/projects\/([a-z0-9_-]{1,80})\/summary$/,
      commanderOnly: true,
      handler: async ({ res, params, session }) => {
        const project = requireProject(params[0]);
        const result = await generateProjectSummary(project.name, buildProjectSummaryContext(project), session?.vault);
        registerWatchedProject({ ...project, summaryAr: result.summaryAr });
        sendJson(res, 200, { ok: true, ...result });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/projects\/([a-z0-9_-]{1,80})\/update$/,
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, params, body }) => {
        const project = requireProject(params[0]);
        const updated: WatchedProjectConfig = {
          ...project,
          descriptionAr: readString(body, 'descriptionAr', 2000).trim(),
          wifeSummaryAr: readString(body, 'wifeSummaryAr', 2000).trim(),
          monthlyIncome: readString(body, 'monthlyIncome', 300).trim() || 'غير محدد بعد',
          billingNotes: readString(body, 'billingNotes', 2000).trim(),
          summaryAr: readString(body, 'summaryAr', 8000).trim() || undefined,
        };
        registerWatchedProject(updated);
        syncProjectWithChanges(updated, scanAndAnalyzeProject(updated));
        sendJson(res, 200, { ok: true, messageAr: '✅ حُفظت معلومات المشروع وحُدّثت وثائقه في Obsidian.' });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/projects\/([a-z0-9_-]{1,80})\/remove$/,
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, params }) => {
        const project = requireProject(params[0]);
        unregisterWatchedProject(project.id);
        sendJson(res, 200, { ok: true, messageAr: `أُوقفت مراقبة (${project.name}). وثائقه في Obsidian باقية كما هي.` });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/projects\/([a-z0-9_-]{1,80})\/open$/,
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, params, body }) => {
        const project = requireProject(params[0]);
        const target = body.target === 'vscode' ? 'vscode' : 'folder';
        openProjectLocation(project.path, target);
        sendJson(res, 200, { ok: true });
      },
    },
  ];
}

/** نمط مسار تفاصيل مشروع (المعرّف: حروف إنجليزية صغيرة وأرقام و - و _) */
const PROJECT_ID_PATH = /^\/api\/projects\/([a-z0-9_-]{1,80})$/;

/**
 * Hint بالعربي: دالة جلب مشروع مسجّل بمعرّفه أو رمي خطأ 404.
 */
export function requireProject(projectId: string): WatchedProjectConfig {
  const project = findWatchedProject(projectId);
  if (!project) throw new HttpError(404, 'المشروع غير موجود.');
  return project;
}
