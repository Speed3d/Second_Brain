/**
 * ============================================================================
 * الملف: tests/03-ai-shared-memory.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: يختبر هذا الملف نظام الذاكرة المشتركة بين Google Antigravity (Gemini)
 *               و Claude Code، بالإضافة إلى ساحب سجلات المحادثات الآلي (Transcript Harvester).
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import { querySharedAIMemory, recordSharedAIMemory } from '../src/features/ai-memory/shared-memory-service.ts';
import { harvestLocalAITranscripts } from '../src/features/ai-memory/transcript-harvester.ts';

/**
 * Hint بالعربي: دالة تشغيل اختبارات الذاكرة المشتركة وسحب سجلات محادثات Antigravity و Claude Code.
 */
export async function runAISharedMemoryTests(): Promise<string[]> {
  const passedChecks: string[] = [];

  // 1. اختبار حفظ واسترجاع ذاكرة من Google Antigravity
  const agyEntry = recordSharedAIMemory({
    sourceAI: 'antigravity-gemini',
    projectId: 'second-brain',
    title: 'تأسيس المعمارية الصارمة والقوانين الثمانية',
    summaryAr: 'تم بناء النظام بتقسيم Core و Features و Shared و Tools وربطه مع Obsidian.',
    keyDecisionsAr: [
      'اعتماد تشفير AES-256-GCM بالمغلف المزدوج (القائد + الزوجة)',
      'توثيق كل دالة بالعربية وفهرستها آلياً',
    ],
  });
  assert.ok(agyEntry.id.startsWith('MEM-'));

  // 2. اختبار حفظ واسترجاع ذاكرة من Claude Code
  const claudeEntry = recordSharedAIMemory({
    sourceAI: 'claude-code',
    projectId: 'second-brain',
    title: 'مراجعة توافق بروتوكول MCP المشترك',
    summaryAr: 'تأكيد قراءة نفس سجل الذاكرة من داخل Claude Code و Antigravity.',
    keyDecisionsAr: ['توحيد المسار داخل 03-AI-Shared-Memory في Obsidian'],
  });
  assert.ok(claudeEntry.id.startsWith('MEM-'));

  const projectMemories = querySharedAIMemory('second-brain');
  assert.ok(projectMemories.length >= 2, 'يجب استرجاع سجلات Antigravity و Claude Code معاً');
  passedChecks.push('اختبار حفظ واسترجاع الذاكرة المشتركة بين Antigravity و Claude Code وتوليد ملفات Obsidian بنجاح.');

  // 3. اختبار ساحب المحادثات الآلي من الجهاز
  const harvestResult = harvestLocalAITranscripts();
  assert.equal(harvestResult.antigravityCount, 1, 'يجب أرشفة محادثة Antigravity التجريبية الوحيدة');
  assert.equal(harvestResult.claudeCodeCount, 1, 'يجب اكتشاف مجلد Claude Code التجريبي الوحيد');
  passedChecks.push(
    `اختبار ساحب المحادثات الآلي (تم سحب ${harvestResult.antigravityCount} محادثة من Antigravity وأرشفتها في Obsidian).`
  );

  return passedChecks;
}
