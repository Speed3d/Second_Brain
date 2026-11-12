# 🌳 الهيكلية الشجرية المتفرعة للمشروع (Strict Modular Architecture Tree)

> **تطبيقاً للقانونين (2) و (3):** هذه الوثيقة تحدد الشجرة المتفرعة الصارمة للمشروع في `D:\Second Brain` وتمنع خلط أي ملفات أو أقسام مع بعضها.

---

## 1. شجرة المجلدات الشاملة

```text
📁 D:\Second Brain\
│
├── 📄 00-Master-Implementation-Plan.md         # الخطة الهندسية الشاملة المثبتة (القانون 1)
├── 📄 CONSTITUTION-AND-RULES.md                # الدستور والقوانين الثمانية الصارمة
│
├── 📁 docs\                                    # التوثيق الهندسي المستمر المرتبط بالخطط
│   ├── 📄 01-ARCHITECTURE-TREE.md              # هذه الوثيقة: شجرة المجلدات وتقسيم الطبقات
│   ├── 📄 02-EXECUTION-ROADMAP.md              # خطة العمل التنفيذية خطوة بخطوة (القانون 4)
│   ├── 📄 03-PROGRESS-AND-ISSUES-LOG.md        # سجل الإنجازات، المشاكل، الحلول، والمتبقي (القانون 5)
│   ├── 📄 04-CODE-AND-FUNCTIONS-INDEX.md       # الفهرس الحي لكل دالة وأداة ومكان استخدامها (القانون 7)
│   ├── 📄 05-TESTS-ARCHIVE-REPORT.md           # أرشيف الاختبارات الدائمة ونتائج الفحص (القانون 8)
│   └── 📄 06-FIXES-AND-IMPROVEMENTS-PLAN.md    # خطة الإصلاحات والتحسينات المعتمدة وحالة كل بند
│
├── 📁 Obsidian-Vault\                          # العقل الثاني (يُفتح مباشرة ببرنامج Obsidian)
│   ├── 📁 .obsidian\                           # إعدادات Obsidian والثيم المخصص (second-brain-hud.css)
│   ├── 📁 00-Command-Center\                   # لوحة القيادة، خريطة المشاريع Canvas، وفهرس النظام
│   ├── 📁 01-Commander-Profile\                # هويتك الشخصية وقواعدك البرمجية للـ AI
│   ├── 📁 02-Projects\                         # مجلدات المشاريع (تُدار وتُحدث تلقائياً)
│   ├── 📁 03-AI-Shared-Memory\                 # الذاكرة المشتركة وسجلات محادثات Antigravity & Claude
│   └── 📁 04-Family-Emergency-Guide\           # بوابة ودليل الطوارئ المبسط لزوجتك بالعربية
│
└── 📁 Second-Brain-System\                           # النظام البرمجي الفعلي (المحرك + الخزنة + الواجهة + الاختبارات)
    ├── 📄 package.json                         # تعريف الحزم وأوامر التشغيل والاختبار
    ├── 📄 tsconfig.json                        # إعدادات TypeScript الصارمة
    ├── 📁 config\                              # الإعدادات المركزية القابلة للتعديل في أي وقت
    │   ├── 📄 branding.json                    # الهوية فقط (اسم البرنامج والمساعد) — لا يُرفع
    │   ├── 📄 settings.json                    # المسارات، الذكاء، الموصلات، المراقب، المشاريع — لا يُرفع
    │   └── 📄 *.example.json                   # نماذج مرفوعة على GitHub
    │   (المرحلة 2 أضافت: features/assistant/providers/ ، features/ai-memory/connectors/ ،
    │    project-indexer/git-inspector.ts و project-watcher.ts ، shared/secret-redaction.ts ، tests/07-integration.test.ts)
    ├── 📁 data\                                # البيانات المشفرة والنسخ الاحتياطية
    │   ├── 📁 encrypted-vault\                 # ملفات الخزنة المشفرة بـ AES-256-GCM
    │   ├── 📁 emergency-kits\                  # كتيبات الطوارئ المولدة لزوجتك
    │   └── 📁 encrypted-backups\               # النسخ الاحتياطية المشفرة الجاهزة للسحابة/USB
    │
    ├── 📁 src\                                 # الكود المصدري مقسم حسب القانون (3)
    │   ├── 📁 core\                            # [1. CORE] النواة التأسيسية للنظام
    │   │   ├── 📄 config-manager.ts            # إدارة الإعدادات والهوية المتغيرة (Branding)
    │   │   ├── 📄 crypto-engine.ts             # محرك التشفير العسكري AES-256-GCM + Scrypt
    │   │   └── 📄 logger.ts                    # مسجل العمليات والأخطاء المربوط بالتوثيق
    │   │
    │   ├── 📁 features\                        # [2. FEATURES] الميزات المستقلة (كل ميزة بمجلد خاص)
    │   │   ├── 📁 vault\                       # خزنة الإيميلات، الباسووردات، 2FA، والملفات السرية
    │   │   │   └── 📄 vault-manager.ts
    │   │   ├── 📁 project-indexer\             # تشريح المشاريع، صيد الملفات الحرجة، والتحديث التلقائي
    │   │   │   ├── 📄 project-scanner.ts
    │   │   │   ├── 📄 secret-file-hunter.ts
    │   │   │   └── 📄 obsidian-sync.ts
    │   │   ├── 📁 ai-memory\                   # الذاكرة المشتركة وسحب محادثات Antigravity & Claude
    │   │   │   ├── 📄 shared-memory-service.ts
    │   │   │   └── 📄 transcript-harvester.ts
    │   │   ├── 📁 assistant\                   # عقل المساعد الذكي (Gemini/Claude + Ollama + صوت)
    │   │   │   └── 📄 assistant-engine.ts
    │   │   ├── 📁 family-emergency\            # وضع الطوارئ لزوجتك + كتيب الطوارئ + النسخ المشفر
    │   │   │   ├── 📄 emergency-kit-service.ts
    │   │   │   └── 📄 backup-service.ts
    │   │   └── 📁 dashboard-app\               # تطبيق وواجهة سطح المكتب (HUD + Wife Mode)
    │   │       ├── 📄 desktop-server.ts        # موجّه صغير على 127.0.0.1 فقط + طبقات الحماية
    │   │       ├── 📄 http-utils.ts            # الرد، حد حجم الطلب، الكوكيز، فحص Host و CSRF، رؤوس الأمان
    │   │       ├── 📄 session-manager.ts       # جلسة الخزنة في الذاكرة + القفل التلقائي + تأخير المحاولات
    │   │       ├── 📁 routes\                  # معالجات المسارات حسب الميزة
    │   │       │   ├── 📄 vault-routes.ts      # إنشاء/فتح/قفل الخزنة وإدارة الأسرار وكلمة المرور ومفتاح الطوارئ
    │   │       │   ├── 📄 project-routes.ts    # إضافة مشروع وإعادة الفحص
    │   │       │   ├── 📄 memory-routes.ts     # سحب المحادثات
    │   │       │   ├── 📄 assistant-routes.ts  # المساعد الذكي
    │   │       │   └── 📄 emergency-routes.ts  # كتيب الطوارئ والنسخ الاحتياطي والاستعادة
    │   │       ├── 📄 ui-renderer.ts           # بناء الصفحة (كل القيم تمر عبر escapeHtml)
    │   │       ├── 📄 vault-client-script.ts   # سكربت الخزنة والطوارئ في المتصفح (textContent فقط)
    │   │       ├── 📄 hud-styles.ts
    │   │       └── 📄 hologram-core-script.ts
    │   │
    │   ├── 📁 shared\                          # [3. SHARED] الأنواع والدوال المشتركة
    │   │   ├── 📄 types.ts                     # جميع تعريفات الأنواع والواجهات البرمجية
    │   │   ├── 📄 file-helpers.ts              # دوال الملفات الآمنة + الكتابة الذرّية مع النسخ السابقة
    │   │   └── 📄 html-helpers.ts              # escapeHtml للحماية من حقن الأكواد (XSS)
    │   │
    │   └── 📁 tools\                           # [4. TOOLS] الأدوات المستقلة والخوادم المساعدة
    │       ├── 📄 mcp-memory-server.ts         # خادم MCP لربط Antigravity و Claude Code بالذاكرة
    │       └── 📄 code-registry-scanner.ts     # أداة فحص الأكواد وتحديث فهرس الدوال تلقائياً
    │
    └── 📁 tests\                               # [5. TESTS] الاختبارات الدائمة الموثقة (لا تحذف أبداً)
        ├── 📄 run-all-tests.ts                 # المشغل الشامل لجميع الاختبارات وتوليد التقارير
        ├── 📄 test-environment.ts              # بيئة اختبار معزولة في مجلد مؤقت (لا تلمس البيانات الحقيقية)
        ├── 📄 01-core-and-vault.test.ts        # اختبار النواة، التشفير، والخزنة السرية
        ├── 📄 02-project-indexer.test.ts       # اختبار تشريح المشاريع وصيد الملفات السرية وتحديث Obsidian
        ├── 📄 03-ai-shared-memory.test.ts      # اختبار الذاكرة المشتركة وسحب سجلات Antigravity و Claude
        ├── 📄 04-family-emergency.test.ts      # اختبار بوابة زوجتك، كتيب الطوارئ، والنسخ الاحتياطي المشفر
        ├── 📄 05-tools-and-dashboard.test.ts   # اختبار فهرس الأكواد، خادم MCP، وواجهة سطح المكتب
        └── 📄 06-security.test.ts              # اختبارات الأمان: الخزنة v2، الجلسات، CSRF، XSS، النسخ والاستعادة
```

---

## 2. قواعد الفصل بين الأقسام (Zero-Mixing Rules)

1. **`src/core/`** لا يستورد أي شيء من `src/features/`، بل يعتمد فقط على `src/shared/`.
2. **`src/features/`** كل مجلد ميزة بداخله مسؤول عن وظيفة واحدة فقط، ويتواصل مع النواة عبر `src/core/` ومع الأنواع عبر `src/shared/`.
3. **`src/tools/`** أدوات تشغيلية وفحصية مستقلة يمكن استدعاؤها من سطر الأوامر أو من داخل النظام.
4. **`tests/`** يختبر جميع الطبقات دون أن يلوث كود الإنتاج، وتبقى جميع ملفاته محفوظة وموثقة داخل المشروع بشكل دائم. منذ `2026-11-11` تعمل كل الاختبارات داخل بيئة مؤقتة معزولة (`test-environment.ts`) عبر متغير البيئة `SECOND_BRAIN_CONFIG_PATH`، فلا تلمس الخزنة أو Obsidian أو سجلات المحادثات الحقيقية.
