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
import { createVault, unlockVault, vaultExists, type UnlockedVault } from '../src/features/vault/vault-manager.ts';

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
  // جلسة Claude Code بنفس بنية الملفات الحقيقية: رسالة بشرية فيها سر مزروع، نتيجة أداة، تذكير نظام،
  // تفكير داخلي، إشعار مهمة آلي، وردّ نصي — حتى نتحقق من الاستخراج والتنقية والربط بالمشروع.
  const claudeLine = (o: Record<string, unknown>): string => JSON.stringify({ cwd: projectDir, sessionId: 'test-session-0001', ...o });
  writeFixtureFile(
    path.join(fixturesDir, 'claude-projects', 'D--test-project', 'test-session-0001.jsonl'),
    [
      JSON.stringify({ type: 'custom-title', customTitle: 'جلسة اختبار Claude Code', sessionId: 'test-session-0001' }),
      claudeLine({ type: 'user', timestamp: '2026-11-12T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'أضف مفتاح API_KEY=test-only-key-123456 إلى الإعدادات <system-reminder>تذكير داخلي سري</system-reminder>' } }),
      claudeLine({ type: 'assistant', timestamp: '2026-11-12T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'تفكير داخلي لا يُؤرشف' }] } }),
      claudeLine({ type: 'assistant', timestamp: '2026-11-12T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      claudeLine({ type: 'user', timestamp: '2026-11-12T10:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'محتوى ملف لا يُؤرشف' }] } }),
      claudeLine({ type: 'user', timestamp: '2026-11-12T10:00:08.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'إشعار مهمة آلي' } }),
      claudeLine({ type: 'assistant', timestamp: '2026-11-12T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'تمت إضافة المفتاح بأمان.' }] } }),
    ].join('\n')
  );

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
    // الاختبارات لا تتصل بأي مزوّد ذكاء خارجي، ولا تشغّل المراقب الدوري
    aiConfig: { ...realConfig.aiConfig, providerOrder: ['local'] },
    watcher: { enabled: false, intervalMinutes: 15, harvestTranscripts: false },
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
      cachedTestEmergencyKey = null;
      if (previousEnv === undefined) delete process.env.SECOND_BRAIN_CONFIG_PATH;
      else process.env.SECOND_BRAIN_CONFIG_PATH = previousEnv;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Hint بالعربي: قيم وهمية تشبه الأسرار تُبنى أثناء التشغيل (وليست مكتوبة حرفياً في الكود)
 *               حتى لا تعتبرها ماسحات الأسرار في GitHub مفاتيح حقيقية مسرّبة.
 */
export const FAKE_SECRETS = {
  anthropicKey: ['sk', 'ant', 'api03', 'FAKE'.repeat(8)].join('-'),
  googleKey: ['AI', 'za', 'Sy', 'FAKE'.repeat(8), 'A'].join(''), // البادئة AIza + 35 حرفاً بالضبط
  githubToken: ['gh', 'p_', 'FAKE'.repeat(9)].join(''),
  privateKey: ['-----BEGIN RSA PRIVATE', 'KEY-----\nFAKEKEYBODY\n-----END RSA PRIVATE', 'KEY-----'].join(' '),
};

/** كلمة مرور الخزنة التجريبية (بيئة الاختبار فقط) */
export const TEST_MASTER_PASSWORD = 'Test-Only-Master-Pass-2026';
let cachedTestEmergencyKey: string | null = null;

/**
 * Hint بالعربي: دالة إنشاء خزنة الاختبار المشتركة مرة واحدة (أو فتحها إن كانت موجودة).
 *               المخرجات: الخزنة مفتوحة بكلمة المرور، ومفتاح الطوارئ الخاص بها.
 */
export function ensureTestVault(): { vault: UnlockedVault; emergencyKey: string; masterPassword: string } {
  if (!vaultExists()) {
    const created = createVault(TEST_MASTER_PASSWORD);
    cachedTestEmergencyKey = created.emergencyRecoveryKey;
    return { vault: created.vault, emergencyKey: created.emergencyRecoveryKey, masterPassword: TEST_MASTER_PASSWORD };
  }
  if (!cachedTestEmergencyKey) throw new Error('خزنة الاختبار موجودة لكن مفتاح الطوارئ غير معروف.');
  return { vault: unlockVault(TEST_MASTER_PASSWORD), emergencyKey: cachedTestEmergencyKey, masterPassword: TEST_MASTER_PASSWORD };
}

/**
 * Hint بالعربي: دالة مساعدة لكتابة ملف تجريبي مع إنشاء مجلداته الأبوية تلقائياً.
 */
export function writeFixtureFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
