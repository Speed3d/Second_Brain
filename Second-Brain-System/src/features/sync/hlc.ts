/**
 * ============================================================================
 * الملف: src/features/sync/hlc.ts
 * القسم: Features -> Sync (العدّاد الذكي: Hybrid Logical Clock)
 * Hint بالعربي: يرتّب التغييرات بين الأجهزة دون الاعتماد على ساعة الجهاز وحدها:
 *               كل ختم = (وقت الجهاز، عدّاد، معرّف الجهاز). إن تأخرت ساعة جهاز أو تقدّمت،
 *               يبقى الترتيب صحيحاً لأن كل جهاز يأخذ أكبر وقت رآه من الأجهزة الأخرى ثم يزيد العدّاد.
 *               النص الناتج قابل للترتيب الأبجدي مباشرة (الأصفار البادئة).
 * ============================================================================
 */

/** ختم زمني ذكي */
export interface HlcStamp {
  wallMs: number;
  counter: number;
  deviceId: string;
}

/** حالة الساعة المحلية المحفوظة في فهرس المزامنة */
export interface HlcState {
  wallMs: number;
  counter: number;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 6;

/**
 * Hint بالعربي: دالة إنشاء ختم جديد لتغيير محلي. تُحدّث الحالة في مكانها وتُرجع الختم.
 */
export function hlcTick(state: HlcState, deviceId: string, now: number = Date.now()): HlcStamp {
  if (now > state.wallMs) {
    state.wallMs = now;
    state.counter = 0;
  } else {
    state.counter += 1;
  }
  return { wallMs: state.wallMs, counter: state.counter, deviceId };
}

/**
 * Hint بالعربي: دالة تحديث الساعة المحلية عند استقبال ختم من جهاز آخر (حتى تبقى أختامنا التالية أحدث منه).
 */
export function hlcReceive(state: HlcState, remote: HlcStamp, now: number = Date.now()): void {
  const wall = Math.max(state.wallMs, remote.wallMs, now);
  if (wall === state.wallMs && wall === remote.wallMs) state.counter = Math.max(state.counter, remote.counter) + 1;
  else if (wall === state.wallMs) state.counter += 1;
  else if (wall === remote.wallMs) state.counter = remote.counter + 1;
  else state.counter = 0;
  state.wallMs = wall;
}

/**
 * Hint بالعربي: دالة تحويل الختم إلى نص قابل للترتيب: 000001763300000000-000003-<الجهاز>.
 */
export function hlcToString(stamp: HlcStamp): string {
  return `${String(stamp.wallMs).padStart(WALL_DIGITS, '0')}-${String(stamp.counter).padStart(COUNTER_DIGITS, '0')}-${stamp.deviceId}`;
}

/**
 * Hint بالعربي: دالة قراءة الختم من نصه. ترمي إن كانت الصيغة غير صحيحة.
 */
export function hlcParse(text: string): HlcStamp {
  const m = /^(\d{15})-(\d{6})-(.+)$/.exec(text);
  if (!m) throw new Error(`ختم زمني غير صالح: ${text}`);
  return { wallMs: Number(m[1]), counter: Number(m[2]), deviceId: m[3] };
}

/**
 * Hint بالعربي: دالة مقارنة ختمين نصيين: سالب إن كان الأول أقدم، موجب إن كان أحدث، صفر إن تساويا.
 */
export function hlcCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
