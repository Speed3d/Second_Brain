/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/auth-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات الدخول بالبصمة والوجه — 3.2.0: القياس فقط)
 * Hint بالعربي: حفظ وسرد تقارير قياس دعم Passkeys و PRF على هذا الجهاز (للقائد فقط).
 *               التقرير لا يحمل أي سر؛ والقياس نفسه يجري في المتصفح.
 * ============================================================================
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { loadSystemConfig } from '../../../core/config-manager.ts';
import { listProbeReports, normalizeProbeReport, saveProbeReport } from '../../auth/passkey-probe.ts';
import { readDeviceInfo } from '../../sync/sync-context.ts';
import { HttpError, sendJson, type RouteDefinition } from '../http-utils.ts';

function deviceName(): string {
  try {
    return readDeviceInfo(path.join(loadSystemConfig().paths.rootDir, 'Second-Brain-System', 'data'))?.deviceName ?? os.hostname();
  } catch {
    return os.hostname();
  }
}

/**
 * Hint بالعربي: دالة إرجاع مسارات قياس Passkeys.
 */
export function getAuthRoutes(): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/passkeys/probe/report',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res, body }) => {
        let report;
        try {
          report = normalizeProbeReport(body, deviceName());
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        saveProbeReport(report);
        sendJson(res, 200, { ok: true, report });
      },
    },
    {
      method: 'GET',
      path: '/api/passkeys/probe/reports',
      requiresSession: true,
      commanderOnly: true,
      handler: ({ res }) => {
        sendJson(res, 200, { reports: listProbeReports() });
      },
    },
  ];
}
