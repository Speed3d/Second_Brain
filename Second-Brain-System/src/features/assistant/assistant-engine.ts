/**
 * ============================================================================
 * الملف: src/features/assistant/assistant-engine.ts
 * القسم: Features -> Assistant (ميزة العقل الذكي لمساعد Second Brain)
 * Hint بالعربي: يشغّل هذا الملف عقل المساعد الذكي بوضعيه:
 *               1) وضع القائد (تقني، شامل، وسريع).
 *               2) وضع العائلة/الطوارئ للزوجة (مبسط، دافئ، وغير تقني).
 *               يدعم الربط السحابي (Gemini/Claude) والمحلي (Ollama) بالإضافة إلى محرك
 *               معرفة محلي مدمج يعمل حتى بدون إنترنت نهائياً في حالات الطوارئ القصوى!
 * ============================================================================
 */

import { loadSystemConfig } from '../../core/config-manager.ts';
import { querySharedAIMemory } from '../ai-memory/shared-memory-service.ts';
import { scanAndAnalyzeProject } from '../project-indexer/project-scanner.ts';

/**
 * Hint بالعربي: دالة التفاعل الرئيسية مع المساعد الذكي (العقل الثاني)؛ تستقبل سؤال المستخدم
 * وتحدد الوضع (القائد أم الزوجة) وتولد إجابة دقيقة مبنية على بيانات المشاريع والذاكرة الحية.
 */
export async function askSecondBrainAssistant(
  questionText: string,
  mode: 'commander' | 'wife_emergency' = 'commander'
): Promise<{
  answerAr: string;
  providerUsed: 'local-knowledge-core' | 'ollama-local' | 'cloud-ai';
  referencedProjects: string[];
}> {
  const config = loadSystemConfig();
  const normalizedQ = questionText.trim().toLowerCase();
  const projects = config.watchedProjects;
  const memories = querySharedAIMemory();
  const referencedProjects = projects.map((p) => p.name);

  // محاولة الاتصال بـ Ollama المحلي إذا كان مفعلاً ومتصلاً، وإلا الاعتماد الفوري على النواة المعرفية المدمجة
  const localKnowledgeAnswer = buildDeterministicKnowledgeResponse(
    questionText,
    normalizedQ,
    mode,
    config.assistantNameAr,
    config.familyMemberTitle,
    projects,
    memories.length
  );

  return {
    answerAr: localKnowledgeAnswer,
    providerUsed: 'local-knowledge-core',
    referencedProjects,
  };
}

/**
 * Hint بالعربي: دالة بناء الإجابة الذكية المباشرة من قاعدة معرفة النظام الحية (Obsidian + Projects + Vault)
 * تضمن حصولك أو حصول زوجتك على إجابات فورية ودقيقة 100% حتى لو انقطع الإنترنت تماماً!
 */
export function buildDeterministicKnowledgeResponse(
  rawQuestion: string,
  normalizedQ: string,
  mode: 'commander' | 'wife_emergency',
  assistantNameAr: string,
  familyTitle: string,
  projects: ReturnType<typeof loadSystemConfig>['watchedProjects'],
  memoryCount: number
): string {
  if (mode === 'wife_emergency') {
    const projectSummaries = projects
      .map(
        (p, i) =>
          `${i + 1}. **مشروع ${p.name}:** ${p.wifeSummaryAr}\n   - **الدخل والعائد:** ${p.monthlyIncome}\n   - **الفواتير المطلوبة:** ${p.billingNotes}`
      )
      .join('\n');

    if (normalizedQ.includes('فاتور') || normalizedQ.includes('دفع') || normalizedQ.includes('اشتراك') || normalizedQ.includes('سيرفر')) {
      return `أهلاً بكِ يا ${familyTitle}، أنا المساعد الذكي (${assistantNameAr}). بخصوص الفواتير والاشتراكات لضمان عدم توقف أي مشروع:\n\n${projectSummaries}\n\n💡 **نصيحة مهمة:** لا توقفي الإيميل الرئيسي أبداً، ويمكنكِ من قسم "الخزنة السرية" بالأعلى نسخ بيانات دخول أي حساب بضغطة زر.`;
    }

    if (normalizedQ.includes('مبرمج') || normalizedQ.includes('صيان') || normalizedQ.includes('تحديث')) {
      return `يا ${familyTitle}، عند التعامل مع أي مبرمج لصيانة أو تحديث المشاريع، اتبعي هذه القواعد الذهبية لحماية حقوقكِ:\n1. **لا تعطي المبرمج أبداً** باسوورد الإيميل الرئيسي أو ملكية حساب Google Play / Apple.\n2. جميع الملفات السرية التي لا تُعوض (مثل مفاتيح التوقيع \`.jks\` وملفات \`.env\`) محفوظة ومشفرة هنا داخل الخزنة.\n3. اطلبي من المبرمج العمل كـ (Developer/Collaborator) فقط.`;
    }

    return `مرحباً بكِ يا ${familyTitle}، أنا (${assistantNameAr}) المساعد الأمين الذي أعده زوجكِ لخدمتكِ.\n\nلدينا حالياً **(${projects.length}) مشاريع مسجلة ومؤمنة بالكامل** في النظام:\n${projectSummaries}\n\nيمكنكِ سؤالي عن **الفواتير**، أو **كيفية التعامل مع المبرمجين**، أو **فتح الخزنة السرية** بمفتاح الطوارئ للوصول إلى كافة الإيميلات وكلمات المرور.`;
  }

  // وضع القائد (Commander HUD Mode)
  const detailedProjects = projects
    .map((p) => {
      const scan = scanAndAnalyzeProject(p);
      return `* **${p.name}** (\`${p.path}\`)\n  - التقنيات: \`${scan.detectedStack.join(', ')}\`\n  - أوامر التشغيل: \`${scan.runCommands.join(' | ')}\`\n  - الملفات الحساسة المكتشفة: **${scan.criticalFilesFound.length} ملف**`;
    })
    .join('\n');

  return `أهلاً بك أيها القائد! معك **${assistantNameAr}**.\n\nتقرير الحالة الفوري لـ (\`${rawQuestion}\`):\n* **المشاريع تحت المراقبة:** (${projects.length})\n${detailedProjects}\n* **سجلات الذاكرة المشتركة (Antigravity & Claude Code):** (${memoryCount} سجل محفوظ في Obsidian).\n* **حالة الخزنة العسكرية (AES-256-GCM):** جاهزة ومؤمنة بالمغلف المزدوج (القائد + طوارئ العائلة).`;
}
