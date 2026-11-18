/**
 * ============================================================================
 * الملف: src/shared/qr-code.ts
 * القسم: Shared (مولّد باركود QR مكتوب يدوياً بلا حزم، 3.4.0 — المرحلة 2.3 من docs/12)
 * Hint بالعربي: يولّد رمز QR حسب ISO/IEC 18004 في حدود ما نحتاجه:
 *               - الوضع الثنائي (Byte، أي نص UTF-8)، وتصحيح الخطأ M (يتحمّل تلف ~15%)، والإصدارات 1–10
 *                 (حتى 213 بايتاً: يكفي مفتاح الطوارئ، ورابط otpauth للمصادقة الثنائية، ورمز الاقتران).
 *               - Reed-Solomon على GF(256) بكثير الحدود 0x11D، وتوزيع الكتل وتشابكها.
 *               - الأنماط الثابتة (المحدِّدات، والتوقيت، والمحاذاة، والوحدة الداكنة)، ومعلومات الصيغة والإصدار (BCH).
 *               - الأقنعة الثمانية واختيار الأقل جزاءً.
 *               المخرجات: مصفوفة وحدات (true = داكنة)، ورسم SVG جاهز للطباعة أو العرض.
 *               الإحداثيات (x = العمود، y = الصف).
 * ============================================================================
 */

/** جدول الإصدارات 1–10 لمستوى M: [مجموع الكلمات، كلمات التصحيح لكل كتلة، عدد الكتل] */
const VERSION_M: ReadonlyArray<readonly [number, number, number]> = [
  [26, 10, 1],
  [44, 16, 1],
  [70, 26, 1],
  [100, 18, 2],
  [134, 24, 2],
  [172, 16, 4],
  [196, 18, 4],
  [242, 22, 4],
  [292, 22, 5],
  [346, 26, 5],
];

/** مواضع مراكز أنماط المحاذاة لكل إصدار */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** بتات «البقية» بعد البيانات */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** الحد الأقصى للنص بالبايت (الإصدار 10، المستوى M) */
export const QR_MAX_BYTES = 213;

// ===================== GF(256) و Reed-Solomon =====================

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/**
 * Hint بالعربي: كثير الحدود المولّد لـ Reed-Solomon بالدرجة المطلوبة (المعاملات من الأعلى، بلا المعامل الأول 1).
 */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/**
 * Hint بالعربي: دالة حساب كلمات تصحيح الخطأ لكتلة بيانات (باقي القسمة على كثير الحدود المولّد).
 */
export function reedSolomonEc(data: readonly number[], ecLength: number): number[] {
  const gen = rsGenerator(ecLength);
  const rem = new Array<number>(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLength; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// ===================== معلومات الصيغة والإصدار (BCH) =====================

/** بتات مستوى التصحيح في معلومات الصيغة */
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 } as const;

/**
 * Hint بالعربي: معلومات الصيغة (15 بت) لمستوى تصحيح وقناع: 5 بتات بيانات + 10 بتات BCH، مقنّعة بـ 0x5412.
 */
export function formatBits(level: keyof typeof EC_BITS, mask: number): number {
  const data = (EC_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Hint بالعربي: معلومات الإصدار (18 بت، للإصدار 7 فأعلى): 6 بتات الإصدار + 12 بت BCH.
 */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ===================== ترميز البيانات =====================

/**
 * Hint بالعربي: دالة اختيار أصغر إصدار يتسع للنص، وبناء كلمات البيانات (الوضع الثنائي، والطول، والحشو).
 */
export function encodeDataCodewords(bytes: Uint8Array): { version: number; data: number[] } {
  for (let v = 1; v <= 10; v++) {
    const [total, ecPerBlock, blocks] = VERSION_M[v - 1];
    const dataCount = total - ecPerBlock * blocks;
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 > dataCount * 8) continue;
    const bits: number[] = [];
    const push = (value: number, len: number): void => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, countBits);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, dataCount * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data: number[] = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < dataCount; pad ^= 0xec ^ 0x11) data.push(pad);
    return { version: v, data };
  }
  throw new Error(`النص أطول من سعة الباركود (${QR_MAX_BYTES} بايت).`);
}

/**
 * Hint بالعربي: دالة تقسيم البيانات إلى كتل، وحساب التصحيح لكل كتلة، ثم التشابك (البيانات ثم التصحيح).
 */
export function interleaveCodewords(version: number, data: readonly number[]): number[] {
  const [total, ecPerBlock, blocks] = VERSION_M[version - 1];
  const dataCount = total - ecPerBlock * blocks;
  const shortLen = Math.floor(dataCount / blocks);
  const longBlocks = dataCount % blocks;
  const dataBlocks: number[][] = [];
  let k = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b >= blocks - longBlocks ? 1 : 0);
    dataBlocks.push(data.slice(k, k + len));
    k += len;
  }
  const ecBlocks = dataBlocks.map((blk) => reedSolomonEc(blk, ecPerBlock));
  const out: number[] = [];
  for (let i = 0; i <= shortLen; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const blk of ecBlocks) out.push(blk[i]);
  if (out.length !== total) throw new Error('خطأ داخلي في توزيع كتل QR.');
  return out;
}

// ===================== المصفوفة =====================

/** رمز QR جاهز */
export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x] = true للوحدة الداكنة */
  modules: boolean[][];
}

/**
 * Hint بالعربي: هل الوحدة (x, y) داكنة تحت القناع المعطى؟
 */
export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error('قناع غير صالح.');
  }
}

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  // التوقيت
  for (let i = 0; i < n; i++) {
    g.setFn(6, i, i % 2 === 0);
    g.setFn(i, 6, i % 2 === 0);
  }
  // المحدِّدات الثلاثة مع فواصلها
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        g.setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  // المحاذاة
  const pos = ALIGNMENT[version - 1];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // حجز مواضع الصيغة (تُكتب لاحقاً) والوحدة الداكنة
  drawFormat(g, 0);
  // معلومات الإصدار
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.setFn(a, b, dark);
      g.setFn(b, a, dark);
    }
  }
}

/**
 * Hint بالعربي: خريطة الوحدات الثابتة لإصدار (true = ليست بيانات). تُستخدم في القارئ العكسي في الاختبارات.
 */
export function qrFunctionModules(version: number): boolean[][] {
  const g = new Grid(version * 4 + 17);
  drawFunctionPatterns(g, version);
  return g.isFunction;
}

function drawFormat(g: Grid, mask: number): void {
  const n = g.size;
  const bits = formatBits('M', mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.setFn(8, i, bit(i));
  g.setFn(8, 7, bit(6));
  g.setFn(8, 8, bit(7));
  g.setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.setFn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.setFn(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.setFn(8, n - 15 + i, bit(i));
  g.setFn(8, n - 8, true); // الوحدة الداكنة
}

/**
 * Hint بالعربي: ترتيب مواضع بتات البيانات (المتعرّج من أسفل اليمين، عمودان عمودان، مع تخطي عمود التوقيت).
 */
export function dataModuleOrder(isFunction: boolean[][]): Array<[number, number]> {
  const n = isFunction.length;
  const order: Array<[number, number]> = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!isFunction[y][x]) order.push([x, y]);
      }
    }
  }
  return order;
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < n; y++) lines.push(m[y]);
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (let i = s.indexOf('1011101'); i >= 0; i = s.indexOf('1011101', i + 1)) {
      const before = s.slice(Math.max(0, i - 4), i);
      const after = s.slice(i + 7, i + 11);
      if ((i >= 4 && before === '0000') || (i + 11 <= n && after === '0000')) score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  let dark = 0;
  for (const row of m) for (const d of row) if (d) dark++;
  const total = n * n;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/**
 * Hint بالعربي: دالة توليد رمز QR لنص (UTF-8). المخرجات: الإصدار، والحجم، والقناع المختار، والمصفوفة.
 *               fixedMask للاختبارات فقط.
 */
export function generateQr(text: string, options: { fixedMask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const { version, data } = encodeDataCodewords(bytes);
  const codewords = interleaveCodewords(version, data);
  const size = version * 4 + 17;
  const base = new Grid(size);
  drawFunctionPatterns(base, version);
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version - 1]; i++) bits.push(0);
  const order = dataModuleOrder(base.isFunction);
  if (order.length !== bits.length) throw new Error(`خطأ داخلي: ${order.length} موضعاً مقابل ${bits.length} بتاً.`);
  let best: QrCode | null = null;
  let bestScore = Infinity;
  const masks = options.fixedMask !== undefined ? [options.fixedMask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const g = new Grid(size);
    for (let y = 0; y < size; y++) {
      g.modules[y] = [...base.modules[y]];
      g.isFunction[y] = [...base.isFunction[y]];
    }
    order.forEach(([x, y], i) => {
      g.modules[y][x] = (bits[i] === 1) !== maskApplies(mask, x, y);
    });
    drawFormat(g, mask);
    const score = penalty(g.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size, mask, modules: g.modules };
    }
  }
  return best!;
}

/**
 * Hint بالعربي: دالة رسم الرمز SVG (مربعات سوداء على أبيض، مع هامش 4 وحدات كما يشترط المعيار).
 *               لا يحتوي أي سكربت، ويُدرج مباشرة في HTML.
 */
export function qrToSvg(qr: QrCode, options: { moduleSize?: number; margin?: number; title?: string } = {}): string {
  const s = options.moduleSize ?? 6;
  const margin = options.margin ?? 4;
  const dim = (qr.size + margin * 2) * s;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) path += `M${(x + margin) * s} ${(y + margin) * s}h${s}v${s}h-${s}z`;
  }
  const title = options.title ? `<title>${options.title.replace(/[<>&"]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" shape-rendering="crispEdges">${title}<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}
