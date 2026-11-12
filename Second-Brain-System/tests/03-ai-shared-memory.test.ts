/**
 * ============================================================================
 * الملف: tests/03-ai-shared-memory.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر الذاكرة المشتركة (الحفظ والاسترجاع وتنقية الأسرار وفصل السجل الشخصي عن الفهرس العام)
 *               وساحب المحادثات التزايدي (Claude Code و Antigravity): الاستخراج الصحيح، حذف الأسرار،
 *               الربط بالمشروع، وعدم إعادة أرشفة ما لم يتغيّر.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../src/features/ai-memory/shared-memory-service.ts';
import { harvestLocalAITranscripts } from '../src/features/ai-memory/transcript-harvester.ts';
import { FAKE_SECRETS } from './test-environment.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات الذاكرة المشتركة وسحب سجلات محادثات Antigravity و Claude Code.
 */
export async function runAISharedMemoryTests(): Promise<string[]> {
  const passedChecks: string[] = [];
  const config = loadSystemConfig();
  const indexPath = path.join(config.paths.obsidianVaultDir, '03-AI-Shared-Memory', 'Memory-Index.md');
  const indexBefore = fs.readFileSync(indexPath, 'utf-8');

  // 1. حفظ واسترجاع ذاكرة من Antigravity و Claude Code، مع حذف أي سر يرد في الملخص
  const agyEntry = recordSharedAIMemory({
    sourceAI: 'antigravity-gemini',
    projectId: 'second-brain',
    title: 'تأسيس المعمارية الصارمة والقوانين الثمانية',
    summaryAr: 'تم بناء النظام بتقسيم Core و Features و Shared و Tools وربطه مع Obsidian.',
    keyDecisionsAr: ['اعتماد تشفير AES-256-GCM بالمغلف المزدوج', 'توثيق كل دالة بالعربية وفهرستها آلياً'],
  });
  assert.ok(agyEntry.id.startsWith('MEM-'));
  const claudeEntry = recordSharedAIMemory({
    sourceAI: 'claude-code',
    projectId: 'second-brain',
    title: 'مراجعة توافق بروتوكول MCP المشترك',
    summaryAr: `تم الربط باستخدام المفتاح ${FAKE_SECRETS.anthropicKey} بنجاح.`,
    keyDecisionsAr: ['PASSWORD=SuperSecret123 لا يجب أن يُحفظ'],
  });
  assert.ok(!claudeEntry.summaryAr.includes(FAKE_SECRETS.anthropicKey), 'يجب حذف مفتاح API من الملخص');
  assert.ok(!claudeEntry.keyDecisionsAr[0].includes('SuperSecret123'), 'يجب حذف كلمة المرور من القرارات');
  assert.ok(querySharedAIMemory('second-brain').length >= 2);
  assert.equal(fs.readFileSync(indexPath, 'utf-8'), indexBefore, 'الفهرس العام (المرفوع على GitHub) يجب ألا يتغيّر');
  assert.ok(fs.existsSync(path.join(config.paths.obsidianVaultDir, '03-AI-Shared-Memory', 'Memory-Stream.md')), 'السجل الشخصي يُكتب في ملف منفصل');
  passedChecks.push('اختبار الذاكرة المشتركة (حفظ واسترجاع، حذف الأسرار تلقائياً، وعدم تسريب السجل إلى الفهرس العام) بنجاح.');

  // 2. السحب الأول: استخراج صحيح + حذف الأسرار + ربط جلسة Claude Code بمشروعها
  const first = harvestLocalAITranscripts();
  assert.equal(first.antigravityCount, 1, 'يجب أرشفة محادثة Antigravity التجريبية');
  assert.equal(first.claudeCodeCount, 1, 'يجب أرشفة جلسة Claude Code التجريبية');
  assert.ok(first.redactions >= 1, 'يجب حذف السر المزروع في الجلسة');
  const project = config.watchedProjects[0];
  const claudeArchive = first.archivedFiles.find((f) => path.basename(f).startsWith('Claude-Code-'));
  assert.ok(claudeArchive && claudeArchive.includes(path.join('02-Projects', project.name, 'AI-Conversations')), 'الجلسة تُحفظ داخل مجلد مشروعها');
  const archived = fs.readFileSync(claudeArchive!, 'utf-8');
  assert.ok(archived.includes('جلسة اختبار Claude Code'), 'يجب استخدام عنوان الجلسة');
  assert.ok(archived.includes('تمت إضافة المفتاح بأمان.'), 'يجب أرشفة رد Claude النصي');
  assert.ok(!archived.includes('test-only-key-123456'), 'يجب حذف السر من الأرشيف');
  for (const hidden of ['تذكير داخلي سري', 'تفكير داخلي لا يُؤرشف', 'محتوى ملف لا يُؤرشف', 'إشعار مهمة آلي']) {
    assert.ok(!archived.includes(hidden), `يجب ألا يُؤرشف: ${hidden}`);
  }
  passedChecks.push('اختبار موصل Claude Code (رسائل القائد والردود فقط، حذف الأسرار، وحفظ الجلسة في مجلد مشروعها) بنجاح.');

  // 3. السحب الثاني دون تغيير: لا إعادة أرشفة
  const second = harvestLocalAITranscripts();
  assert.equal(second.antigravityCount + second.claudeCodeCount, 0);
  assert.equal(second.skippedUnchanged, 2);
  passedChecks.push('اختبار السحب التزايدي (لا تُعاد أرشفة الجلسات غير المتغيرة) بنجاح.');

  return passedChecks;
}
