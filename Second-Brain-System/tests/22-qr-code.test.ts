/**
 * ============================================================================
 * الملف: tests/22-qr-code.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات مولّد باركود QR اليدوي (الإصدار 3.4.0، المرحلة 2.3 من docs/12):
 *               - متجهات معروفة من المعيار: كلمات تصحيح «HELLO WORLD» (1-M)، ومعلومات الصيغة للمستويات الأربعة،
 *                 ومعلومات الإصدار 7.
 *               - السعة الرسمية للوضع الثنائي بالمستوى M للإصدارات 1–10 (14، 26، 42… 213 بايتاً).
 *               - قارئ عكسي مستقل: يقرأ الصيغة من النسختين، ويزيل القناع، ويعيد الكتل، ويتحقق من تصحيح كل كتلة،
 *                 ويستخرج النص (عربي وإنجليزي، وكل الأقنعة الثمانية، وكل الإصدارات).
 *               - الأنماط الثابتة: المحدِّدات الثلاثة، والتوقيت، والوحدة الداكنة.
 *               - الكتيب: الباركود فيه هو باركود المفتاح نفسه، بلا سكربت.
 *               التحقق النهائي في العالم الحقيقي: مسح القائد بكاميرا الهاتف (docs/12، 2.3).
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { normalizeEmergencyKey } from '../src/core/crypto-engine.ts';
import { generatePrintableEmergencyKit } from '../src/features/family-emergency/emergency-kit-service.ts';
import {
  dataModuleOrder,
  formatBits,
  generateQr,
  maskApplies,
  qrFunctionModules,
  qrToSvg,
  QR_MAX_BYTES,
  reedSolomonEc,
  versionBits,
  type QrCode,
} from '../src/shared/qr-code.ts';
import { ensureTestVault } from './test-environment.ts';

/** جدول المعيار (ISO 18004، الجدول 9) للمستوى M — نسخة مستقلة عن المولّد: [مجموع، تصحيح/كتلة، كتل] */
const SPEC_M: Array<[number, number, number]> = [
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
/** السعة الرسمية بالبايت (الوضع الثنائي، M) */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/**
 * Hint بالعربي: قارئ عكسي: من المصفوفة إلى النص، مع التحقق من الصيغة والتصحيح.
 */
function decodeQr(qr: QrCode): { text: string; mask: number } {
  const n = qr.size;
  const version = (n - 17) / 4;
  const m = qr.modules;
  const at = (x: number, y: number): number => (m[y][x] ? 1 : 0);
  // الصيغة: النسخة الأولى
  let f1 = 0;
  for (let i = 0; i <= 5; i++) f1 |= at(8, i) << i;
  f1 |= at(8, 7) << 6;
  f1 |= at(8, 8) << 7;
  f1 |= at(7, 8) << 8;
  for (let i = 9; i < 15; i++) f1 |= at(14 - i, 8) << i;
  // النسخة الثانية
  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= at(n - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= at(8, n - 15 + i) << i;
  assert.equal(f1, f2, 'نسختا معلومات الصيغة متطابقتان');
  const fmt = f1 ^ 0x5412;
  assert.equal(fmt >> 13, 0, 'مستوى التصحيح M');
  const mask = (fmt >> 10) & 7;
  assert.equal(formatBits('M', mask), f1, 'بتات BCH للصيغة صحيحة');
  assert.equal(at(8, n - 8), 1, 'الوحدة الداكنة');
  if (version >= 7) {
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < 18; i++) {
      v1 |= at(n - 11 + (i % 3), Math.floor(i / 3)) << i;
      v2 |= at(Math.floor(i / 3), n - 11 + (i % 3)) << i;
    }
    assert.equal(v1, versionBits(version));
    assert.equal(v2, versionBits(version));
  }
  // البيانات
  const order = dataModuleOrder(qrFunctionModules(version));
  const [total, ecPer, blocks] = SPEC_M[version - 1];
  const bits = order.map(([x, y]) => (m[y][x] !== maskApplies(mask, x, y) ? 1 : 0));
  const cw: number[] = [];
  for (let i = 0; i < total; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    cw.push(b);
  }
  const dataCount = total - ecPer * blocks;
  const shortLen = Math.floor(dataCount / blocks);
  const longs = dataCount % blocks;
  const lens = Array.from({ length: blocks }, (_, b) => shortLen + (b >= blocks - longs ? 1 : 0));
  const dataBlocks: number[][] = lens.map(() => []);
  let k = 0;
  for (let i = 0; i <= shortLen; i++) for (let b = 0; b < blocks; b++) if (i < lens[b]) dataBlocks[b].push(cw[k++]);
  const ecBlocks: number[][] = lens.map(() => []);
  for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) ecBlocks[b].push(cw[k++]);
  dataBlocks.forEach((blk, b) => assert.deepEqual(reedSolomonEc(blk, ecPer), ecBlocks[b], `تصحيح الكتلة ${b + 1} سليم`));
  const data = dataBlocks.flat();
  const dbits = data.flatMap((b) => Array.from({ length: 8 }, (_, j) => (b >> (7 - j)) & 1));
  let p = 0;
  const read = (len: number): number => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | dbits[p++];
    return v;
  };
  assert.equal(read(4), 0b0100, 'الوضع الثنائي');
  const count = read(version <= 9 ? 8 : 16);
  const bytes = Uint8Array.from({ length: count }, () => read(8));
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), mask };
}

function checkFinders(qr: QrCode): void {
  const n = qr.size;
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ]) {
    for (let d = -3; d <= 3; d++) {
      assert.equal(qr.modules[cy - 3][cx + d], true, 'حافة المحدِّد');
      assert.equal(qr.modules[cy + 3][cx + d], true);
    }
    assert.equal(qr.modules[cy - 2][cx], false, 'الحلقة البيضاء');
    assert.equal(qr.modules[cy][cx], true, 'المركز');
  }
  for (let i = 8; i < n - 8; i++) {
    assert.equal(qr.modules[6][i], i % 2 === 0, 'التوقيت الأفقي');
    assert.equal(qr.modules[i][6], i % 2 === 0, 'التوقيت العمودي');
  }
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات مولّد QR وإرجاع نتائج الفحص.
 */
export async function runQrCodeTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // ===================== 1. متجهات المعيار =====================
  assert.deepEqual(reedSolomonEc([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23], 'تصحيح «HELLO WORLD» 1-M');
  assert.equal(formatBits('L', 0), 0b111011111000100);
  assert.equal(formatBits('M', 0), 0b101010000010010);
  assert.equal(formatBits('Q', 0), 0b011010101011111);
  assert.equal(formatBits('H', 0), 0b001011010001001);
  assert.equal(formatBits('M', 5), 0b100000011001110, 'M مع القناع 5');
  assert.equal(versionBits(7), 0b000111110010010100, 'معلومات الإصدار 7');
  assert.equal(versionBits(10), 0b001010010011010011, 'معلومات الإصدار 10');
  passedChecks.push('اختبار متجهات المعيار (تصحيح Reed-Solomon لـ «HELLO WORLD» 1-M، ومعلومات الصيغة للمستويات الأربعة، ومعلومات الإصدارين 7 و 10) بنجاح.');

  // ===================== 2. السعة الرسمية =====================
  BYTE_CAPACITY_M.forEach((cap, i) => {
    assert.equal(generateQr('x'.repeat(cap)).version, i + 1, `${cap} بايتاً تتسع في الإصدار ${i + 1}`);
    if (i < 9) assert.equal(generateQr('x'.repeat(cap + 1)).version, i + 2, `${cap + 1} بايتاً تحتاج الإصدار ${i + 2}`);
  });
  assert.equal(QR_MAX_BYTES, 213);
  assert.throws(() => generateQr('x'.repeat(214)), /أطول من سعة/);
  passedChecks.push('اختبار السعة الرسمية للوضع الثنائي بالمستوى M (14 حتى 213 بايتاً للإصدارات 1–10، والنص الأطول مرفوض) بنجاح.');

  // ===================== 3. القارئ العكسي =====================
  const samples = [
    'A',
    'SB-702F-0356-5B53-E7B7-E355-D74B-1E0D-4A81-9F47',
    'otpauth://totp/Second%20Brain:commander?secret=JBSWY3DPEHPK3PXP&issuer=Second%20Brain&algorithm=SHA1&digits=6&period=30',
    'العقل الثاني — مفتاح الطوارئ للعائلة 👪',
    ...BYTE_CAPACITY_M.map((c, i) => String.fromCharCode(65 + i).repeat(c)),
  ];
  let decodedCount = 0;
  for (const text of samples) {
    const qr = generateQr(text);
    checkFinders(qr);
    assert.equal(decodeQr(qr).text, text);
    decodedCount++;
  }
  for (let mask = 0; mask < 8; mask++) {
    const qr = generateQr('SB-702F-0356-5B53-E7B7-E355-D74B-1E0D-4A81-9F47', { fixedMask: mask });
    const r = decodeQr(qr);
    assert.equal(r.mask, mask);
    assert.equal(r.text, 'SB-702F-0356-5B53-E7B7-E355-D74B-1E0D-4A81-9F47');
  }
  passedChecks.push(`اختبار القارئ العكسي (${decodedCount} نصاً بالعربية والإنجليزية وكل الإصدارات 1–10، والأقنعة الثمانية: الصيغة بنسختيها، والوحدة الداكنة، ومعلومات الإصدار، وتصحيح كل كتلة، والمحدِّدات والتوقيت) بنجاح.`);

  // ===================== 4. SVG والكتيب =====================
  const qr = generateQr('SB-TEST');
  const svg = qrToSvg(qr, { moduleSize: 4, title: 'x<script>' });
  assert.ok(svg.startsWith('<svg') && !/<script/i.test(svg) && svg.includes('<title>xscript</title>'), 'SVG بلا سكربت، والعنوان منظَّف من < و >');
  assert.match(svg, new RegExp(`viewBox="0 0 ${(qr.size + 8) * 4} ${(qr.size + 8) * 4}"`), 'هامش 4 وحدات');
  const { emergencyKey } = ensureTestVault();
  const kit = generatePrintableEmergencyKit(emergencyKey);
  const keyQr = qrToSvg(generateQr(normalizeEmergencyKey(emergencyKey)), { moduleSize: 6, title: 'باركود مفتاح الطوارئ' });
  assert.ok(kit.includes('<svg') && kit.includes('باركود مفتاح الطوارئ'), 'الكتيب فيه الباركود');
  assert.ok(kit.includes(keyQr), 'وهو باركود المفتاح نفسه');
  passedChecks.push('اختبار الرسم والكتيب (SVG بهامش المعيار وبلا سكربت، والكتيب يحمل باركود مفتاح الطوارئ نفسه) بنجاح.');

  return passedChecks;
}
