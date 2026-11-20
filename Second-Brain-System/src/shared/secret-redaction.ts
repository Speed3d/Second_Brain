/**
 * ============================================================================
 * الملف: src/shared/secret-redaction.ts
 * القسم: Shared (الدوال المساعدة المشتركة)
 * Hint بالعربي: تنقية النصوص من الأسرار قبل حفظها في Obsidian أو السجلات أو إرسالها لأي ذكاء اصطناعي سحابي:
 *               - مفاتيح وخدمات معروفة البادئة: Anthropic و OpenAI و Google و GitHub و GitLab و npm و Hugging Face
 *                 و Slack و AWS و Stripe و SendGrid و Google OAuth و Telegram و JWT ورموز نفق Cloudflare،
 *                 وروابط Webhook (Slack و Discord)، ومفتاح الطوارئ الخاص بالبرنامج.
 *               - المفاتيح الخاصة PEM (كاملة، أو مقطوعة بلا سطر النهاية).
 *               - كلمات المرور في روابط قواعد البيانات (ومنها بلا اسم مستخدم: redis://:pass@)، وسلاسل ODBC/ADO
 *                 (Password= و Pwd=)، و Azure (AccountKey=)، وترويسات Authorization: Bearer/Basic، و cloudflared --token.
 *               - الإسناد: PASSWORD=... و "api_key": "..." (JSON، ومنه JSON المهرَّب داخل نص) والقيمة بين علامتي تنصيص
 *                 ولو فيها مسافات، وأسطر .env بأسماء كبيرة (…_KEY و …_SECRET و …_TOKEN و …_DSN…)، وبالعربية «كلمة المرور: …».
 *               - السرّ المعروف البادئة إذا انقسم على سطرين (التفاف السجل) يُحذف بجزأيه (split_prefixed_token، 3.9.0، ISS-044).
 *               حدود صادقة: سرّ بلا بادئة معروفة وبلا اسم يدل عليه (نص عشوائي وحده) لا يمكن تمييزه عن نص عادي.
 * ============================================================================
 */

const PLACEHOLDER = '[🔒 محذوف لأنه سر]';

/** أسماء المتغيرات التي تدل قيمتها على سرّ */
const SECRET_NAME = String.raw`[A-Za-z0-9_.\-]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|ACCOUNT_?KEY|CLIENT_?SECRET|AUTH_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY)[A-Za-z0-9_]*`;

/**
 * قيم ليست أسراراً، لتقليل الحذف الخاطئ في الكود المؤرشف (3.9.0):
 * - أنواع: string و Buffer و Uint8Array…
 * - تعبير كود: اسم يتبعه . أو ( أو [ أو ! أو ? أو ; أو , أو نهاية السطر أو } أو ) (مثل body.apiKey و crypto.randomBytes(…)
 *   و secretValue, و token;). القيمة السرية الحقيقية بلا تنصيص فيها أرقام أو رموز غالباً، فتبقى تُحذف.
 */
const NOT_A_VALUE = String.raw`(?!(?:string|number|boolean|null|undefined|true|false|none|required|optional|any|str|bool|int|Buffer|Uint8Array|Date|Record|Array|Promise|Set|Map|object|unknown|never|void)\b)(?![A-Za-z_$][A-Za-z_$]*(?:[.(\[!?;,)}]|\s*(?:\?\?|===?|!==?|\|\||&&|=>)))(?!\$\{)`;

/** الإسناد لا المقارنة ولا السهم: = وحده أو : (لا == ولا => ولا ::) */
const ASSIGN = String.raw`\s*(?:=(?![=>])|:(?!:))\s*`;

type Replacer = (match: string, groups: string[]) => string;

interface SecretPattern {
  name: string;
  regex: RegExp;
  /** الافتراضي: يُستبدل التطابق كله */
  replace?: Replacer;
}

/** يُبقي المجموعة الأولى (اسم المتغير أو البادئة) ويحذف الباقي */
const keepFirst: Replacer = (_m, g) => `${g[0]}${PLACEHOLDER}`;

/** أنماط الأسرار بالترتيب: المحدد أولاً، ثم الإسناد العام */
const SECRET_PATTERNS: SecretPattern[] = [
  // --- المفاتيح الخاصة ---
  { name: 'private_key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'private_key_truncated', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\n|\r?\n|[ \t])*(?:[A-Za-z0-9+/=]{16,}(?:\\n|\r?\n|[ \t])*)*/g },

  // --- رمز معروف البادئة انقسم مبكراً (جزؤه الأول أقصر من حدّ نمطه) وبقيته في السطر التالي ---
  {
    name: 'split_prefixed_token',
    regex: /\b(?:sk-ant-|sk-proj-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|npm_|hf_|AIza|GOCSPX-|xox[abprs]-|(?:sk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9_-]{4,}\r?\n[ \t]*[A-Za-z0-9_-]{8,}(?=[ \t]*(?:\r?\n|$))|\beyJ[A-Za-z0-9_.-]{10,}\r?\n[ \t]*[A-Za-z0-9_.-]{8,}(?=[ \t]*(?:\r?\n|$))/g,
  },
  // --- رموز معروفة البادئة ---
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: 'openai_style_key', regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{32,}/g },
  { name: 'google_key', regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: 'google_oauth_secret', regex: /\bGOCSPX-[A-Za-z0-9_\-]{20,}/g },
  { name: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'gitlab_token', regex: /\bglpat-[A-Za-z0-9_\-]{20,}/g },
  { name: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'huggingface_token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'slack_token', regex: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b|\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { name: 'sendgrid_key', regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: 'telegram_bot_token', regex: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g },
  { name: 'cloudflare_tunnel_token', regex: /\beyJhIjoi[A-Za-z0-9+\/_\-]{40,}={0,2}/g },
  { name: 'emergency_key', regex: /\bSB-(?:[0-9A-Fa-f]{4}[- ]){8}[0-9A-Fa-f]{4}\b/g },

  // --- روابط وترويسات ---
  { name: 'slack_webhook', regex: /(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g, replace: keepFirst },
  { name: 'discord_webhook', regex: /(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g, replace: keepFirst },
  { name: 'url_password', regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(@)/gi, replace: (_m, g) => `${g[0]}${PLACEHOLDER}${g[1]}` },
  { name: 'authorization_header', regex: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, replace: keepFirst },
  { name: 'cli_token_flag', regex: /(--token(?:=|[ \t]+))[A-Za-z0-9+/_.=-]{20,}/g, replace: keepFirst },
  { name: 'connection_string_password', regex: /((?:^|[;\s])(?:Pwd|AccountKey|SharedAccessKey)\s*=\s*)[^;\r\n]{3,}/gim, replace: keepFirst },

  // --- بالعربية: «كلمة المرور: …» ---
  {
    name: 'arabic_password',
    regex: /((?:كلمة\s+(?:ال)?(?:مرور|سرّ|سر)|(?:ال)?رمز\s+(?:ال)?سري|(?:ال)?رقم\s+(?:ال)?سري)(?:\s+[^\s:=]{1,20})?\s*[:=]\s*["'«]?)(?=[^\s"'»،,;]*[A-Za-z0-9])[^\s"'»،,;=]{4,}/g,
    replace: keepFirst,
  },

  // --- الإسناد بين علامتي تنصيص (JSON، و JSON المهرَّب، والقيمة فيها مسافات) ---
  {
    name: 'secret_assignment_quoted',
    regex: new RegExp(String.raw`(\b${SECRET_NAME}\\?["']?${ASSIGN})(\\?["'])((?:(?!\2)[^\r\n]){4,500}?)\2`, 'gi'),
    // قيمة فيها حروف عربية نصٌّ للواجهة لا سرّ
    replace: (m, g) => (g[2].includes(PLACEHOLDER) || /[\u0600-\u06FF]/.test(g[2]) ? m : `${g[0]}${g[1]}${PLACEHOLDER}${g[1]}`),
  },
  // --- الإسناد بلا تنصيص ---
  {
    name: 'secret_assignment',
    regex: new RegExp(String.raw`(\b${SECRET_NAME}\\?["']?${ASSIGN})(?!\\?["'])(?!\[🔒)${NOT_A_VALUE}[^\s"'\x60,;]{4,}`, 'gi'),
    replace: keepFirst,
  },
  // --- أسطر .env بأسماء كبيرة (…_KEY و …_DSN و …_WEBHOOK…) ---
  {
    name: 'env_line',
    regex: /^([ \t]*(?:export[ \t]+)?(?:[A-Z][A-Z0-9_]*_)?(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PWD|AUTH|CREDENTIALS?|SALT|DSN|WEBHOOK(?:_URL)?|PRIVATE)(?:_[A-Z0-9_]*)?[ \t]*=[ \t]*)(["']?)([^\r\n]{4,}?)\2[ \t]*$/gm,
    replace: (m, g) => (g[2].includes(PLACEHOLDER) ? m : `${g[0]}${g[1]}${PLACEHOLDER}${g[1]}`),
  },
];

/** أسماء الأنماط (للاختبارات والتوثيق) */
export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

/**
 * Hint بالعربي: دالة تنقية نص من الأسرار. المخرجات: النص الآمن وعدد الأسرار التي حُذفت.
 */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.regex, (...args: unknown[]) => {
      const match = String(args[0]);
      const groups: string[] = [];
      for (let i = 1; i < args.length && typeof args[i] !== 'number'; i++) groups.push(args[i] === undefined ? '' : String(args[i]));
      const replaced = pattern.replace ? pattern.replace(match, groups) : PLACEHOLDER;
      if (replaced !== match) redactions++;
      return replaced;
    });
  }
  return { text: out, redactions };
}
