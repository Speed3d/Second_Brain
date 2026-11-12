/**
 * ============================================================================
 * الملف: src/shared/secret-redaction.ts
 * القسم: Shared (الدوال المساعدة المشتركة)
 * Hint بالعربي: تنقية النصوص من الأسرار قبل حفظها في Obsidian أو إرسالها لأي ذكاء اصطناعي سحابي:
 *               مفاتيح API المعروفة، المفاتيح الخاصة، رموز JWT، كلمات المرور داخل روابط قواعد البيانات،
 *               قيم المتغيرات السرية (PASSWORD=... / API_KEY: ...)، ومفاتيح الطوارئ الخاصة بالبرنامج.
 * ============================================================================
 */

const PLACEHOLDER = '[🔒 محذوف لأنه سر]';

/** أنماط الأسرار: كل نمط يُستبدل بالكامل أو يُبقي جزءه الأول (اسم المتغير مثلاً) */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; keepGroup?: number }> = [
  { name: 'private_key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_style_key', regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'google_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'slack_token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'emergency_key', regex: /\bSB-(?:[0-9A-Fa-f]{4}[- ]){8}[0-9A-Fa-f]{4}\b/g },
  { name: 'url_password', regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, keepGroup: -1 },
  {
    name: 'secret_assignment',
    regex: /(\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s"'`,;]{4,}/gi,
    keepGroup: 1,
  },
];

/**
 * Hint بالعربي: دالة تنقية نص من الأسرار. المخرجات: النص الآمن وعدد الأسرار التي حُذفت.
 */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.regex, (...args: unknown[]) => {
      redactions++;
      if (pattern.keepGroup === -1) return `${String(args[1])}${PLACEHOLDER}${String(args[2])}`;
      if (pattern.keepGroup) return `${String(args[pattern.keepGroup])}${PLACEHOLDER}`;
      return PLACEHOLDER;
    });
  }
  return { text: out, redactions };
}
