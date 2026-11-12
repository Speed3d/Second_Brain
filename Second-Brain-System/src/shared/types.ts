/**
 * ============================================================================
 * الملف: src/shared/types.ts
 * القسم: Shared (المشتركات العامة)
 * Hint بالعربي: يحتوي هذا الملف على جميع التعريفات والأنواع البرمجية (Interfaces & Types)
 *               المشتركة بين النواة (Core) والميزات (Features) والأدوات (Tools)
 *               لضمان عدم خلط البيانات وتسهيل الصيانة المستقبلية.
 * ============================================================================
 */

/**
 * Hint بالعربي: واجهة إعدادات هوية البرنامج والمسارات (تُقرأ من ملف branding.json)
 * تسمح بتغيير اسم البرنامج أو المساعد الذكي في أي وقت دون تعديل الكود.
 */
export interface SystemBrandingConfig {
  appName: string;
  appTitleAr: string;
  assistantName: string;
  assistantNameAr: string;
  commanderName: string;
  familyMemberTitle: string;
  version: string;
  serverPort: number;
  paths: {
    rootDir: string;
    obsidianVaultDir: string;
    encryptedVaultFile: string;
    emergencyKitsDir: string;
    encryptedBackupsDir: string;
    docsDir: string;
    antigravityLogsDir: string;
    claudeCodeLogsDir: string;
  };
  aiConfig: {
    defaultMode: 'hybrid' | 'cloud' | 'local';
    cloudProvider: 'gemini' | 'claude';
    /** ترتيب تجربة المزوّدين (الأول فالأول)؛ المحلي يُضاف آخراً دائماً */
    providerOrder?: AIProviderId[];
    geminiModel: string;
    claudeModel: string;
    claudeEffort?: 'low' | 'medium' | 'high';
    /** نموذج Claude عبر الاشتراك (Claude Code): اسم مختصر مثل sonnet أو opus */
    claudeCliModel?: string;
    /** مسار برنامج Claude Code (اختياري؛ يُبحث عنه تلقائياً إن تُرك فارغاً) */
    claudeCliPath?: string;
    /** خيار متقدم: استخدام مفاتيح API (فوترة منفصلة عن الاشتراكات)؛ مطفأ افتراضياً */
    apiKeysEnabled?: boolean;
    ollamaEndpoint: string;
    ollamaModel: string;
    requestTimeoutMs?: number;
    voiceEnabled: boolean;
    voiceLang: string;
  };
  /** تفعيل/تعطيل موصلات سحب المحادثات */
  connectors?: {
    antigravity?: { enabled: boolean };
    claudeCode?: { enabled: boolean };
  };
  /** المراقب الدوري للمشاريع */
  watcher?: {
    enabled: boolean;
    intervalMinutes: number;
    harvestTranscripts: boolean;
  };
  watchedProjects: WatchedProjectConfig[];
  /** وضع التطوير: يُظهر زر التصفير؛ يُطفأ مرة واحدة عند الاعتماد النهائي (افتراضياً مفعّل) */
  developerMode?: boolean;
  /** إعدادات الأمان (اختيارية؛ لها قيم افتراضية آمنة) */
  security?: {
    autoLockMinutes?: number;
    backupRetention?: number;
    extraBackupDir?: string;
  };
}

/**
 * Hint بالعربي: معرّفات مزوّدي الذكاء الاصطناعي المدعومين.
 */
export type AIProviderId = 'claude-cli' | 'claude' | 'gemini' | 'ollama' | 'local';

/**
 * Hint بالعربي: حقول الهوية فقط (تُحفظ في branding.json)؛ بقية الإعدادات في settings.json.
 */
export type BrandingIdentity = Pick<
  SystemBrandingConfig,
  'appName' | 'appTitleAr' | 'assistantName' | 'assistantNameAr' | 'commanderName' | 'familyMemberTitle' | 'version'
>;

/**
 * Hint بالعربي: بيانات المشروع المضاف للمراقبة والتوثيق التلقائي.
 */
export interface WatchedProjectConfig {
  id: string;
  name: string;
  path: string;
  descriptionAr: string;
  wifeSummaryAr: string;
  monthlyIncome: string;
  billingNotes: string;
  /** ملخص "ما هذا المشروع وماذا يخدم" (يولّده المساعد ويمكن تعديله يدوياً) */
  summaryAr?: string;
}

/**
 * Hint بالعربي: هيكل البيانات المشفرة بحزمة AES-256-GCM.
 */
export interface EncryptedPayload {
  algorithm: 'aes-256-gcm';
  saltHex: string;
  ivHex: string;
  authTagHex: string;
  cipherTextHex: string;
  createdAt: string;
  /** معاملات اشتقاق المفتاح المستخدمة (تُحفظ لتسهيل الترقية مستقبلاً) */
  kdf?: KdfParams;
}

/**
 * Hint بالعربي: معاملات خوارزمية scrypt لاشتقاق المفتاح من كلمة المرور.
 */
export interface KdfParams {
  algorithm: 'scrypt';
  N: number;
  r: number;
  p: number;
}

/**
 * Hint بالعربي: بيانات مشفرة بمفتاح جاهز (بدون اشتقاق من كلمة مرور).
 */
export interface SealedData {
  ivHex: string;
  authTagHex: string;
  cipherTextHex: string;
}

/**
 * Hint بالعربي: مفتاح البيانات (DEK) مغلَّفاً (مشفراً) بمفتاح مشتق من كلمة مرور أو مفتاح الطوارئ.
 */
export interface WrappedKey extends SealedData {
  kdf: KdfParams;
  saltHex: string;
}

/**
 * Hint بالعربي: نسخة سابقة من ملف حساس محفوظة داخل الخزنة.
 */
export interface CriticalFileVersion {
  sha256: string;
  savedAt: string;
  contentBase64: string;
}

/**
 * Hint بالعربي: عنصر سر واحد داخل الخزنة (إيميل، باسوورد، مفتاح API، أو ملف حساس).
 */
export interface VaultSecretItem {
  id: string;
  category: 'email_account' | 'password' | 'api_key' | 'critical_file' | 'recovery_code' | 'billing';
  title: string;
  projectId?: string;
  usernameOrEmail?: string;
  secretValue: string;
  notesForCommanderAr: string;
  notesForWifeAr: string;
  originalFilePath?: string;
  url?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt: string;
  /** للملفات الحساسة: بصمة المحتوى الحالي، والنسخ السابقة (آخر 5) */
  contentSha256?: string;
  fileVersions?: CriticalFileVersion[];
}

/**
 * Hint بالعربي: نتيجة الفحص والتشريح التلقائي لأي مشروع برمجي.
 */
export interface ProjectScanReport {
  projectId: string;
  projectName: string;
  projectPath: string;
  detectedStack: string[];
  runCommands: string[];
  buildCommands: string[];
  updateCommands: string[];
  criticalFilesFound: CriticalFileEntry[];
  importantFiles: string[];
  gitBranch?: string;
  lastCommitMessage?: string;
  lastCommitHash?: string;
  lastCommitDate?: string;
  uncommittedChanges?: number;
  /** ملفات حساسة مرفوعة فعلاً على Git (خطر تسريب) */
  criticalFilesTrackedByGit?: string[];
  scannedAt: string;
}

/**
 * Hint بالعربي: بيانات الملف الحساس الذي لا يُرفع على Git (مثل .env أو keystore)
 * والذي لا يستطيع أحد تعويضه لو ضاع.
 */
export interface CriticalFileEntry {
  relativePath: string;
  absolutePath: string;
  reasonAr: string;
  sizeBytes: number;
  vaultSecretId?: string;
  /** حالة التأمين: مكتشف فقط، مؤمَّن الآن، مؤمَّن سابقاً دون تغيير، أو أكبر من الحد المسموح */
  securedState?: 'detected' | 'secured' | 'unchanged' | 'too_large';
}

/**
 * Hint بالعربي: سجل محادثة أو قرار محفوظ في الذاكرة المشتركة بين Antigravity و Claude Code.
 */
export interface SharedAIMemoryEntry {
  id: string;
  sourceAI: 'antigravity-gemini' | 'claude-code' | 'second-brain-assistant' | 'manual';
  projectId: string;
  title: string;
  summaryAr: string;
  keyDecisionsAr: string[];
  createdAt: string;
}

/**
 * Hint بالعربي: بيانات دالة أو أداة مكتشفة بواسطة فاحص الأكواد الآلي (تطبيقاً للقانون السابع).
 */
export interface CodeRegistryEntry {
  symbolName: string;
  symbolType: 'function' | 'class' | 'method' | 'tool';
  layer: 'Core' | 'Features' | 'Shared' | 'Tools';
  filePath: string;
  lineNumber: number;
  arabicHint: string;
  usedInFiles: string[];
  status: 'مستخدم (Active)' | 'غير مستخدم / جاهز للتوسع (Unused)';
}
