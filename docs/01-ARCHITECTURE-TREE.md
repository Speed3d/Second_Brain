# 🌳 الهيكلية الشجرية المتفرعة للمشروع (Strict Modular Architecture Tree)

> **تطبيقاً للقانونين (2) و (3):** هذه الوثيقة تحدد الشجرة الفعلية للمشروع في `D:\Second Brain` وتمنع خلط الملفات أو الأقسام.
> **آخر مراجعة:** `2026-11-12` (بعد المرحلة 4) — مطابقة للملفات المتتبعة في Git.
> 🔒 = ملف/مجلد شخصي **لا يُرفع إلى GitHub** (انظر `.gitignore`).

---

## 1. شجرة المجلدات

```text
📁 D:\Second Brain\
│
├── 📄 README.md                                # البدء السريع: التشغيل، الاختبار، الربط، والأمان
├── 📄 00-Master-Implementation-Plan.md         # الرؤية والخطة الهندسية الشاملة (القانون 1)
├── 📄 CONSTITUTION-AND-RULES.md                # الدستور والقوانين التسعة الملزمة
├── 📄 CHANGELOG.md                             # سجل الإصدارات: ما الجديد في كل إصدار (القانون 9)
├── 📄 Launch-Second-Brain.bat                  # مشغّل يدوي بديل (يعمل من أي قرص، ويفتح المتصفح بعد جاهزية الخادم)
├── 📄 .gitignore                               # ما لا يُرفع أبداً (البيانات، الإعدادات الحقيقية، المحتوى الشخصي، vendor)
├── 📄 .gitattributes                           # نهايات الأسطر: LF لسكربتات الماك، CRLF لسكربتات Windows
│
├── 📁 docs\                                    # التوثيق الهندسي الحي
│   ├── 📄 01-ARCHITECTURE-TREE.md              # هذه الوثيقة
│   ├── 📄 02-EXECUTION-ROADMAP.md              # خارطة الطريق وحالة كل مرحلة (القانون 4)
│   ├── 📄 03-PROGRESS-AND-ISSUES-LOG.md        # ما أُنجز، المشاكل، الحلول، والمتبقي (القانون 5)
│   ├── 📄 04-CODE-AND-FUNCTIONS-INDEX.md       # فهرس الدوال الحي (يُولَّد آلياً — القانون 7)
│   ├── 📄 05-TESTS-ARCHIVE-REPORT.md           # تقرير الاختبارات الدائم (يُولَّد آلياً — القانون 8)
│   ├── 📄 06-FIXES-AND-IMPROVEMENTS-PLAN.md    # خطة الإصلاحات المعتمدة وحالة كل بند
│   ├── 📄 07-EXPANSION-PLAN.md                 # خطة التوسعة (الأجهزة، التثبيت، المزامنة) وحالة كل مرحلة
│   ├── 📄 08-AI-CONNECTION-GUIDE.md            # دليل ربط الذكاء (الاشتراكات، Ollama) والصوت العربي
│   ├── 📄 09-MAC-SETUP-HANDOFF.md              # تسليم جلسة الماك: النقل، المتطلبات، الخطوات، سجل التنفيذ
│   └── 📁 archive\                             # وثائق ونماذج تاريخية لم تعد مستخدمة
│
├── 📁 Obsidian-Vault\                          # العقل المعرفي (يُفتح ببرنامج Obsidian)
│   ├── 📁 .obsidian\                           # الإعدادات + الثيم snippets/second-brain-hud.css
│   ├── 📁 00-Command-Center\                   # لوحة القيادة، خريطة Canvas، ونسخة فهرس الدوال
│   ├── 📁 01-Commander-Profile\                # AI-Coding-Standards.md (مرفوع) + About-Commander.md 🔒
│   ├── 📁 02-Projects\ 🔒                      # ستة ملفات لكل مشروع + AI-Conversations (تُحدَّث آلياً)
│   ├── 📁 03-AI-Shared-Memory\                 # Memory-Index.md (مرفوع) + Memory-Stream.md 🔒 + *-Sessions\ 🔒
│   └── 📁 04-Family-Emergency-Guide\ 🔒        # دليل العائلة، جدول المشاريع والفواتير، والتشغيل على جهاز جديد
│
└── 📁 Second-Brain-System\                     # النظام البرمجي (Node.js 24 + TypeScript، بلا أي حزم خارجية)
    ├── 📄 package.json                         # أوامر: start / test / scan:code / mcp
    ├── 📄 tsconfig.json
    ├── 📁 config\
    │   ├── 📄 branding.json 🔒                 # الهوية فقط
    │   ├── 📄 settings.json 🔒                 # الذكاء، الموصلات، المراقب، الأمان، المشاريع (والمسارات المخصصة إن وُجدت)
    │   ├── 📄 branding.example.json            # نموذج مرفوع
    │   └── 📄 settings.example.json            # نموذج مرفوع
    ├── 📁 data\ 🔒                             # الخزنة، النسخ الاحتياطية، الذاكرة، حالة السحب والفحص، السجلات
    │
    ├── 📁 install\                         # المرحلة ب: التشغيل التلقائي والنافذة المستقلة
    │   ├── 📄 second-brain.ico              # أيقونة الاختصارات
    │   ├── 📁 windows\                      # install/uninstall-windows.ps1، run-server.ps1 (إعادة تشغيل عند التعطل)، open-app (نافذة --app)
    │   └── 📁 macos\                        # install/uninstall-macos.sh (LaunchAgent)، open-app.sh
    ├── 📁 src\
    │   ├── 📁 core\                            # [CORE] لا يعتمد إلا على shared
    │   │   ├── 📄 config-manager.ts            # الإعدادات: الفصل، الترحيل، التحقق، المسارات النسبية
    │   │   ├── 📄 crypto-engine.ts             # AES-256-GCM + scrypt (N=2^17)، تغليف المفاتيح، مفتاح الطوارئ بخانة تحقق
    │   │   └── 📄 logger.ts                    # سجل التشغيل
    │   │
    │   ├── 📁 features\                        # [FEATURES] كل ميزة في مجلدها
    │   │   ├── 📁 vault\
    │   │   │   └── 📄 vault-manager.ts         # الخزنة v2: مفتاح بيانات مغلَّف مرتين، حفظ ذرّي، تغيير كلمة المرور، تدوير المفتاح
    │   │   ├── 📁 project-indexer\
    │   │   │   ├── 📄 project-scanner.ts       # تشريح المشروع + التأمين الفعلي للملفات الحساسة
    │   │   │   ├── 📄 secret-file-hunter.ts    # صيد الملفات الحساسة (.env، keystore، مفاتيح...)
    │   │   │   ├── 📄 git-inspector.ts         # الفرع، آخر commit، والملفات الحساسة المرفوعة على Git
    │   │   │   ├── 📄 obsidian-sync.ts         # الوثائق الست مع حماية الملاحظات اليدوية وسجل تغييرات عند التغيّر فقط
    │   │   │   ├── 📄 project-details.ts       # تفاصيل صفحة المشروع: التقرير، السجل، الذاكرة، المحادثات، سياق الخلاصة
    │   │   │   ├── 📄 project-launcher.ts      # فتح مجلد المشروع أو VS Code (بلا shell، للمشاريع المسجّلة فقط)
    │   │   │   └── 📄 project-watcher.ts       # المراقب الدوري وإعادة الفحص الشاملة
    │   │   ├── 📁 ai-memory\
    │   │   │   ├── 📄 shared-memory-service.ts # الذاكرة المشتركة (مع حذف الأسرار)
    │   │   │   ├── 📄 transcript-harvester.ts  # السحب التزايدي وربط الجلسات بالمشاريع
    │   │   │   └── 📁 connectors\              # claude-code-connector.ts، antigravity-connector.ts، connector-types.ts
    │   │   ├── 📁 assistant\
    │   │   │   ├── 📄 assistant-engine.ts      # بناء السياق (بلا محتوى الخزنة) ووضعا القائد والعائلة + خلاصة المشروع
    │   │   │   ├── 📄 provider-tester.ts       # زر اختبار الاتصال لكل مزوّد مع سبب الفشل والحل المقترح
    │   │   │   └── 📁 providers\               # claude-cli (Claude عبر الاشتراك) / claude / gemini / ollama / local + provider-registry (التراجع) + stream-parsers
    │   │   ├── 📁 family-emergency\
    │   │   │   ├── 📄 emergency-kit-service.ts # كتيب الطوارئ (في الذاكرة فقط)
    │   │   │   └── 📄 backup-service.ts        # النسخ v2 والاستعادة إلى مجلد جديد
    │   │   ├── 📁 conversations\
    │   │   │   └── 📄 conversation-store.ts    # حفظ المحادثات مشفّرة بمفتاح الخزنة، الفتح والحذف
    │   │   ├── 📁 voice\
    │   │   │   ├── 📄 tts-service.ts           # النطق العربي المحلي: XTTS ثم Piper ثم Windows ثم macOS
    │   │   │   ├── 📄 xtts-engine.ts           # عامل XTTS-v2 الدائم (تحميل مرة واحدة، إطفاء بعد 30 دقيقة)
    │   │   │   └── 📄 xtts-worker.py           # عامل Python: يحمّل النموذج ويولّد WAV لكل جملة
    │   │   ├── 📁 maintenance\
    │   │   │   └── 📄 reset-service.ts         # وضع التطوير: التصفير إلى السلة، الاسترجاع، إفراغ السلة
    │   │   └── 📁 dashboard-app\
    │   │       ├── 📄 desktop-server.ts        # الموجّه على 127.0.0.1 + طبقات الحماية + تشغيل المراقب
    │   │       ├── 📄 http-utils.ts            # الرد، حد الطلب، الكوكيز، Host/CSRF، رؤوس الأمان
    │   │       ├── 📄 session-manager.ts       # جلسة الخزنة، القفل التلقائي، تأخير المحاولات
    │   │       ├── 📁 routes\                  # state، vault، project، memory، assistant، emergency، maintenance
    │   │       └── 📁 public\                  # index.html، styles.css، app.js، hologram.js (CSP صارمة)
    │   │
    │   ├── 📁 shared\                          # [SHARED] لا يعتمد على أي طبقة أخرى
    │   │   ├── 📄 types.ts
    │   │   ├── 📄 file-helpers.ts              # الكتابة الذرّية، أسماء الملفات الآمنة
    │   │   ├── 📄 html-helpers.ts              # escapeHtml
    │   │   └── 📄 secret-redaction.ts          # حذف الأسرار من النصوص
    │   │
    │   └── 📁 tools\                           # [TOOLS] أدوات مستقلة
    │       ├── 📄 mcp-memory-server.ts         # خادم MCP (6 أدوات) لـ Claude Code و Antigravity
    │       └── 📄 code-registry-scanner.ts     # مولّد فهرس الدوال
    │
    └── 📁 tests\                               # [TESTS] دائمة ومعزولة عن البيانات الحقيقية
        ├── 📄 run-all-tests.ts                 # المشغّل + توليد docs/04 و docs/05
        ├── 📄 test-environment.ts              # البيئة المؤقتة المعزولة وبيانات الاختبار
        ├── 📄 01-core-and-vault.test.ts
        ├── 📄 02-project-indexer.test.ts
        ├── 📄 03-ai-shared-memory.test.ts
        ├── 📄 04-family-emergency.test.ts
        ├── 📄 05-tools-and-dashboard.test.ts
        ├── 📄 06-security.test.ts
        ├── 📄 07-integration.test.ts
        ├── 📄 08-disaster-recovery.test.ts     # محاكاة دليل الجهاز الجديد من البداية للنهاية
        ├── 📄 09-project-page.test.ts          # صفحة المشروع
        ├── 📄 10-maintenance.test.ts           # التصفير والاسترجاع والاعتماد النهائي
        ├── 📄 11-connection-guide.test.ts      # اختبار الاتصال بالمزوّدين
        ├── 📄 12-claude-subscription.test.ts   # Claude عبر الاشتراك بمحاكي Claude Code وهمي
        └── 📄 13-conversations-and-voice.test.ts # المحادثات المشفّرة والنطق العربي المحلي
```

---

## 2. قواعد الفصل بين الطبقات (تُفحص آلياً)

1. **`src/shared/`** لا يستورد من أي طبقة أخرى.
2. **`src/core/`** يستورد من `shared` فقط، ولا يعرف شيئاً عن الميزات.
3. **`src/features/`** كل مجلد مسؤول عن ميزة واحدة، ويستخدم `core` و `shared`. الاستيراد بين الميزات مسموح عند الحاجة الصريحة (مثل استخدام الخزنة في الفاحص).
4. **`src/tools/`** أدوات مستقلة تُشغَّل من سطر الأوامر أو تستدعيها أدوات خارجية (MCP).
5. **`public/`** ملفات واجهة ثابتة: بلا سكربتات أو أنماط مضمّنة، وكل نص يُعرض عبر `textContent`.
6. **`tests/`** تعمل في مجلد مؤقت عبر `SECOND_BRAIN_CONFIG_PATH` ولا تلمس البيانات الحقيقية أبداً.

## 3. أين تُحفظ البيانات الشخصية؟

| البيانات | المكان | يُرفع إلى GitHub؟ |
| :--- | :--- | :--- |
| الأسرار وكلمات المرور ومفاتيح API | `data/encrypted-vault/vault.aes256.json` (مشفرة) | ❌ |
| النسخ الاحتياطية | `data/encrypted-backups/` (+ مجلد إضافي اختياري) | ❌ |
| المشاريع والدخل والفواتير | `config/settings.json` و `Obsidian-Vault/02-Projects/` | ❌ |
| المحادثات المؤرشفة والذاكرة | `Obsidian-Vault/03-AI-Shared-Memory/*-Sessions/` و `Memory-Stream.md` و `data/ai-memory-store.json` | ❌ |
| دليل العائلة وملف القائد | `Obsidian-Vault/04-Family-Emergency-Guide/` و `About-Commander.md` | ❌ |
| الكود والوثائق والثيم | بقية المشروع | ✅ |
