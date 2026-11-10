/**
 * ============================================================================
 * الملف: src/core/config-manager.ts
 * القسم: Core (النواة الأساسية)
 * Hint بالعربي: مسؤول عن قراءة وتحديث إعدادات النظام والهوية المتغيرة (White-Label Branding)
 *               من ملف config/branding.json، بحيث يمكن تغيير اسم البرنامج أو إضافة مشاريع
 *               في أي وقت دون المساس بالكود البرمجي.
 * ============================================================================
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SystemBrandingConfig, WatchedProjectConfig } from '../shared/types.ts';
import { readJsonFileSafe, writeJsonFileSafe } from '../shared/file-helpers.ts';

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hint بالعربي: دالة تُرجع المسار الفعلي لمجلد Second-Brain-System محسوباً من موقع هذا الملف،
 *               بحيث تعمل أدوات النظام من أي قرص أو مسار دون الاعتماد على مسارات ثابتة.
 */
export function getSystemRootDir(): string {
  return path.resolve(currentFileDir, '../..');
}

/**
 * Hint بالعربي: دالة تحدد مسار ملف الإعدادات الافتراضي وقت الاستدعاء.
 *               إذا وُجد متغير البيئة SECOND_BRAIN_CONFIG_PATH يُستخدم بدلاً من الملف الحقيقي
 *               (تستخدمه الاختبارات لتعمل في بيئة معزولة دون لمس بياناتك الحقيقية).
 */
export function resolveDefaultConfigPath(): string {
  return process.env.SECOND_BRAIN_CONFIG_PATH ?? path.join(getSystemRootDir(), 'config', 'branding.json');
}

/**
 * Hint بالعربي: دالة لجلب الإعدادات المركزية الحالية للبرنامج من ملف branding.json.
 */
export function loadSystemConfig(customConfigPath: string = resolveDefaultConfigPath()): SystemBrandingConfig {
  const fallbackConfig: SystemBrandingConfig = {
    appName: 'Second Brain',
    appTitleAr: 'نظام العقل الثاني والخزنة الذكية',
    assistantName: 'Second Brain',
    assistantNameAr: 'العقل الثاني',
    commanderName: 'القائد',
    familyMemberTitle: 'زوجتي الغالية',
    version: '1.0.0',
    serverPort: 4777,
    paths: {
      rootDir: 'D:\\Second Brain',
      obsidianVaultDir: 'D:\\Second Brain\\Obsidian-Vault',
      encryptedVaultFile: 'D:\\Second Brain\\Second-Brain-System\\data\\encrypted-vault\\vault.aes256.json',
      emergencyKitsDir: 'D:\\Second Brain\\Second-Brain-System\\data\\emergency-kits',
      encryptedBackupsDir: 'D:\\Second Brain\\Second-Brain-System\\data\\encrypted-backups',
      docsDir: 'D:\\Second Brain\\docs',
      antigravityLogsDir: 'C:\\Users\\Laptop-Rog\\.gemini\\antigravity\\brain',
      claudeCodeLogsDir: 'C:\\Users\\Laptop-Rog\\.claude\\projects',
    },
    aiConfig: {
      defaultMode: 'hybrid',
      cloudProvider: 'gemini',
      geminiModel: 'gemini-2.5-pro',
      claudeModel: 'claude-3-7-sonnet-latest',
      ollamaEndpoint: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
      voiceEnabled: true,
      voiceLang: 'ar-SA',
    },
    watchedProjects: [],
  };

  return readJsonFileSafe<SystemBrandingConfig>(customConfigPath, fallbackConfig);
}

/**
 * Hint بالعربي: دالة لتحديث اسم وهوية البرنامج (White-Label) في أي وقت وحفظه في ملف الإعدادات.
 */
export function updateBrandingIdentity(
  updates: Partial<Pick<SystemBrandingConfig, 'appName' | 'appTitleAr' | 'assistantName' | 'assistantNameAr' | 'commanderName' | 'familyMemberTitle'>>,
  customConfigPath: string = resolveDefaultConfigPath()
): SystemBrandingConfig {
  const current = loadSystemConfig(customConfigPath);
  const updated: SystemBrandingConfig = {
    ...current,
    ...updates,
  };
  writeJsonFileSafe(customConfigPath, updated);
  return updated;
}

/**
 * Hint بالعربي: دالة لإضافة مشروع جديد (أو تحديث مشروع موجود) داخل قائمة المشاريع المراقبة تلقائياً.
 */
export function registerWatchedProject(
  project: WatchedProjectConfig,
  customConfigPath: string = resolveDefaultConfigPath()
): SystemBrandingConfig {
  const current = loadSystemConfig(customConfigPath);
  const existingIndex = current.watchedProjects.findIndex((p) => p.id === project.id);
  if (existingIndex >= 0) {
    current.watchedProjects[existingIndex] = project;
  } else {
    current.watchedProjects.push(project);
  }
  writeJsonFileSafe(customConfigPath, current);
  return current;
}
