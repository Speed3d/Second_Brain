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
import { loadSystemConfig, registerWatchedProject } from '../../../core/config-manager.ts';
import { countSecuredFiles, syncProjectToObsidianVault } from '../../project-indexer/obsidian-sync.ts';
import { scanAndAnalyzeProject } from '../../project-indexer/project-scanner.ts';
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
        syncProjectToObsidianVault(project, report);
        const secured = countSecuredFiles(report);
        sendJson(res, 200, {
          ok: true,
          messageAr: `✅ تم فحص مشروع (${name}) وتوثيقه في Obsidian. ملفات حساسة: ${report.criticalFilesFound.length}، مؤمَّن منها: ${secured}${
            session ? '' : ' (افتح الخزنة ثم أعد الفحص لتأمين الباقي)'
          }.`,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/rescan',
      handler: ({ res, session }) => {
        const config = loadSystemConfig();
        const summary = config.watchedProjects.map((p) => {
          const report = scanAndAnalyzeProject(p, session?.vault);
          syncProjectToObsidianVault(p, report);
          return { name: p.name, critical: report.criticalFilesFound.length, secured: countSecuredFiles(report) };
        });
        sendJson(res, 200, { ok: true, vaultUnlocked: Boolean(session), projects: summary });
      },
    },
  ];
}
