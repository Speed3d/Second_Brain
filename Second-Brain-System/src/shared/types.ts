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
    geminiModel: string;
    claudeModel: string;
    ollamaEndpoint: string;
    ollamaModel: string;
    voiceEnabled: boolean;
    voiceLang: string;
  };
  watchedProjects: WatchedProjectConfig[];
}

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
  updatedAt: string;
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
