/**
 * ============================================================================
 * الملف: src/features/assistant/assistant-engine.ts
 * القسم: Features -> Assistant (عقل المساعد الذكي)
 * Hint بالعربي: يبني سياق المساعد (ملف القائد، المشاريع، الذاكرة المشتركة) — دون أي محتوى من الخزنة —
 *               ثم يمرّر السؤال لمزوّدي الذكاء بالترتيب (Claude / Gemini / Ollama / المعرفة المحلية).
 *               للمساعد أسلوبان: تقني مختصر للقائد، ومبسّط دافئ وغير تقني لوضع العائلة.
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AIProviderId, ProjectScanReport, SharedAIMemoryEntry, SystemBrandingConfig } from '../../shared/types.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';
import { loadSystemConfig } from '../../core/config-manager.ts';
import { logSystemInfo } from '../../core/logger.ts';
import { querySharedAIMemory } from '../ai-memory/shared-memory-service.ts';
import { scanAndAnalyzeProject } from '../project-indexer/project-scanner.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import type { ChatTurn } from './providers/provider-types.ts';
import { buildProviders, resolveProviderKeys, runProvidersWithFallback, type ProviderAttempt } from './providers/provider-registry.ts';

export { buildDeterministicKnowledgeResponse } from './providers/local-knowledge-provider.ts';

/** حدود السياق والمحادثة حتى لا يتضخم الطلب */
const MAX_PROFILE_CHARS = 6000;
const MAX_MEMORY_ENTRIES = 15;
const MAX_HISTORY_TURNS = 12;
const MAX_TURN_CHARS = 8000;

/**
 * Hint بالعربي: خيارات استدعاء المساعد: سجل المحادثة السابقة، الخزنة المفتوحة (لقراءة مفاتيح API فقط)،
 *               ودوال البثّ التدريجي، وإشارة الإلغاء.
 */
export interface AskAssistantOptions {
  history?: ChatTurn[];
  vault?: UnlockedVault | null;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  signal?: AbortSignal;
}

/**
 * Hint بالعربي: نتيجة المساعد: الإجابة، المزوّد الذي أجاب، النموذج، المشاريع المرجعية، وسجل المحاولات.
 */
export interface AssistantReply {
  answerAr: string;
  providerUsed: AIProviderId;
  model: string;
  referencedProjects: string[];
  attempts: ProviderAttempt[];
}

/**
 * Hint بالعربي: دالة قراءة ملف هوية القائد من Obsidian (مع حد أقصى للطول).
 */
export function readCommanderProfile(config: SystemBrandingConfig): string {
  const file = path.join(config.paths.obsidianVaultDir, '01-Commander-Profile', 'About-Commander.md');
  try {
    return fs.readFileSync(file, 'utf-8').slice(0, MAX_PROFILE_CHARS);
  } catch {
    return '';
  }
}

/**
 * Hint بالعربي: دالة بناء تعليمات النظام (System Prompt) للمساعد حسب الوضع، مع تنقية أي سر قد يظهر فيها.
 */
export function buildAssistantSystemPrompt(
  mode: 'commander' | 'wife_emergency',
  config: SystemBrandingConfig,
  reports: ProjectScanReport[],
  memories: SharedAIMemoryEntry[],
  profile: string
): string {
  const today = new Date().toISOString().slice(0, 10);
  let prompt: string;

  if (mode === 'wife_emergency') {
    const projects = config.watchedProjects
      .map((p) => `- ${p.name}: ${p.wifeSummaryAr || 'بدون شرح'} | الدخل: ${p.monthlyIncome} | الفواتير: ${p.billingNotes || 'غير محددة'}`)
      .join('\n');
    prompt = `أنت "${config.assistantNameAr}"، مساعد عائلي أمين أعدّه ${config.commanderName} ليساعد ${config.familyMemberTitle} في إدارة مشاريعه وحساباته عند الطوارئ.
التاريخ: ${today}.

أسلوبك:
- عربية بسيطة ودافئة وواضحة، بلا مصطلحات تقنية؛ وإن اضطررت لمصطلح فاشرحه بجملة.
- خطوات مرقّمة قصيرة عند شرح أي إجراء.
- إذا لم تعرف الجواب من المعلومات أدناه فقل ذلك بصراحة، واقترح استشارة شخص موثوق، ولا تخترع معلومات.

قواعد أمان لا تُكسر:
- لا تطلب كلمات مرور أو مفاتيح، ولا تكتبها أبداً. كلمات المرور موجودة في "الخزنة" داخل البرنامج وتُفتح بمفتاح الطوارئ المطبوع.
- لا يُعطى أي مبرمج كلمة مرور الإيميل الرئيسي أو ملكية حسابات المتاجر؛ يُضاف كمتعاون (Developer) فقط.
- لا تشارك مفتاح الطوارئ أو صورته مع أي أحد.

المشاريع:
${projects || '- لا توجد مشاريع مسجلة بعد.'}`;
  } else {
    const projects = reports
      .map((r) => {
        const git = r.gitBranch ? ` | Git: ${r.gitBranch}${r.lastCommitMessage ? ` — "${r.lastCommitMessage}"` : ''}${r.uncommittedChanges ? ` (${r.uncommittedChanges} تغيير غير محفوظ)` : ''}` : '';
        const tracked = r.criticalFilesTrackedByGit?.length ? ` | ⚠️ ملفات حساسة مرفوعة على Git: ${r.criticalFilesTrackedByGit.join(', ')}` : '';
        return `- ${r.projectName} (${r.projectPath}) | ${r.detectedStack.join(', ')} | تشغيل: ${r.runCommands[0] ?? '—'} | ملفات حساسة: ${r.criticalFilesFound.length}${git}${tracked}`;
      })
      .join('\n');
    const memoryLines = memories
      .slice(0, MAX_MEMORY_ENTRIES)
      .map((m) => `- [${m.createdAt.slice(0, 10)}] (${m.sourceAI} → ${m.projectId}) ${m.title}: ${m.summaryAr}`)
      .join('\n');
    prompt = `أنت "${config.assistantNameAr}"، المساعد الشخصي لـ ${config.commanderName} داخل نظام "${config.appName}".
التاريخ: ${today}.

أسلوبك: عربية واضحة ومختصرة، تقنية عند الحاجة، مع أوامر دقيقة عند السؤال عن التشغيل. لا تخترع حقائق عن المشاريع؛ اعتمد على المعلومات أدناه وقل بوضوح ما لا تعرفه.
لا تملك وصولاً إلى محتوى الخزنة المشفرة، ولا تطلب كلمات مرور أو مفاتيح.

ملف القائد:
${profile || '(غير متوفر)'}

المشاريع تحت المراقبة:
${projects || '- لا توجد مشاريع مسجلة بعد.'}

آخر سجلات الذاكرة المشتركة:
${memoryLines || '- لا توجد سجلات بعد.'}`;
  }
  return redactSecrets(prompt).text;
}

/**
 * Hint بالعربي: دالة تنظيف سجل المحادثة القادم من الواجهة (أدوار صحيحة، حدود للطول والعدد، وتنقية الأسرار).
 */
export function sanitizeHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  const turns: ChatTurn[] = [];
  for (const item of history.slice(-MAX_HISTORY_TURNS)) {
    const role = (item as ChatTurn)?.role;
    const content = (item as ChatTurn)?.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content: redactSecrets(content.slice(0, MAX_TURN_CHARS)).text });
    }
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

/**
 * Hint بالعربي: دالة التفاعل الرئيسية مع المساعد: تبني السياق، وتجرّب المزوّدين بالترتيب، وتبثّ الرد تدريجياً.
 */
export async function askSecondBrainAssistant(
  questionText: string,
  mode: 'commander' | 'wife_emergency' = 'commander',
  options: AskAssistantOptions = {}
): Promise<AssistantReply> {
  const config = loadSystemConfig();
  const question = questionText.trim().slice(0, MAX_TURN_CHARS);
  const reports = config.watchedProjects.map((p) => scanAndAnalyzeProject(p));
  const memories = querySharedAIMemory();

  const providers = buildProviders(config, resolveProviderKeys(options.vault), {
    assistantNameAr: config.assistantNameAr,
    familyTitle: config.familyMemberTitle,
    projects: config.watchedProjects,
    projectReports: reports,
    memoryCount: memories.length,
  });

  const history = sanitizeHistory(options.history);
  const messages: ChatTurn[] = [...history, { role: 'user', content: redactSecrets(question).text }];
  const result = await runProvidersWithFallback(
    providers,
    {
      system: buildAssistantSystemPrompt(mode, config, reports, memories, mode === 'commander' ? readCommanderProfile(config) : ''),
      messages,
      question,
      mode,
      signal: options.signal,
    },
    { onDelta: options.onDelta, onReset: options.onReset }
  );

  logSystemInfo('Assistant', `أجاب المزوّد (${result.providerUsed}) في وضع (${mode}).`);
  return {
    answerAr: result.text,
    providerUsed: result.providerUsed,
    model: result.model,
    referencedProjects: config.watchedProjects.map((p) => p.name),
    attempts: result.attempts,
  };
}
