# Second Brain — تعليمات Claude Code

> يُقرأ هذا الملف تلقائياً في بداية كل جلسة. **اقرأ أولاً [`docs/17-NEW-SESSION-HANDOFF.md`](docs/17-NEW-SESSION-HANDOFF.md)**: الحالة الآن، وطريقة العمل، وما تبقّى بالضبط.

## القواعد الأساسية (التفاصيل في docs/17 القسم 4)
- **رد على القائد بالعربية دائماً.** الاسم: **Second Brain / العقل الثاني** فقط.
- **كل تغيير:** إصدار جديد في `Second-Brain-System/package.json` (بـ sed أو Edit، لا PowerShell Set-Content)، وقسم في `CHANGELOG.md`، وتحديث الوثائق (`docs/00` و `03` و `12` و `13` و `README.md` و `docs/17`)، واختبارات دائمة في `Second-Brain-System/tests/`، وتشغيلها كلها: `node tests/run-all-tests.ts`.
- **الإيداع والرفع فقط عند طلب القائد**، ولكل إصدار مرفوع وسم `vX.Y.Z`.
- **المستودع عام:** الكود والوثائق فقط. لا `data/`، ولا الإعدادات الحقيقية، ولا محتوى Obsidian الشخصي. افحص `git status --short` قبل `git add`، وأي ملف شخصي جديد يُستبعد في `.gitignore` في التغيير نفسه.
- **لا تُودِع أبداً** `Obsidian-Vault/.obsidian/graph.json` و `Obsidian-Vault/a.md` (ملفا القائد)، ولا تقرأ `a.md` ولا تحذفه.
- **القائد يكتب كلمات المرور ويشغّل أوامر النظام والصلاحيات بنفسه.**
- **الاختبارات والتجارب لا تلمس البيانات الحقيقية أبداً** (بيئة معزولة)، وما ليس اختباراً دائماً يُحذف بعد الانتهاء.
- **كل خلل يُوثَّق** في `docs/13-ISSUES-AND-SOLUTIONS-REFERENCE.md`: السبب، والتجربة، والإصلاح، واختبار الانحدار، والدرس.
- **القوانين التسعة الملزمة:** [`CONSTITUTION-AND-RULES.md`](CONSTITUTION-AND-RULES.md).
