/**
 * ============================================================================
 * الملف: install/device-identity.ts
 * القسم: Install (هوية الجهاز — مشترك بين مثبّتَي Windows و macOS)
 * Hint بالعربي: يقرر ما يُفعل بملف data/device.json عند التثبيت:
 *               - غير موجود ← تُكتب هوية جديدة لهذا الجهاز.
 *               - موجود ولنفس نظام التشغيل ← يبقى كما هو.
 *               - موجود لنظام آخر (منقول من جهاز آخر) أو تالف ← يُنقل إلى نسخة احتياطية
 *                 device.<النظام>.json.bak ثم تُكتب هوية جديدة. لا يُحذف أي شيء.
 *   node install/device-identity.ts --file <path> --platform macos|windows --name "<اسم>" [--preview]
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DevicePlatform = 'windows' | 'macos' | 'linux';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  platform: string;
  createdAt: string;
}

export type DeviceIdentityPlan =
  | { kind: 'create' }
  | { kind: 'keep'; current: DeviceIdentity }
  | { kind: 'replace'; reason: 'other-platform' | 'invalid'; current?: DeviceIdentity; backupFile: string };

/**
 * Hint بالعربي: يقرأ الملف الحالي (إن وُجد) ويعيد null إن كان تالفاً أو ناقص الحقول.
 */
function readIdentity(file: string): DeviceIdentity | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<DeviceIdentity>;
    if (typeof data.deviceId === 'string' && data.deviceId && typeof data.platform === 'string' && data.platform) {
      return data as DeviceIdentity;
    }
  } catch {
    // ملف تالف: يُعامل كهوية غير صالحة
  }
  return null;
}

/**
 * Hint بالعربي: اسم النسخة الاحتياطية، دون الكتابة فوق نسخة سابقة بنفس الاسم.
 */
function backupPathFor(file: string, label: string, now: Date): string {
  const base = path.join(path.dirname(file), `device.${label.replace(/[^a-z0-9-]/gi, '_')}.json.bak`);
  if (!fs.existsSync(base)) return base;
  return base.replace(/\.json\.bak$/, `.${now.toISOString().replace(/[:.]/g, '-')}.json.bak`);
}

/**
 * Hint بالعربي: يحدد الإجراء دون تغيير أي شيء (يُستخدم في وضع المعاينة أيضاً).
 */
export function planDeviceIdentity(file: string, platform: DevicePlatform, now: Date = new Date()): DeviceIdentityPlan {
  if (!fs.existsSync(file)) return { kind: 'create' };
  const current = readIdentity(file);
  if (!current) return { kind: 'replace', reason: 'invalid', backupFile: backupPathFor(file, 'invalid', now) };
  if (current.platform === platform) return { kind: 'keep', current };
  return { kind: 'replace', reason: 'other-platform', current, backupFile: backupPathFor(file, current.platform, now) };
}

/**
 * Hint بالعربي: ينفّذ الخطة: ينقل الملف القديم إلى النسخة الاحتياطية (إن لزم) ويكتب الهوية الجديدة بكتابة ذرّية.
 */
export function applyDeviceIdentity(
  file: string,
  platform: DevicePlatform,
  deviceName: string,
  now: Date = new Date(),
): { plan: DeviceIdentityPlan; identity: DeviceIdentity } {
  const plan = planDeviceIdentity(file, platform, now);
  if (plan.kind === 'keep') return { plan, identity: plan.current };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (plan.kind === 'replace') fs.renameSync(file, plan.backupFile);
  const identity: DeviceIdentity = { deviceId: crypto.randomUUID(), deviceName, platform, createdAt: now.toISOString() };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { plan, identity };
}

/**
 * Hint بالعربي: وصف عربي للخطة يطبعه المثبّت.
 */
export function describePlan(plan: DeviceIdentityPlan, deviceName: string, preview: boolean): string {
  const will = preview ? 'سيُكتب' : 'كُتب';
  switch (plan.kind) {
    case 'create':
      return `✔ هوية الجهاز: ${will} ملف جديد باسم «${deviceName}»`;
    case 'keep':
      return `✔ هوية الجهاز موجودة مسبقاً لهذا الجهاز «${plan.current.deviceName}» (لم تتغير)`;
    case 'replace': {
      const why = plan.reason === 'invalid'
        ? 'الملف الحالي تالف'
        : `الملف الحالي لجهاز آخر «${plan.current?.deviceName}» بنظام ${plan.current?.platform}`;
      const moved = preview ? 'سيُنقل' : 'نُقل';
      return `⚠ هوية الجهاز: ${why}؛ ${moved} إلى ${path.basename(plan.backupFile)} و${will} ملف جديد باسم «${deviceName}»`;
    }
  }
}

function main(argv: string[]): number {
  const args = new Map<string, string>();
  let preview = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preview') preview = true;
    else if (a === '--file' || a === '--platform' || a === '--name') args.set(a, argv[++i] ?? '');
    else { console.error(`معامل غير معروف: ${a}`); return 2; }
  }
  const file = args.get('--file');
  const platform = args.get('--platform') as DevicePlatform | undefined;
  const name = args.get('--name');
  if (!file || !name || !platform || !['windows', 'macos', 'linux'].includes(platform)) {
    console.error('الاستخدام: node install/device-identity.ts --file <path> --platform macos|windows|linux --name "<اسم>" [--preview]');
    return 2;
  }
  const plan = preview ? planDeviceIdentity(file, platform) : applyDeviceIdentity(file, platform, name).plan;
  console.log(describePlan(plan, name, preview));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
