/**
 * ============================================================================
 * الملف: src/shared/arabic-count.ts
 * القسم: Shared (الدوال المساعدة المشتركة)
 * Hint بالعربي: كتابة العدد مع المعدود بصيغة عربية سليمة (3.9.0):
 *               1 ← «سجل واحد»، و 2 ← «سجلان»، و 3–10 ← «3 سجلات»، و 11–99 ← «11 سجلاً»،
 *               و 100 و 200… و 0 ← «100 سجل». وما فوق المئة يتبع آخر رقمين (103 سجلات، و 111 سجلاً).
 *               بدلها كانت الرسائل تكتب «3 مشروعاً» و «1 سجلاً».
 * ============================================================================
 */

/** صيغ المعدود */
export interface ArabicCountForms {
  /** «سجل واحد» */
  one: string;
  /** «سجلان» */
  two: string;
  /** الجمع بعد 3–10: «سجلات» */
  few: string;
  /** التمييز المنصوب بعد 11–99: «سجلاً» */
  many: string;
  /** المفرد المجرور بعد المئة والألف والصفر: «سجل» */
  single: string;
}

/** صيغ جاهزة للمعدودات الشائعة */
export const AR_COUNT = {
  secret: { one: 'سرّ واحد', two: 'سرّان', few: 'أسرار', many: 'سرّاً', single: 'سرّ' },
  record: { one: 'سجل واحد', two: 'سجلان', few: 'سجلات', many: 'سجلاً', single: 'سجل' },
  project: { one: 'مشروع واحد', two: 'مشروعان', few: 'مشاريع', many: 'مشروعاً', single: 'مشروع' },
  file: { one: 'ملف واحد', two: 'ملفان', few: 'ملفات', many: 'ملفاً', single: 'ملف' },
  name: { one: 'اسم واحد', two: 'اسمان', few: 'أسماء', many: 'اسماً', single: 'اسم' },
  entry: { one: 'مدخل واحد', two: 'مدخلان', few: 'مدخلات', many: 'مدخلاً', single: 'مدخل' },
  // 4.0.1: المعرفة
  node: { one: 'عقدة واحدة', two: 'عقدتان', few: 'عُقد', many: 'عقدة', single: 'عقدة' },
  edge: { one: 'علاقة واحدة', two: 'علاقتان', few: 'علاقات', many: 'علاقة', single: 'علاقة' },
  proposal: { one: 'اقتراح واحد', two: 'اقتراحان', few: 'اقتراحات', many: 'اقتراحاً', single: 'اقتراح' },
  conversation: { one: 'محادثة واحدة', two: 'محادثتان', few: 'محادثات', many: 'محادثة', single: 'محادثة' },
  note: { one: 'ملاحظة واحدة', two: 'ملاحظتان', few: 'ملاحظات', many: 'ملاحظة', single: 'ملاحظة' },
  // 4.1.0
  decision: { one: 'قرار واحد', two: 'قراران', few: 'قرارات', many: 'قراراً', single: 'قرار' },
} satisfies Record<string, ArabicCountForms>;

/**
 * Hint بالعربي: العدد مع معدوده بصيغة سليمة، مثل countAr(3, AR_COUNT.project) ← «3 مشاريع».
 */
export function countAr(n: number, forms: ArabicCountForms): string {
  const count = Math.max(0, Math.trunc(n));
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  const lastTwo = count % 100;
  if (count < 100 || lastTwo >= 3) {
    if (lastTwo >= 3 && lastTwo <= 10) return `${count} ${forms.few}`;
    if (lastTwo >= 11) return `${count} ${forms.many}`;
  }
  return `${count} ${forms.single}`;
}
