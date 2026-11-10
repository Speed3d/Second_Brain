/**
 * ============================================================================
 * الملف: tests/test-environment.ts
 * القسم: Tests (بيئة الاختبار المعزولة — القانون الثامن)
 * Hint بالعربي: يبني هذا الملف بيئة اختبار كاملة داخل مجلد مؤقت (إعدادات، خزنة، Obsidian،
 *               مشروع تجريبي، وسجلات محادثات وهمية) حتى لا تلمس الاختبارات أبداً
 *               خزنتك الحقيقية أو ملفات Obsidian أو سجلات محادثاتك الفعلية.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SystemBrandingConfig, WatchedProjectConfig } from '../src/shared/types.ts';
import { loadSystemConfig } from '../src/core/config-manager.ts';

/**
 * Hint بالعربي: معلومات بيئة الاختبار المعزولة التي تُعاد للمشغل الرئيسي.
 */
export interface IsolatedTestEnvironment {
  rootDir: string;
  fixtureProject: WatchedProjectConfig;
  restore: () => void;
}

/**
 * Hint بالعربي: دالة إنشاء بيئة الاختبار المعزولة وتوجيه النظام إليها عبر متغير البيئة
 *               SECOND_BRAIN_CONFIG_PATH. المدخلات: لا شيء. المخرجات: مسار البيئة،
 *               المشروع التجريبي، ودالة restore التي تحذف البيئة وتعيد النظام لإعداداته الحقيقية.
 */
export function setupIsolatedTestEnvironment(): IsolatedTestEnvironment {
  const realConfig = loadSystemConfig();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-tests-'));
  const fixturesDir = path.join(rootDir, 'fixtures');

  // 1. مشروع تجريبي يحتوي على تقنيات وملف حساس (.env) لاختبار التشريح والصيد والتأمين
  const projectDir = path.join(fixturesDir, 'sample-project');
  writeFixtureFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'sample-project', scripts: { start: 'node index.js', build: 'tsc', test: 'node test.js' } }, null, 2)
  );
  writeFixtureFile(path.join(projectDir, 'tsconfig.json'), '{}');
  writeFixtureFile(path.join(projectDir, 'README.md'), '# Sample Project');
  writeFixtureFile(path.join(projectDir, '.env'), 'API_KEY=test-only-not-real\n');

  // 2. سجلات محادثات وهمية بصيغة Antigravity و Claude Code
  writeFixtureFile(
    path.join(fixturesDir, 'antigravity-brain', 'conv-0001-test', '.system_generated', 'logs', 'transcript.jsonl'),
    [
      JSON.stringify({ type: 'USER_INPUT', content: 'سؤال تجريبي للاختبار' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'رد تجريبي للاختبار' }),
    ].join('\n')
  );
  fs.mkdirSync(path.join(fixturesDir, 'claude-projects', 'test-project'), { recursive: true });

  // 3. Obsidian معزول مع فهرس الذاكرة
  const obsidianDir = path.join(rootDir, 'Obsidian-Vault');
  writeFixtureFile(path.join(obsidianDir, '03-AI-Shared-Memory', 'Memory-Index.md'), '# فهرس الذاكرة (بيئة اختبار)\n');

  const fixtureProject: WatchedProjectConfig = {
    id: 'second-brain-test-project',
    name: 'Second-Brain-Test-Project',
    path: projectDir,
    descriptionAr: 'مشروع تجريبي للاختبارات فقط',
    wifeSummaryAr: 'مشروع تجريبي للاختبارات فقط',
    monthlyIncome: 'لا يوجد (اختبار)',
    billingNotes: 'لا يوجد (اختبار)',
  };

  // 4. ملف إعدادات معزول: نفس الهوية الحقيقية، وكل المسارات داخل المجلد المؤقت
  const testConfig: SystemBrandingConfig = {
    ...realConfig,
    paths: {
      rootDir,
      obsidianVaultDir: obsidianDir,
      encryptedVaultFile: path.join(rootDir, 'data', 'encrypted-vault', 'vault.aes256.json'),
      emergencyKitsDir: path.join(rootDir, 'data', 'emergency-kits'),
      encryptedBackupsDir: path.join(rootDir, 'data', 'encrypted-backups'),
      docsDir: path.join(rootDir, 'docs'),
      antigravityLogsDir: path.join(fixturesDir, 'antigravity-brain'),
      claudeCodeLogsDir: path.join(fixturesDir, 'claude-projects'),
    },
    watchedProjects: [fixtureProject],
  };
  const configPath = path.join(rootDir, 'config', 'branding.json');
  writeFixtureFile(configPath, JSON.stringify(testConfig, null, 2));

  const previousEnv = process.env.SECOND_BRAIN_CONFIG_PATH;
  process.env.SECOND_BRAIN_CONFIG_PATH = configPath;

  return {
    rootDir,
    fixtureProject,
    restore: () => {
      if (previousEnv === undefined) delete process.env.SECOND_BRAIN_CONFIG_PATH;
      else process.env.SECOND_BRAIN_CONFIG_PATH = previousEnv;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Hint بالعربي: دالة مساعدة لكتابة ملف تجريبي مع إنشاء مجلداته الأبوية تلقائياً.
 */
export function writeFixtureFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
