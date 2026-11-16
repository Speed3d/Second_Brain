/**
 * ============================================================================
 * الملف: src/features/sync/code-ownership.ts
 * القسم: Features -> Sync (من يكتب وثائق المشروع المولّدة؟)
 * Hint بالعربي: المراقب يولّد وثائق كل مشروع في Obsidian (01–06). مع الكتابة من كل الأجهزة، لو ولّدها جهازان
 *               لنفس المشروع لاختلفت قليلاً (وقت الفحص مثلاً) فتظهر تعارضات وهمية كل 15 دقيقة.
 *               القرار (docs/11): يكتبها فقط الجهاز الذي فيه آخر تغيير في كود المشروع.
 *               «آخر تغيير» = الأحدث بين تاريخ آخر commit ووقت تعديل مجلد المشروع. كل جهاز ينشر علامته
 *               في ملف حالته على مجلد المزامنة (projectCodeChanges)، والباقي يستقبل الوثائق بالمزامنة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFileSafe, writeFileAtomic } from '../../shared/file-helpers.ts';
import type { ProjectScanReport, WatchedProjectConfig } from '../../shared/types.ts';
import { buildSyncContext } from './sync-context.ts';

/**
 * Hint بالعربي: دالة حساب علامة آخر تغيير في كود المشروع على هذا الجهاز (بالمللي ثانية، 0 إن لم تُعرف).
 */
export function computeCodeChangeMarker(project: WatchedProjectConfig, report: Pick<ProjectScanReport, 'lastCommitDate'>): number {
  const commit = report.lastCommitDate ? Date.parse(report.lastCommitDate) : 0;
  let dirMtime = 0;
  try {
    dirMtime = fs.statSync(project.path).mtimeMs;
  } catch {
    dirMtime = 0;
  }
  return Math.max(Number.isFinite(commit) ? commit : 0, dirMtime);
}

/**
 * Hint بالعربي: دالة حفظ علامة المشروع محلياً (data/sync/code-markers.json)، فتُنشر مع ملف حالة الجهاز.
 */
export function saveCodeChangeMarker(dataDir: string, projectId: string, markerMs: number): void {
  if (!markerMs) return;
  const file = path.join(dataDir, 'sync', 'code-markers.json');
  const markers = readJsonFileSafe<Record<string, string>>(file, {});
  const iso = new Date(markerMs).toISOString();
  if (markers[projectId] === iso) return;
  markers[projectId] = iso;
  writeFileAtomic(file, JSON.stringify(markers, null, 2));
}

/**
 * Hint بالعربي: دالة القرار: هل يكتب هذا الجهاز الوثائق المولّدة لهذا المشروع؟
 *               نعم إن كانت المزامنة مطفأة، أو لم يُبلّغ أي جهاز آخر عن تغيير أحدث في كود المشروع.
 *               syncRoot و myDeviceId للاختبارات فقط.
 */
export function isGeneratedDocsOwner(projectId: string, myMarkerMs: number, opts: { syncRoot?: string; myDeviceId?: string } = {}): boolean {
  let syncRoot = opts.syncRoot;
  let myDeviceId = opts.myDeviceId;
  if (!syncRoot) {
    const ctx = buildSyncContext();
    if (!ctx) return true;
    syncRoot = ctx.syncRoot;
    myDeviceId = ctx.device.deviceId;
  }
  const dir = path.join(syncRoot, 'devices');
  if (!fs.existsSync(dir)) return true;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const d = readJsonFileSafe<{ deviceId?: string; projectCodeChanges?: Record<string, string> } | null>(path.join(dir, name), null);
    if (!d || d.deviceId === myDeviceId) continue;
    const theirs = d.projectCodeChanges?.[projectId] ? Date.parse(d.projectCodeChanges[projectId]) : 0;
    if (Number.isFinite(theirs) && theirs > myMarkerMs) return false;
  }
  return true;
}
