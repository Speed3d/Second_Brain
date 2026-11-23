/**
 * ============================================================================
 * الملف: src/features/knowledge/extraction-service.ts
 * القسم: Features -> Knowledge (الاستخراج بالذكاء وكشف التعارض، الإصدار 4.0.2)
 * Hint بالعربي: يقرأ الذكاء المحادثات المؤرشفة ومحادثات المساعد، فيقترح منها القرارات والحقائق والمهام،
 *               ويكشف القرار الذي يستبدل قراراً أقدم في المشروع نفسه. **كل الناتج اقتراحات** في قائمة المراجعة،
 *               لا يدخل المعرفة شيء دون موافقة القائد (docs/11). قرارا القائد (docs/12، 4.0.2):
 *               - بزر يدوي، والمزوّد بترتيب المساعد افتراضياً مع اختيار يُغيَّر في أي وقت (يُحفظ لكل جهاز).
 *               المصدر الذي استُخرج منه تحمل عقدة محادثته بصمة محتواه، فلا يُقرأ ثانية ما لم يتغيّر.
 *               النص يُنقّى من الأسرار ويُوسم بيانات غير موثوقة، والرد JSON صارم يُتحقق من كل عنصر فيه.
 * ============================================================================
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AIProviderId, SystemBrandingConfig } from '../../shared/types.ts';
import { loadSystemConfig, readRawSettings, updateSystemSettings } from '../../core/config-manager.ts';
import { redactSecrets } from '../../shared/secret-redaction.ts';
import { UNTRUSTED_RULE_AR, wrapUntrusted } from '../assistant/untrusted-content.ts';
import { buildProviderById, buildProviders, resolveProviderKeys, runProvidersWithFallback } from '../assistant/providers/provider-registry.ts';
import type { AIProvider } from '../assistant/providers/provider-types.ts';
import { getConversation, listConversations } from '../conversations/conversation-store.ts';
import type { UnlockedVault } from '../vault/vault-manager.ts';
import { getProjectFolderName } from '../project-indexer/obsidian-sync.ts';
import { normalizeForSearch } from './knowledge-query.ts';
import { readKnowledgeGraph, resolveKnowledgeDir, writeNode, writeReviewItem, type KnowledgeGraph } from './knowledge-store.ts';
import { edgeIdFor, validateEdge, validateNode, type KnowledgeEdge, type KnowledgeNode, type KnowledgeSource } from './knowledge-types.ts';

/** أقصى عناصر يقترحها مصدر واحد */
export const MAX_ITEMS_PER_SOURCE = 8;
/** ما يُرسل من المصدر: أوله وآخره (القرارات غالباً في آخر المحادثة) */
const HEAD_CHARS = 4000;
const TAIL_CHARS = 20000;

/** مصدر واحد للاستخراج */
export interface ExtractionSource {
  /** مرجع ثابت: obs:<مسار نسبي في Obsidian> أو chat:<معرّف محادثة المساعد> */
  ref: string;
  kind: 'obs' | 'chat';
  title: string;
  projectId: string | null;
  source: KnowledgeSource;
  createdAt: string;
  contentHash: string;
  /** new = لم يُستخرج منه، changed = تغيّر بعد الاستخراج، done = لا جديد */
  status: 'new' | 'changed' | 'done';
}

/** عنصر يقترحه الذكاء بعد التحقق */
export interface ExtractedItem {
  type: 'decision' | 'fact' | 'task';
  title: string;
  body: string;
  confidence: 'confirmed' | 'likely' | 'uncertain';
  supersedes: string | null;
  reason: string;
}

const h = (text: string, n: number): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, n);

/** معرّف عقدة محادثة المصدر (علامة «استُخرج منه») */
export function sourceConversationId(ref: string): string {
  return `K-CONV-SRC-${h(ref, 20)}`;
}

/**
 * Hint بالعربي: دالة سرد المصادر وحالتها. المحادثات المؤرشفة من Obsidian (عدا سجلات الذاكرة MEM-* لأنها
 *               مسجّلة أصلاً)، ومحادثات المساعد بوضع القائد إن أُعطيت جلسته.
 */
export function listExtractionSources(
  kk: Buffer,
  options: { vault?: UnlockedVault | null; config?: SystemBrandingConfig; dir?: string } = {}
): ExtractionSource[] {
  const config = options.config ?? loadSystemConfig();
  const graph = readKnowledgeGraph(kk, options.dir ?? resolveKnowledgeDir());
  const out: ExtractionSource[] = [];
  const status = (ref: string, contentHash: string): ExtractionSource['status'] => {
    const marker = graph.nodes.get(sourceConversationId(ref));
    if (!marker) return 'new';
    return marker.origin?.contentHash === contentHash ? 'done' : 'changed';
  };
  const obsidian = config.paths.obsidianVaultDir;
  const projectsDir = path.join(obsidian, '02-Projects');
  const projectByFolder = new Map<string, string>();
  for (const p of config.watchedProjects) projectByFolder.set(getProjectFolderName(p), p.id);
  const addFile = (file: string, projectId: string | null): void => {
    const name = path.basename(file);
    if (!name.endsWith('.md') || name.startsWith('MEM-')) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text.trim().length < 200) return;
    const ref = `obs:${path.relative(obsidian, file).replace(/\\/g, '/')}`;
    const contentHash = h(text, 32);
    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? name.replace(/\.md$/, '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    const source: KnowledgeSource = /antigravity/i.test(file) || /antigravity/i.test(text.slice(0, 600)) ? 'antigravity-gemini' : 'claude-code';
    out.push({ ref, kind: 'obs', title, projectId, source, createdAt: fs.statSync(file).mtime.toISOString(), contentHash, status: status(ref, contentHash) });
  };
  if (fs.existsSync(projectsDir)) {
    for (const folder of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, folder, 'AI-Conversations');
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) addFile(path.join(dir, name), projectByFolder.get(folder) ?? folder);
    }
  }
  const shared = path.join(obsidian, '03-AI-Shared-Memory');
  if (fs.existsSync(shared)) {
    for (const folder of fs.readdirSync(shared)) {
      if (!folder.endsWith('-Sessions')) continue;
      const dir = path.join(shared, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) addFile(path.join(dir, name), null);
    }
  }
  if (options.vault && options.vault.unlockedBy === 'commander') {
    for (const c of listConversations(options.vault, 'commander')) {
      const text = chatText(options.vault, c.id);
      if (!text || text.length < 200) continue;
      const ref = `chat:${c.id}`;
      const contentHash = h(text, 32);
      out.push({ ref, kind: 'chat', title: c.title, projectId: null, source: 'second-brain-assistant', createdAt: c.createdAt, contentHash, status: status(ref, contentHash) });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function chatText(vault: UnlockedVault, id: string): string | null {
  try {
    const conv = getConversation(vault, id);
    if (!conv) return null;
    return conv.messages.map((m) => `${m.role === 'user' ? 'القائد' : 'المساعد'}: ${m.content}`).join('\n\n');
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: دالة قراءة نص المصدر (بلا تنقية؛ التنقية في buildExtractionRequest).
 */
export function readSourceText(src: ExtractionSource, options: { vault?: UnlockedVault | null; config?: SystemBrandingConfig } = {}): string | null {
  if (src.kind === 'chat') return options.vault ? chatText(options.vault, src.ref.slice('chat:'.length)) : null;
  const config = options.config ?? loadSystemConfig();
  const file = path.resolve(config.paths.obsidianVaultDir, src.ref.slice('obs:'.length));
  if (!file.startsWith(path.resolve(config.paths.obsidianVaultDir) + path.sep)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Hint بالعربي: دالة بناء طلب الاستخراج: تعليمات صارمة، والقرارات السارية في المشروع (لكشف التعارض)،
 *               ونص المصدر منقّى من الأسرار وموسوماً بيانات غير موثوقة، ومقصوصاً من أوله وآخره.
 */
export function buildExtractionRequest(src: ExtractionSource, text: string, activeDecisions: KnowledgeNode[]): { system: string; user: string } {
  const clean = redactSecrets(text).text;
  const cut = clean.length > HEAD_CHARS + TAIL_CHARS ? `${clean.slice(0, HEAD_CHARS)}\n\n…(حُذف الوسط)…\n\n${clean.slice(-TAIL_CHARS)}` : clean;
  const system = `أنت تستخرج المعرفة من محادثة عمل برمجية للقائد، لتُعرض عليه اقتراحاتٍ يعتمدها أو يرفضها.
أعد JSON فقط، بلا أي نص قبله أو بعده، بهذا الشكل:
{"items":[{"type":"decision","title":"…","body":"…","confidence":"confirmed","supersedes":null,"reason":"…"}]}
- type: «decision» لقرار اتُّخذ فعلاً، و«fact» لحقيقة ثابتة مهمة عن المشروع، و«task» لمهمة اتُّفق على تنفيذها ولم تُنجز.
- لا تستخرج اقتراحاً لم يُتفق عليه، ولا تفاصيل عابرة، ولا ما هو مذكور في قائمة القرارات السارية أدناه بالمعنى نفسه.
- title سطر واحد بالعربية لا يزيد عن 120 حرفاً، و body جملة أو جملتان توضّحان السبب أو السياق.
- confidence: «confirmed» إن كان صريحاً، و«likely» إن كان مفهوماً، و«uncertain» إن كان محتملاً.
- supersedes: معرّف قرار من قائمة القرارات السارية إن كان القرار الجديد يلغيه أو يغيّره صراحة، وإلا null. لا تخترع معرّفاً.
- reason: أين ورد في المحادثة باختصار.
- أقصى ${MAX_ITEMS_PER_SOURCE} عناصر، والأهم أولاً. وإن لم يوجد شيء فأعد {"items":[]}.
- لا تكتب أي كلمة مرور أو مفتاح أو رمز.
${UNTRUSTED_RULE_AR}`;
  const decisions = activeDecisions.length
    ? activeDecisions.slice(0, 40).map((d) => `- ${d.id}: ${d.title}`).join('\n')
    : '(لا قرارات سارية بعد)';
  const user = `المشروع: ${src.projectId ?? 'غير محدد'}\nعنوان المحادثة: ${src.title}\n\nالقرارات السارية في المشروع (للمقارنة وكشف الاستبدال):\n${decisions}\n\n${wrapUntrusted(src.ref, cut, HEAD_CHARS + TAIL_CHARS + 200)}`;
  return { system, user };
}

/**
 * Hint بالعربي: دالة قراءة رد الذكاء والتحقق من كل عنصر. العنصر غير الصالح يُسقط وحده، و supersedes
 *               خارج القائمة المعطاة يُلغى (لا يُربط قرار بعقدة لم نعرضها). ترمي إن لم يكن الرد JSON أصلاً.
 */
export function parseExtractionReply(text: string, allowedSupersedeIds: Set<string>): ExtractedItem[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('رد الذكاء ليس JSON.');
  const parsed = JSON.parse(text.slice(start, end + 1)) as { items?: unknown };
  if (!Array.isArray(parsed.items)) throw new Error('رد الذكاء بلا قائمة items.');
  const out: ExtractedItem[] = [];
  for (const raw of parsed.items.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (v.type !== 'decision' && v.type !== 'fact' && v.type !== 'task') continue;
    const title = typeof v.title === 'string' ? redactSecrets(v.title.replace(/\s+/g, ' ').trim()).text.slice(0, 200) : '';
    if (title.length < 3) continue;
    const body = typeof v.body === 'string' ? redactSecrets(v.body.trim()).text.slice(0, 2000) : '';
    const confidence = v.confidence === 'confirmed' || v.confidence === 'likely' || v.confidence === 'uncertain' ? v.confidence : 'likely';
    const supersedes = v.type === 'decision' && typeof v.supersedes === 'string' && allowedSupersedeIds.has(v.supersedes) ? v.supersedes : null;
    const reason = typeof v.reason === 'string' ? redactSecrets(v.reason.trim()).text.slice(0, 500) : '';
    out.push({ type: v.type, title, body: body || title, confidence, supersedes, reason });
  }
  return out;
}

/** القرارات السارية في مشروع المصدر (لكشف التعارض) */
export function activeDecisionsFor(graph: KnowledgeGraph, projectId: string | null): KnowledgeNode[] {
  return [...graph.nodes.values()]
    .filter((n) => n.type === 'decision' && n.status === 'active' && (n.projectId ?? null) === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** نتيجة تطبيق مصدر */
export interface ApplyResult {
  proposals: number;
  duplicates: number;
  conflicts: number;
}

/**
 * Hint بالعربي: دالة كتابة نتيجة مصدر: عقدة المحادثة (علامة الاستخراج ببصمة المحتوى) مباشرة،
 *               وكل عنصر اقتراحاً في قائمة المراجعة مع علاقته بالمحادثة، وعلاقة «استبدل القرار» إن وُجدت.
 *               المكرر (العنوان نفسه في المشروع نفسه، عقدةً أو اقتراحاً بأي حالة) لا يُقترح.
 */
export function applyExtraction(kk: Buffer, src: ExtractionSource, items: ExtractedItem[], dir: string = resolveKnowledgeDir(), now: Date = new Date()): ApplyResult {
  const graph = readKnowledgeGraph(kk, dir);
  const convId = sourceConversationId(src.ref);
  const result: ApplyResult = { proposals: 0, duplicates: 0, conflicts: 0 };
  const sameProject = (p: string | null): boolean => (p ?? null) === src.projectId;
  const seen = new Set<string>();
  for (const n of graph.nodes.values()) if (sameProject(n.projectId)) seen.add(normalizeForSearch(n.title));
  for (const r of graph.reviews.values()) if (sameProject(r.proposal.node.projectId)) seen.add(normalizeForSearch(r.proposal.node.title));
  const iso = now.toISOString();
  const c8 = src.contentHash.slice(0, 8);
  const h20 = convId.slice('K-CONV-SRC-'.length);
  items.forEach((item, i) => {
    const key = normalizeForSearch(item.title);
    if (seen.has(key)) {
      result.duplicates += 1;
      return;
    }
    seen.add(key);
    const node: KnowledgeNode = validateNode({
      id: `K-EXT-${h20}-${c8}-${i + 1}`,
      type: item.type,
      title: item.title.slice(0, 300),
      body: item.body,
      projectId: src.projectId,
      source: src.source,
      status: 'active',
      confidence: item.confidence,
      createdAt: iso,
      updatedAt: iso,
      origin: { sourceRef: src.ref.slice(0, 600) },
    });
    const edges: KnowledgeEdge[] = [validateEdge({ id: edgeIdFor(item.type === 'decision' ? 'decided_in' : 'related_to', node.id, convId), type: item.type === 'decision' ? 'decided_in' : 'related_to', from: node.id, to: convId, createdAt: iso })];
    if (item.supersedes && graph.nodes.has(item.supersedes)) {
      edges.push(validateEdge({ id: edgeIdFor('supersedes', node.id, item.supersedes), type: 'supersedes', from: node.id, to: item.supersedes, createdAt: iso }));
      result.conflicts += 1;
    }
    const oldTitle = item.supersedes ? graph.nodes.get(item.supersedes)?.title : undefined;
    writeReviewItem(
      kk,
      {
        id: `R-EXT-${h20}-${c8}-${i + 1}`,
        proposal: { node, edges },
        reasonAr: `استُخرج من «${src.title.slice(0, 120)}»${item.reason ? `: ${item.reason}` : ''}${oldTitle ? ` ⚠️ يستبدل القرار «${oldTitle.slice(0, 120)}»` : ''}`.slice(0, 2000),
        createdAt: iso,
        status: 'pending',
      },
      dir
    );
    result.proposals += 1;
  });
  // العلامة أخيراً: إن فشل شيء قبلها يُعاد المصدر في المرة التالية
  writeNode(
    kk,
    {
      id: convId,
      type: 'conversation',
      title: src.title.slice(0, 300) || 'محادثة',
      body: `محادثة ${src.kind === 'chat' ? 'مع المساعد' : 'مؤرشفة'}: ${src.ref.slice(0, 500)}`,
      projectId: src.projectId,
      source: src.source,
      status: 'active',
      confidence: 'confirmed',
      createdAt: graph.nodes.get(convId)?.createdAt ?? src.createdAt,
      updatedAt: iso,
      origin: { sourceRef: src.ref.slice(0, 600), contentHash: src.contentHash },
    },
    dir
  );
  return result;
}

// ===================== اختيار المزوّد (قرار القائد: ظاهر ويُغيَّر في أي وقت) =====================

/** auto = ترتيب المساعد في الإعدادات، أو مزوّد واحد بعينه */
export type ExtractionProviderChoice = 'auto' | Exclude<AIProviderId, 'local'>;
const CHOICES: ExtractionProviderChoice[] = ['auto', 'claude-cli', 'claude', 'gemini', 'ollama'];

/**
 * Hint بالعربي: اختيار مزوّد الاستخراج على هذا الجهاز (الافتراضي auto).
 */
export function getExtractionProviderChoice(): ExtractionProviderChoice {
  try {
    const raw = readRawSettings() as { knowledge?: { extractionProvider?: unknown } };
    const v = raw.knowledge?.extractionProvider;
    return CHOICES.includes(v as ExtractionProviderChoice) ? (v as ExtractionProviderChoice) : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Hint بالعربي: حفظ اختيار مزوّد الاستخراج على هذا الجهاز.
 */
export function setExtractionProviderChoice(choice: string): ExtractionProviderChoice {
  if (!CHOICES.includes(choice as ExtractionProviderChoice)) throw new Error('مزوّد الاستخراج غير معروف.');
  const raw = readRawSettings() as { knowledge?: Record<string, unknown> };
  updateSystemSettings({ knowledge: { ...(raw.knowledge ?? {}), extractionProvider: choice } });
  return choice as ExtractionProviderChoice;
}

/**
 * Hint بالعربي: قائمة المزوّدين لهذا الاختيار (بلا «المعرفة المحلية» لأنها لا تفهم النص).
 */
export function resolveExtractionProviders(choice: ExtractionProviderChoice, vault?: UnlockedVault | null, config: SystemBrandingConfig = loadSystemConfig()): AIProvider[] {
  const keys = resolveProviderKeys(vault);
  const ctx = { assistantNameAr: config.assistantNameAr, familyTitle: config.familyMemberTitle, projects: [], projectReports: [], memoryCount: 0 };
  if (choice === 'auto') return buildProviders(config, keys, ctx).filter((p) => p.id !== 'local');
  return [buildProviderById(choice, config, keys, ctx)];
}

// ===================== المهمة في الخلفية =====================

/** حالة مهمة الاستخراج (للواجهة) */
export interface ExtractionJobState {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  proposals: number;
  duplicates: number;
  conflicts: number;
  errors: Array<{ title: string; messageAr: string }>;
  providerUsed: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelled: boolean;
}

const idle = (): ExtractionJobState => ({ running: false, total: 0, done: 0, current: null, proposals: 0, duplicates: 0, conflicts: 0, errors: [], providerUsed: null, startedAt: null, finishedAt: null, cancelled: false });
let job: ExtractionJobState = idle();
let jobAbort: AbortController | null = null;

/** حالة المهمة الحالية أو الأخيرة */
export function getExtractionJob(): ExtractionJobState {
  return { ...job, errors: [...job.errors] };
}

/** إلغاء المهمة الجارية (يكمل المصدر الحالي ثم يتوقف) */
export function cancelExtractionJob(): boolean {
  if (!job.running || !jobAbort) return false;
  jobAbort.abort();
  return true;
}

/** للاختبارات فقط */
export function resetExtractionJobForTests(): void {
  jobAbort?.abort();
  job = idle();
  jobAbort = null;
}

/** دالة المحادثة مع المزوّد (تُحقن في الاختبارات) */
export type ExtractionChat = (system: string, user: string, signal: AbortSignal) => Promise<{ text: string; providerUsed: string }>;

/**
 * Hint بالعربي: دالة بدء مهمة الاستخراج على المصادر الجديدة والمتغيّرة، واحداً واحداً.
 *               تتوقف عند الإلغاء أو إن لم تعد الجلسة صالحة (isActive). الفشل في مصدر يُسجَّل ولا يوقف الباقي،
 *               والمصدر الفاشل لا تُكتب علامته فيُعاد في المرة التالية. المخرجات: الحالة الأولى (المهمة تكمل وحدها).
 */
export function startExtractionJob(options: {
  kk: Buffer;
  vault?: UnlockedVault | null;
  sources: ExtractionSource[];
  chat: ExtractionChat;
  isActive?: () => boolean;
  dir?: string;
  config?: SystemBrandingConfig;
  limit?: number;
}): { state: ExtractionJobState; finished: Promise<ExtractionJobState> } {
  if (job.running) throw new Error('الاستخراج يعمل الآن. انتظر حتى ينتهي أو ألغِه.');
  const todo = options.sources.filter((s) => s.status !== 'done').slice(0, Math.max(1, Math.min(options.limit ?? 50, 200)));
  job = { ...idle(), running: true, total: todo.length, startedAt: new Date().toISOString() };
  jobAbort = new AbortController();
  const signal = jobAbort.signal;
  const dir = options.dir ?? resolveKnowledgeDir();
  const finished = (async () => {
    let consecutiveErrors = 0;
    try {
      for (const src of todo) {
        // ثلاثة أخطاء متتالية (لا مزوّد متاح مثلاً): التوقف أوفر من استهلاك الحصة على كل مصدر
        if (consecutiveErrors >= 3) {
          job.errors.push({ title: '—', messageAr: 'توقف الاستخراج بعد ثلاثة أخطاء متتالية. تحقّق من المزوّد ثم أعد المحاولة.' });
          break;
        }
        if (signal.aborted || (options.isActive && !options.isActive())) {
          job.cancelled = true;
          break;
        }
        job.current = src.title;
        try {
          const text = readSourceText(src, { vault: options.vault, config: options.config });
          if (!text) throw new Error('تعذّرت قراءة المصدر.');
          const graph = readKnowledgeGraph(options.kk, dir);
          const decisions = activeDecisionsFor(graph, src.projectId);
          const req = buildExtractionRequest(src, text, decisions);
          const reply = await options.chat(req.system, req.user, signal);
          job.providerUsed = reply.providerUsed;
          const items = parseExtractionReply(reply.text, new Set(decisions.slice(0, 40).map((d) => d.id)));
          const r = applyExtraction(options.kk, src, items, dir);
          job.proposals += r.proposals;
          job.duplicates += r.duplicates;
          job.conflicts += r.conflicts;
          consecutiveErrors = 0;
        } catch (err) {
          if (signal.aborted) {
            job.cancelled = true;
            break;
          }
          consecutiveErrors += 1;
          job.errors.push({ title: src.title.slice(0, 120), messageAr: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
        }
        job.done += 1;
      }
    } finally {
      job.running = false;
      job.current = null;
      job.finishedAt = new Date().toISOString();
      jobAbort = null;
    }
    return getExtractionJob();
  })();
  return { state: getExtractionJob(), finished };
}

/**
 * Hint بالعربي: دالة المحادثة الحقيقية مع المزوّدين (بترتيبها حتى ينجح أحدها).
 */
export function providerChat(providers: AIProvider[]): ExtractionChat {
  return async (system, user, signal) => {
    if (!providers.length) throw new Error('لا يوجد مزوّد ذكاء متاح للاستخراج. اختر مزوّداً آخر، أو افتح الخزنة لمفاتيح API، أو شغّل Ollama.');
    const r = await runProvidersWithFallback(providers, { system, messages: [{ role: 'user', content: user }], question: 'استخراج المعرفة', mode: 'commander', maxOutputTokens: 3000, signal });
    return { text: r.text, providerUsed: r.providerUsed };
  };
}
