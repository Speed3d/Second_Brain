/**
 * ============================================================================
 * الملف: src/features/assistant/providers/local-knowledge-provider.ts
 * القسم: Features -> Assistant -> Providers (المزوّد المحلي المدمج — خط التراجع الأخير)
 * Hint بالعربي: يجيب من بيانات النظام نفسه (المشاريع، الفواتير، الذاكرة) دون أي إنترنت أو نموذج،
 *               ويضمن حصولك أو حصول زوجتك على إجابة حتى لو تعطّل كل شيء آخر.
 * ============================================================================
 */

import type { ProjectScanReport, WatchedProjectConfig } from '../../../shared/types.ts';
import type { AIProvider, ProviderChatRequest, ProviderChatResult } from './provider-types.ts';

/**
 * Hint بالعربي: البيانات التي يحتاجها المزوّد المحلي لبناء إجاباته.
 */
export interface LocalKnowledgeContext {
  assistantNameAr: string;
  familyTitle: string;
  projects: WatchedProjectConfig[];
  projectReports: ProjectScanReport[];
  memoryCount: number;
}

/**
 * Hint بالعربي: دالة بناء الإجابة المباشرة من قاعدة معرفة النظام (بدون أي نموذج ذكاء اصطناعي).
 */
export function buildDeterministicKnowledgeResponse(rawQuestion: string, mode: 'commander' | 'wife_emergency', ctx: LocalKnowledgeContext): string {
  const normalizedQ = rawQuestion.trim().toLowerCase();
  const { assistantNameAr, familyTitle, projects } = ctx;

  if (mode === 'wife_emergency') {
    const projectSummaries = projects
      .map(
        (p, i) =>
          `${i + 1}. **مشروع ${p.name}:** ${p.wifeSummaryAr}\n   - **الدخل والعائد:** ${p.monthlyIncome}\n   - **الفواتير المطلوبة:** ${p.billingNotes}`
      )
      .join('\n');

    if (['فاتور', 'دفع', 'اشتراك', 'سيرفر'].some((w) => normalizedQ.includes(w))) {
      return `أهلاً بكِ يا ${familyTitle}، أنا المساعد (${assistantNameAr}). بخصوص الفواتير والاشتراكات لضمان عدم توقف أي مشروع:\n\n${projectSummaries}\n\n💡 **نصيحة مهمة:** لا توقفي الإيميل الرئيسي أبداً، ويمكنكِ من قسم "الخزنة" نسخ بيانات دخول أي حساب بضغطة زر.`;
    }

    if (['مبرمج', 'صيان', 'تحديث'].some((w) => normalizedQ.includes(w))) {
      return `يا ${familyTitle}، عند التعامل مع أي مبرمج لصيانة أو تحديث المشاريع، اتبعي هذه القواعد الذهبية لحماية حقوقكِ:\n1. **لا تعطي المبرمج أبداً** كلمة مرور الإيميل الرئيسي أو ملكية حساب Google Play / Apple.\n2. جميع الملفات السرية التي لا تُعوض (مثل مفاتيح التوقيع \`.jks\` وملفات \`.env\`) محفوظة ومشفرة داخل الخزنة.\n3. اطلبي من المبرمج العمل كـ (Developer/Collaborator) فقط.`;
    }

    return `مرحباً بكِ يا ${familyTitle}، أنا (${assistantNameAr}) المساعد الأمين الذي أعده زوجكِ لخدمتكِ.\n\nلدينا حالياً **(${projects.length}) مشاريع مسجلة** في النظام:\n${projectSummaries}\n\nيمكنكِ سؤالي عن **الفواتير**، أو **كيفية التعامل مع المبرمجين**، أو **فتح الخزنة** بمفتاح الطوارئ للوصول إلى الإيميلات وكلمات المرور.`;
  }

  const detailedProjects = ctx.projectReports
    .map(
      (scan) =>
        `* **${scan.projectName}** (\`${scan.projectPath}\`)\n  - التقنيات: \`${scan.detectedStack.join(', ')}\`\n  - أوامر التشغيل: \`${scan.runCommands.join(' | ')}\`\n  - الملفات الحساسة المكتشفة: **${scan.criticalFilesFound.length} ملف**${
          scan.gitBranch ? `\n  - Git: الفرع \`${scan.gitBranch}\`${scan.lastCommitMessage ? ` — آخر تعديل: ${scan.lastCommitMessage}` : ''}` : ''
        }`
    )
    .join('\n');

  return `أهلاً بك أيها القائد! معك **${assistantNameAr}** (الوضع المحلي دون اتصال).\n\nتقرير الحالة لـ (\`${rawQuestion}\`):\n* **المشاريع تحت المراقبة:** (${projects.length})\n${detailedProjects}\n* **سجلات الذاكرة المشتركة:** (${ctx.memoryCount} سجل).\n\n💡 للحصول على إجابات أذكى أضف مفتاح Claude أو Gemini من قسم الخزنة، أو شغّل Ollama على جهازك.`;
}

/**
 * Hint بالعربي: دالة إنشاء المزوّد المحلي (متاح دائماً).
 */
export function createLocalKnowledgeProvider(ctx: LocalKnowledgeContext): AIProvider {
  return {
    id: 'local',
    labelAr: 'المعرفة المحلية (بدون إنترنت)',
    isConfigured: () => true,
    async checkAvailability() {
      return { ok: true };
    },
    async chat(request: ProviderChatRequest, onDelta?: (text: string) => void): Promise<ProviderChatResult> {
      const text = buildDeterministicKnowledgeResponse(request.question, request.mode, ctx);
      onDelta?.(text);
      return { text, model: 'local-knowledge-core' };
    },
  };
}
