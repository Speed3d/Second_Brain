/**
 * ============================================================================
 * الملف: src/core/config-manager.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: مدير الإعدادات المرن:
 *               - الهوية (اسم البرنامج والمساعد) في config/branding.json.
 *               - بقية الإعدادات (المسارات، الذكاء الاصطناعي، الموصلات، المراقب، المشاريع) في config/settings.json.
 *               - المسارات الداخلية تُحسب من موقع البرنامج نفسه، فيعمل من أي قرص أو فلاشة.
 *               - المسارات الخارجية (سجلات Antigravity و Claude Code) تُشتق من مجلد المستخدم.
 *               - الملف القديم المدمج يُرحَّل آلياً مرة واحدة مع الاحتفاظ بنسخة منه.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AIProviderId, BrandingIdentity, SystemBrandingConfig, WatchedProjectConfig } from '../shared/types.ts';
import { readJsonFileSafe, writeFileAtomic } from '../shared/file-helpers.ts';

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hint بالعربي: دالة قراءة إصدار البرنامج من package.json — المصدر الوحيد للإصدار (يُرفع مع كل تحديث،
 *               وتُوثَّق تغييراته في CHANGELOG.md). لا يُقرأ من branding.json حتى لا يختلف بين الأجهزة.
 */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(currentFileDir, '..', '..', 'package.json'), 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** مفاتيح الهوية التي تبقى في branding.json */
const IDENTITY_KEYS: Array<keyof BrandingIdentity> = [
  'appName',
  'appTitleAr',
  'assistantName',
  'assistantNameAr',
  'commanderName',
  'familyMemberTitle',
  'version',
];
/** مفاتيح الإعدادات التي تُنقل إلى settings.json */
const SETTINGS_KEYS = ['serverPort', 'paths', 'aiConfig', 'connectors', 'watcher', 'security', 'developerMode', 'watchedProjects'] as const;
const VALID_PROVIDERS: AIProviderId[] = ['claude-cli', 'claude', 'gemini', 'ollama', 'local'];

/**
 * Hint بالعربي: دالة تُرجع المسار الفعلي لمجلد Second-Brain-System محسوباً من موقع هذا الملف،
 *               بحيث تعمل أدوات النظام من أي قرص أو مسار دون الاعتماد على مسارات ثابتة.
 */
export function getSystemRootDir(): string {
  return path.resolve(currentFileDir, '../..');
}

/**
 * Hint بالعربي: دالة تحدد مسار ملف الهوية الافتراضي وقت الاستدعاء.
 *               متغير البيئة SECOND_BRAIN_CONFIG_PATH يوجّه النظام لملف آخر (تستخدمه الاختبارات).
 */
export function resolveDefaultConfigPath(): string {
  return process.env.SECOND_BRAIN_CONFIG_PATH ?? path.join(getSystemRootDir(), 'config', 'branding.json');
}

/**
 * Hint بالعربي: دالة تحديد مسار ملف الإعدادات المرافق لملف الهوية (settings.json في نفس المجلد).
 */
export function resolveSettingsPath(brandingPath: string = resolveDefaultConfigPath()): string {
  return path.join(path.dirname(brandingPath), 'settings.json');
}

/**
 * Hint بالعربي: دالة إزالة أسماء النماذج المتقادمة من إعدادات الذكاء الاصطناعي حتى تُستخدم الأسماء الحالية الموصى بها.
 *               المخرجات: قائمة بالأسماء التي أُزيلت.
 */
export function dropDeprecatedModelNames(aiConfig: Record<string, unknown>): string[] {
  const removed: string[] = [];
  if (typeof aiConfig.claudeModel === 'string' && /^claude-(3|instant|2)/.test(aiConfig.claudeModel)) {
    removed.push(aiConfig.claudeModel);
    delete aiConfig.claudeModel;
  }
  if (typeof aiConfig.geminiModel === 'string' && /^gemini-(1|2)\./.test(aiConfig.geminiModel)) {
    removed.push(aiConfig.geminiModel);
    delete aiConfig.geminiModel;
  }
  return removed;
}

/**
 * Hint بالعربي: دالة بناء الإعدادات الافتراضية الكاملة (المسارات محسوبة من موقع البرنامج ومجلد المستخدم).
 */
export function buildDefaultConfig(): SystemBrandingConfig {
  const systemRoot = getSystemRootDir();
  const rootDir = path.resolve(systemRoot, '..');
  const home = os.homedir();
  return {
    appName: 'Second Brain',
    appTitleAr: 'نظام العقل الثاني والخزنة الذكية',
    assistantName: 'Second Brain',
    assistantNameAr: 'العقل الثاني',
    commanderName: 'القائد',
    familyMemberTitle: 'زوجتي الغالية',
    version: readAppVersion(),
    serverPort: 4777,
    paths: {
      rootDir,
      obsidianVaultDir: path.join(rootDir, 'Obsidian-Vault'),
      encryptedVaultFile: path.join(systemRoot, 'data', 'encrypted-vault', 'vault.aes256.json'),
      emergencyKitsDir: path.join(systemRoot, 'data', 'emergency-kits'),
      encryptedBackupsDir: path.join(systemRoot, 'data', 'encrypted-backups'),
      docsDir: path.join(rootDir, 'docs'),
      antigravityLogsDir: path.join(home, '.gemini', 'antigravity', 'brain'),
      claudeCodeLogsDir: path.join(home, '.claude', 'projects'),
    },
    aiConfig: {
      defaultMode: 'hybrid',
      cloudProvider: 'claude',
      geminiModel: 'gemini-3.8-flash',
      claudeModel: 'claude-opus-5-5',
      claudeEffort: 'medium',
      claudeCliModel: 'sonnet',
      claudeCliPath: '',
      apiKeysEnabled: false,
      ollamaEndpoint: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
      requestTimeoutMs: 120000,
      voiceEnabled: true,
      voiceLang: 'ar-SA',
    },
    connectors: { antigravity: { enabled: true }, claudeCode: { enabled: true } },
    watcher: { enabled: true, intervalMinutes: 15, harvestTranscripts: true },
    security: { autoLockMinutes: 10, backupRetention: 10 },
    developerMode: true,
    watchedProjects: [],
  };
}

/**
 * Hint بالعربي: دالة تحويل مسار من الإعدادات إلى مسار مطلق: المسار النسبي يُحسب من مجلد الجذر.
 */
export function resolveConfiguredPath(value: unknown, fallback: string, rootDir: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(rootDir, value);
}

/**
 * Hint بالعربي: دالة دمج الإعدادات المقروءة مع الافتراضية والتحقق من صحة كل حقل،
 *               فالقيمة غير الصالحة تُستبدل بالافتراضية بدل أن تعطّل البرنامج.
 *               المخرجات: الإعدادات النهائية + قائمة تحذيرات بالعربية.
 */
export function normalizeSystemConfig(raw: Record<string, unknown>): { config: SystemBrandingConfig; warnings: string[] } {
  const defaults = buildDefaultConfig();
  const warnings: string[] = [];
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

  let serverPort = defaults.serverPort;
  if (raw.serverPort !== undefined) {
    const p = Number(raw.serverPort);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) serverPort = p;
    else warnings.push(`منفذ الخادم غير صالح (${String(raw.serverPort)})، استُخدم ${defaults.serverPort}.`);
  }

  const rawPaths = obj(raw.paths);
  const rootDir = resolveConfiguredPath(rawPaths.rootDir, defaults.paths.rootDir, defaults.paths.rootDir);
  const p = (key: keyof SystemBrandingConfig['paths']): string =>
    resolveConfiguredPath(rawPaths[key], defaults.paths[key], rootDir);

  const ai = obj(raw.aiConfig);
  const mode = ['hybrid', 'cloud', 'local'].includes(String(ai.defaultMode)) ? (ai.defaultMode as SystemBrandingConfig['aiConfig']['defaultMode']) : defaults.aiConfig.defaultMode;
  const cloudProvider = ai.cloudProvider === 'gemini' || ai.cloudProvider === 'claude' ? ai.cloudProvider : defaults.aiConfig.cloudProvider;
  let providerOrder: AIProviderId[] | undefined;
  if (Array.isArray(ai.providerOrder)) {
    providerOrder = ai.providerOrder.filter((x): x is AIProviderId => VALID_PROVIDERS.includes(x as AIProviderId));
    if (providerOrder.length !== ai.providerOrder.length) warnings.push('تم تجاهل مزوّد غير معروف في providerOrder.');
  }
  const effort = ['low', 'medium', 'high'].includes(String(ai.claudeEffort)) ? (ai.claudeEffort as 'low' | 'medium' | 'high') : defaults.aiConfig.claudeEffort;
  const timeout = Number(ai.requestTimeoutMs);

  const connectors = obj(raw.connectors);
  const watcher = obj(raw.watcher);
  const security = obj(raw.security);
  const interval = Number(watcher.intervalMinutes);

  const projects: WatchedProjectConfig[] = [];
  if (Array.isArray(raw.watchedProjects)) {
    for (const item of raw.watchedProjects) {
      const o = obj(item);
      if (typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string') {
        projects.push({
          id: o.id,
          name: o.name,
          path: resolveConfiguredPath(o.path, o.path, rootDir),
          descriptionAr: str(o.descriptionAr, ''),
          wifeSummaryAr: str(o.wifeSummaryAr, ''),
          monthlyIncome: str(o.monthlyIncome, 'غير محدد بعد'),
          billingNotes: str(o.billingNotes, ''),
          ...(typeof o.summaryAr === 'string' && o.summaryAr.trim() ? { summaryAr: o.summaryAr } : {}),
        });
      } else {
        warnings.push('تم تجاهل مشروع ناقص البيانات في قائمة المشاريع.');
      }
    }
  }

  const config: SystemBrandingConfig = {
    appName: str(raw.appName, defaults.appName),
    appTitleAr: str(raw.appTitleAr, defaults.appTitleAr),
    assistantName: str(raw.assistantName, defaults.assistantName),
    assistantNameAr: str(raw.assistantNameAr, defaults.assistantNameAr),
    commanderName: str(raw.commanderName, defaults.commanderName),
    familyMemberTitle: str(raw.familyMemberTitle, defaults.familyMemberTitle),
    version: defaults.version,
    serverPort,
    paths: {
      rootDir,
      obsidianVaultDir: p('obsidianVaultDir'),
      encryptedVaultFile: p('encryptedVaultFile'),
      emergencyKitsDir: p('emergencyKitsDir'),
      encryptedBackupsDir: p('encryptedBackupsDir'),
      docsDir: p('docsDir'),
      antigravityLogsDir: p('antigravityLogsDir'),
      claudeCodeLogsDir: p('claudeCodeLogsDir'),
    },
    aiConfig: {
      defaultMode: mode,
      cloudProvider,
      providerOrder,
      geminiModel: str(ai.geminiModel, defaults.aiConfig.geminiModel),
      claudeModel: str(ai.claudeModel, defaults.aiConfig.claudeModel),
      claudeEffort: effort,
      claudeCliModel: /^[a-z0-9][a-z0-9.\-]{0,79}$/i.test(String(ai.claudeCliModel ?? '')) ? String(ai.claudeCliModel) : defaults.aiConfig.claudeCliModel,
      claudeCliPath: typeof ai.claudeCliPath === 'string' ? ai.claudeCliPath.trim().slice(0, 500) : '',
      apiKeysEnabled: ai.apiKeysEnabled === true,
      ollamaEndpoint: str(ai.ollamaEndpoint, defaults.aiConfig.ollamaEndpoint),
      ollamaModel: str(ai.ollamaModel, defaults.aiConfig.ollamaModel),
      requestTimeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? timeout : defaults.aiConfig.requestTimeoutMs,
      voiceEnabled: bool(ai.voiceEnabled, defaults.aiConfig.voiceEnabled),
      voiceLang: str(ai.voiceLang, defaults.aiConfig.voiceLang),
    },
    connectors: {
      antigravity: { enabled: bool(obj(connectors.antigravity).enabled, true) },
      claudeCode: { enabled: bool(obj(connectors.claudeCode).enabled, true) },
    },
    watcher: {
      enabled: bool(watcher.enabled, true),
      intervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : 15,
      harvestTranscripts: bool(watcher.harvestTranscripts, true),
    },
    security: {
      autoLockMinutes: Number(security.autoLockMinutes) >= 1 ? Number(security.autoLockMinutes) : 10,
      backupRetention: Number(security.backupRetention) >= 1 ? Number(security.backupRetention) : 10,
      extraBackupDir: typeof security.extraBackupDir === 'string' && security.extraBackupDir.trim()
        ? resolveConfiguredPath(security.extraBackupDir, '', rootDir)
        : undefined,
    },
    developerMode: raw.developerMode !== false,
    watchedProjects: projects,
  };
  return { config, warnings };
}

/**
 * Hint بالعربي: دالة ترحيل الملف القديم المدمج: إذا احتوى branding.json على إعدادات (مسارات، مشاريع...)
 *               ولا يوجد settings.json، تُنقل الإعدادات إليه وتبقى الهوية فقط في branding.json.
 *               المسارات التي تساوي القيم الافتراضية لا تُكتب (حتى يبقى النظام قابلاً للنقل).
 *               المخرجات: true إذا تم الترحيل.
 */
export function migrateLegacyConfig(brandingPath: string = resolveDefaultConfigPath()): boolean {
  const settingsPath = resolveSettingsPath(brandingPath);
  const raw = readJsonFileSafe<Record<string, unknown> | null>(brandingPath, null);
  if (!raw || fs.existsSync(settingsPath)) return false;
  const hasSettings = SETTINGS_KEYS.some((k) => raw[k] !== undefined);
  if (!hasSettings) return false;

  const defaults = buildDefaultConfig();
  const settings: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (raw[key] !== undefined) settings[key] = raw[key];
  }
  if (settings.paths && typeof settings.paths === 'object') {
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings.paths as Record<string, string>)) {
      const def = (defaults.paths as Record<string, string>)[k];
      if (typeof v === 'string' && def && path.normalize(v).toLowerCase() !== path.normalize(def).toLowerCase()) kept[k] = v;
    }
    if (Object.keys(kept).length) settings.paths = kept;
    else delete settings.paths;
  }
  if (settings.aiConfig && typeof settings.aiConfig === 'object') {
    dropDeprecatedModelNames(settings.aiConfig as Record<string, unknown>);
  }
  const identity: Record<string, unknown> = {};
  for (const key of IDENTITY_KEYS) {
    if (raw[key] !== undefined) identity[key] = raw[key];
  }

  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
  writeFileAtomic(brandingPath, JSON.stringify(identity, null, 2), 1);
  return true;
}

/**
 * Hint بالعربي: دالة جلب الإعدادات الكاملة (الهوية + الإعدادات) بعد الترحيل والتحقق.
 */
export function loadSystemConfig(customConfigPath: string = resolveDefaultConfigPath()): SystemBrandingConfig {
  return loadSystemConfigWithWarnings(customConfigPath).config;
}

/**
 * Hint بالعربي: دالة جلب الإعدادات مع قائمة التحذيرات (تُستخدم عند تشغيل الخادم لإظهار المشاكل).
 */
export function loadSystemConfigWithWarnings(customConfigPath: string = resolveDefaultConfigPath()): {
  config: SystemBrandingConfig;
  warnings: string[];
} {
  try {
    migrateLegacyConfig(customConfigPath);
  } catch {
    // إذا تعذّر الترحيل (قرص للقراءة فقط مثلاً) نقرأ الملف كما هو
  }
  const identity = readJsonFileSafe<Record<string, unknown>>(customConfigPath, {});
  const settings = readJsonFileSafe<Record<string, unknown>>(resolveSettingsPath(customConfigPath), {});
  return normalizeSystemConfig({ ...identity, ...settings });
}

/**
 * Hint بالعربي: دالة قراءة ملف الإعدادات الخام (settings.json) كما هو مكتوب، للتعديل عليه وحفظه.
 */
export function readRawSettings(customConfigPath: string = resolveDefaultConfigPath()): Record<string, unknown> {
  migrateLegacyConfig(customConfigPath);
  return readJsonFileSafe<Record<string, unknown>>(resolveSettingsPath(customConfigPath), {});
}

/**
 * Hint بالعربي: دالة حفظ تعديل جزئي على settings.json (مع نسخة سابقة) دون المساس بالهوية.
 */
export function updateSystemSettings(
  updates: Record<string, unknown>,
  customConfigPath: string = resolveDefaultConfigPath()
): SystemBrandingConfig {
  const current = readRawSettings(customConfigPath);
  writeFileAtomic(resolveSettingsPath(customConfigPath), JSON.stringify({ ...current, ...updates }, null, 2), 3);
  return loadSystemConfig(customConfigPath);
}

/**
 * Hint بالعربي: دالة لتحديث اسم وهوية البرنامج (White-Label) في أي وقت وحفظه في branding.json.
 */
export function updateBrandingIdentity(
  updates: Partial<Pick<SystemBrandingConfig, 'appName' | 'appTitleAr' | 'assistantName' | 'assistantNameAr' | 'commanderName' | 'familyMemberTitle'>>,
  customConfigPath: string = resolveDefaultConfigPath()
): SystemBrandingConfig {
  migrateLegacyConfig(customConfigPath);
  const current = readJsonFileSafe<Record<string, unknown>>(customConfigPath, {});
  writeFileAtomic(customConfigPath, JSON.stringify({ ...current, ...updates }, null, 2), 3);
  return loadSystemConfig(customConfigPath);
}

/**
 * Hint بالعربي: دالة لإضافة مشروع جديد (أو تحديث مشروع موجود) في قائمة المشاريع داخل settings.json.
 */
export function registerWatchedProject(
  project: WatchedProjectConfig,
  customConfigPath: string = resolveDefaultConfigPath()
): SystemBrandingConfig {
  const raw = readRawSettings(customConfigPath);
  const list = Array.isArray(raw.watchedProjects) ? (raw.watchedProjects as WatchedProjectConfig[]) : [];
  const idx = list.findIndex((p) => p.id === project.id);
  if (idx >= 0) list[idx] = project;
  else list.push(project);
  return updateSystemSettings({ watchedProjects: list }, customConfigPath);
}

/**
 * Hint بالعربي: دالة إيقاف مراقبة مشروع (إزالته من القائمة فقط؛ وثائقه في Obsidian تبقى كما هي).
 *               المخرجات: true إذا وُجد المشروع وأُزيل.
 */
export function unregisterWatchedProject(projectId: string, customConfigPath: string = resolveDefaultConfigPath()): boolean {
  const raw = readRawSettings(customConfigPath);
  const list = Array.isArray(raw.watchedProjects) ? (raw.watchedProjects as WatchedProjectConfig[]) : [];
  const remaining = list.filter((p) => p.id !== projectId);
  if (remaining.length === list.length) return false;
  updateSystemSettings({ watchedProjects: remaining }, customConfigPath);
  return true;
}
