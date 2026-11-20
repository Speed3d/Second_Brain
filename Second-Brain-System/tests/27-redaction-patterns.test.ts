/**
 * ============================================================================
 * الملف: tests/27-redaction-patterns.test.ts
 * القسم: Tests (الاختبارات الدائمة الموثقة — القانون الثامن)
 * Hint بالعربي: اختبارات أنماط التنقيح الجديدة وحالات الفشل الصعبة (الإصدار 3.9.0، المرحلة 2.7 من docs/12، ISS-044):
 *               - كل نمط جديد: رموز Cloudflare، وسلاسل اتصال قواعد البيانات (redis بلا مستخدم، و ODBC، و Azure)،
 *                 وأسطر .env، و Bearer، و GitLab و npm و Hugging Face و SendGrid و Google OAuth و Telegram و Webhooks،
 *                 و «كلمة المرور: …» بالعربية. السرّ يُحذف، والسياق (اسم المتغير) يبقى.
 *               - الحالات الصعبة: سرّ مقسوم على سطرين، وداخل JSON (عادي، ومهرَّب داخل نص، وموزّع على أسطر)،
 *                 وداخل كتلة كود، وقيمة بين تنصيص فيها مسافات، ومفتاح PEM مقطوع، و PEM داخل JSON.
 *               - الحذف الخاطئ: سطور كود ونص عادية لا تتغيّر (body.apiKey، و crypto.randomBytes، و ===، والأنواع، ونص الواجهة).
 *               - صياغة الأعداد بالعربية (countAr).
 *               - من الطرف إلى الطرف: الذاكرة المشتركة و runtime.log لا يحفظان سرّاً داخل JSON.
 *               الجزء الخالص (runRedactionPatternChecks) يعمل بلا بيئة، ويُستعمل في اختبار الطفرات.
 * ============================================================================
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSystemConfig } from '../src/core/config-manager.ts';
import { logSystemInfo } from '../src/core/logger.ts';
import { querySharedAIMemory, recordSharedAIMemory } from '../src/features/ai-memory/shared-memory-service.ts';
import { AR_COUNT, countAr } from '../src/shared/arabic-count.ts';
import { redactSecrets, SECRET_PATTERN_NAMES } from '../src/shared/secret-redaction.ts';

/** أسرار وهمية بأشكال حقيقية (لا تعمل في أي مكان). تُركَّب من أجزاء حتى لا تطابقها أدوات فحص المستودع */
const j = (...parts: string[]) => parts.join('');
const FAKE = {
  anthropic: j('sk-ant-', 'api03-FAKEfakeFAKEfakeFAKE', 'fake0123456789'),
  github: j('ghp_', 'FAKE0000000000000000', '000000000000000000'),
  cfTunnel: j('eyJhIjoi', 'ZmFrZWFjY291bnQiLCJ0IjoiMTIzNDU2NzgtYWJjZCIsInMiOiJabUZyWlE9PSJ9'),
  cfApiToken: j('FAKEcfApiToken', '0123456789abcdefGHIJ'),
  gitlab: j('glpat-', 'FAKEfake0123456789ab'),
  npm: j('npm_', 'FAKEfake0123456789FAKEfake0123456789'),
  hf: j('hf_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake12'),
  sendgrid: j('SG.', 'FAKEfakeFAKEfakeFAKEfa', '.', 'FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake123'),
  gocspx: j('GOCSPX-', 'FAKEfakeFAKEfakeFAKEfake1234'),
  telegram: j('123456789', ':AA', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake123'),
  bearer: j('FAKEbearer', 'Token0123456789xyz'),
  redisPass: 'FakeRedisPass99',
  odbcPass: 'FakeOdbcPass77',
  azureKey: 'FakeAzureKey0000000000000000==',
  jsonPass: 'FakeJsonPass55',
  spacedPass: 'fake correct horse battery',
  arabicPass: 'FakeArPass31',
  webhook: j('T0000FAKE/B0000FAKE/', 'FAKEfakeFAKEfake1234'),
  jwt: j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiJmYWtlLXVzZXIifQ', '.ZmFrZXNpZ25hdHVyZWZha2U'),
};

function assertRedacted(input: string, secret: string, keep: string[], label: string): string {
  const r = redactSecrets(input);
  assert.ok(!r.text.includes(secret), `${label}: السر لم يُحذف ← ${r.text.slice(0, 160)}`);
  assert.ok(r.redactions >= 1, `${label}: عدد الحذف يُحتسب`);
  for (const k of keep) assert.ok(r.text.includes(k), `${label}: السياق «${k}» يبقى ← ${r.text.slice(0, 160)}`);
  return r.text;
}

/**
 * Hint بالعربي: الفحوص الخالصة (بلا بيئة): الأنماط الجديدة، والحالات الصعبة، والحذف الخاطئ، والأعداد.
 */
export function runRedactionPatternChecks(): string[] {
  const passed: string[] = [];

  // ===================== 1. الأنماط الجديدة =====================
  assertRedacted(`cloudflared service install ${FAKE.cfTunnel}`, FAKE.cfTunnel, ['cloudflared service install'], 'رمز نفق Cloudflare');
  assertRedacted(`cloudflared tunnel run --token ${FAKE.cfTunnel.slice(8)}`, FAKE.cfTunnel.slice(8), ['--token'], 'cloudflared --token');
  assertRedacted(`CLOUDFLARE_API_TOKEN=${FAKE.cfApiToken}`, FAKE.cfApiToken, ['CLOUDFLARE_API_TOKEN='], 'رمز API لـ Cloudflare في .env');
  assertRedacted(`CF-Access-Client-Secret: ${'0123456789abcdef'.repeat(4)}`, '0123456789abcdef'.repeat(4), ['CF-Access-Client-Secret'], 'ترويسة Cloudflare Access');
  assertRedacted(`REDIS_URL=redis://:${FAKE.redisPass}@cache.example.test:6379`, FAKE.redisPass, ['REDIS_URL='], 'redis بلا اسم مستخدم');
  assertRedacted(`mongodb+srv://app:${FAKE.redisPass}@cluster0.example.test/db`, FAKE.redisPass, ['mongodb+srv://app:', '@cluster0'], 'mongodb+srv');
  assertRedacted(`Server=db.example.test;Database=app;User Id=sa;Pwd=${FAKE.odbcPass};Encrypt=yes`, FAKE.odbcPass, ['User Id=sa', 'Pwd=', 'Encrypt=yes'], 'ODBC Pwd=');
  assertRedacted(`Server=db;User ID=sa;Password=${FAKE.odbcPass};`, FAKE.odbcPass, ['Password='], 'ADO Password=');
  assertRedacted(`DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=${FAKE.azureKey};EndpointSuffix=core.windows.net`, FAKE.azureKey, ['AccountName=fake', 'EndpointSuffix'], 'Azure AccountKey');
  assertRedacted(`curl -H "Authorization: Bearer ${FAKE.bearer}" https://api.example.test`, FAKE.bearer, ['Authorization: Bearer', 'https://api.example.test'], 'Bearer');
  for (const [name, value] of [['GitLab', FAKE.gitlab], ['npm', FAKE.npm], ['Hugging Face', FAKE.hf], ['SendGrid', FAKE.sendgrid], ['Google OAuth', FAKE.gocspx], ['Telegram', FAKE.telegram]] as const) {
    assertRedacted(`الرمز هو ${value} انتهى`, value, ['الرمز هو', 'انتهى'], name);
  }
  assertRedacted(`https://hooks.slack.com/services/${FAKE.webhook}`, FAKE.webhook, ['https://hooks.slack.com/services/'], 'Slack webhook');
  assertRedacted(`https://discord.com/api/webhooks/123456789/${FAKE.webhook.replace(/\//g, '')}`, FAKE.webhook.replace(/\//g, ''), ['discord.com/api/webhooks/123456789/'], 'Discord webhook');
  assertRedacted(`كلمة المرور: ${FAKE.arabicPass}`, FAKE.arabicPass, ['كلمة المرور:'], 'بالعربية');
  assertRedacted(`كلمة المرور الجديدة = ${FAKE.arabicPass}`, FAKE.arabicPass, ['كلمة المرور الجديدة'], 'بالعربية مع صفة');
  assertRedacted(`الرمز السري: ${FAKE.arabicPass}`, FAKE.arabicPass, ['الرمز السري'], 'الرمز السري');
  passed.push(`اختبار الأنماط الجديدة (رموز Cloudflare للنفق و --token و API والترويسة، و redis بلا مستخدم، و mongodb+srv، و ODBC/ADO، و Azure، و Bearer، و GitLab و npm و Hugging Face و SendGrid و Google OAuth و Telegram، و Webhooks، و «كلمة المرور:» بالعربية؛ ${SECRET_PATTERN_NAMES.length} نمطاً): السر يُحذف والسياق يبقى بنجاح.`);

  // ===================== 2. أسطر .env =====================
  const env = [
    '# إعدادات',
    'NODE_ENV=production',
    'PORT=4777',
    `DATABASE_URL=postgres://app:${FAKE.jsonPass}@db.example.test/app`,
    `export STRIPE_WEBHOOK_SECRET="${FAKE.cfApiToken}"`,
    `SENTRY_DSN=https://${FAKE.cfApiToken}@o1.ingest.example.test/1`,
    `SIGNING_KEY='${FAKE.redisPass}'`,
    `SESSION_SALT=${FAKE.odbcPass}`,
    `PASSWORD=letmeinplease`,
  ].join('\n');
  const envOut = redactSecrets(env).text;
  for (const s of [FAKE.jsonPass, FAKE.cfApiToken, FAKE.redisPass, FAKE.odbcPass, 'letmeinplease']) assert.ok(!envOut.includes(s), `.env: ${s.slice(0, 6)}… حُذف`);
  for (const k of ['NODE_ENV=production', 'PORT=4777', '# إعدادات', 'STRIPE_WEBHOOK_SECRET=', 'SENTRY_DSN=', 'SIGNING_KEY=', 'SESSION_SALT=']) assert.ok(envOut.includes(k), `.env: «${k}» يبقى`);
  passed.push('اختبار أسطر .env (الأسماء الكبيرة بلواحق KEY و SECRET و TOKEN و DSN و SALT و PASSWORD، و export، والتنصيص): الأسرار تُحذف، والإعدادات العادية والتعليقات تبقى بنجاح.');

  // ===================== 3. الحالات الصعبة =====================
  // 3.1 سرّ مقسوم على سطرين (التفاف السجل)
  const half = Math.floor(FAKE.anthropic.length / 2) + 4;
  const split = assertRedacted(`المفتاح: ${FAKE.anthropic.slice(0, half)}\n${FAKE.anthropic.slice(half)}\nالسطر التالي عادي`, FAKE.anthropic.slice(half), ['المفتاح:', 'السطر التالي عادي'], 'مقسوم على سطرين');
  assert.ok(!split.includes(FAKE.anthropic.slice(0, half)), 'الجزء الأول حُذف أيضاً');
  assertRedacted(`token ${FAKE.github.slice(0, 30)}\r\n   ${FAKE.github.slice(30)}\r\nok`, FAKE.github.slice(30), ['token', 'ok'], 'مقسوم بـ CRLF ومسافة بادئة');
  assertRedacted(`${FAKE.jwt.slice(0, 40)}\n${FAKE.jwt.slice(40)}`, FAKE.jwt.slice(40), [], 'JWT مقسوم');
  // 3.2 داخل JSON
  assertRedacted(`{"user":"admin","password":"${FAKE.jsonPass}","port":5432}`, FAKE.jsonPass, ['"user":"admin"', '"password":"', '"port":5432'], 'JSON مضغوط');
  assertRedacted(`{\n  "db": {\n    "host": "db.example.test",\n    "password": "${FAKE.jsonPass}"\n  }\n}`, FAKE.jsonPass, ['"host": "db.example.test"'], 'JSON موزّع على أسطر');
  assertRedacted(`{"config":"{\\"api_key\\":\\"${FAKE.jsonPass}\\",\\"x\\":1}"}`, FAKE.jsonPass, ['api_key', '\\"x\\":1'], 'JSON مهرَّب داخل نص');
  assertRedacted(`{'client_secret': '${FAKE.jsonPass}'}`, FAKE.jsonPass, ['client_secret'], 'قاموس Python');
  assertRedacted(`{"k":"-----BEGIN PRIVATE KEY-----\\nMIIEvFAKEFAKEFAKEFAKE\\n-----END PRIVATE KEY-----"}`, 'MIIEvFAKEFAKEFAKEFAKE', ['{"k":"'], 'PEM داخل JSON');
  // 3.3 داخل كتلة كود
  const block = [
    'هذا مثال:',
    '```ts',
    `const client = new Anthropic({ apiKey: "${FAKE.anthropic}" });`,
    `const db = 'postgres://app:${FAKE.redisPass}@db/app';`,
    '```',
    '```yaml',
    `password: ${FAKE.odbcPass}`,
    '```',
    '```python',
    `GITHUB_TOKEN = "${FAKE.github}"`,
    '```',
  ].join('\n');
  const blockOut = redactSecrets(block).text;
  for (const s of [FAKE.anthropic, FAKE.redisPass, FAKE.odbcPass, FAKE.github]) assert.ok(!blockOut.includes(s), `كتلة كود: ${s.slice(0, 6)}… حُذف`);
  for (const k of ['```ts', 'new Anthropic', '```yaml', '```python', 'GITHUB_TOKEN']) assert.ok(blockOut.includes(k), `كتلة كود: «${k}» يبقى`);
  // 3.4 قيمة بين تنصيص فيها مسافات
  const spaced = assertRedacted(`DB_PASSWORD="${FAKE.spacedPass}"`, 'battery', ['DB_PASSWORD="'], 'قيمة فيها مسافات');
  assert.ok(!spaced.includes('horse'), 'لا يبقى أي جزء من القيمة');
  // 3.5 مفتاح PEM مقطوع (سجل انقطع قبل سطر النهاية)
  assertRedacted('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAFAKEFAKEFAKEFAKE\nFAKEFAKEFAKEFAKEFAKEFAKEFAKE12\n', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKE12', [], 'PEM مقطوع');
  passed.push('اختبار حالات الفشل الصعبة (سرّ مقسوم على سطرين بـ LF و CRLF ومسافة بادئة، و JWT مقسوم؛ و JSON مضغوط وموزّع ومهرَّب داخل نص، وقاموس Python، و PEM داخل JSON؛ وكتلة كود ts و yaml و python؛ وقيمة بين تنصيص فيها مسافات؛ ومفتاح PEM مقطوع) بنجاح.');

  // ===================== 4. الحذف الخاطئ =====================
  const harmless = [
    "const token = crypto.randomBytes(32).toString('hex');",
    'apiKeysEnabled: ai.apiKeysEnabled === true,',
    'export function deriveWrapKey(prfOutput: Buffer, credentialId: Buffer): Buffer {',
    'let pendingSetup: { secret: string; expiresAt: number } | null = null;',
    'if (token === expected) return true;',
    'const cleaned = tokens.map(token=>token.trim());',
    'if (apiKey==expectedKey) return;',
    'const apiKey = readField(body, "apiKey", 500).trim();',
    'max_tokens: request.maxTokens ?? 16000,',
    'for (const secret of vault.secrets) map.set(`secret:${secret.id}`, json(secret));',
    "const kindAr = { secret: 'سرّ متعارض في الخزنة' };",
    "fetch('/api/health', { credentials: 'same-origin' })",
    'شرح طريقة إعادة تعيين كلمة المرور للمستخدم',
    '<li>افتح الخزنة بكلمة المرور الرئيسية: تبدأ المزامنة تلقائياً.</li>',
    '// ===================== حماية الإعدادات بكلمة المرور =====================',
    'git clone https://user@github.com/example/repo.git',
    'NODE_ENV=production',
    'The token budget is large: about 16000 tokens per reply.',
  ];
  for (const line of harmless) {
    const r = redactSecrets(line);
    assert.equal(r.redactions, 0, `لا حذف خاطئ في: ${line} ← ${r.text}`);
    assert.equal(r.text, line);
  }
  passed.push(`اختبار الحذف الخاطئ (${harmless.length} سطراً من كود ونص عادي: تعابير الكود، والمقارنات، والأنواع، والقوالب، ونص الواجهة العربي، وروابط بلا كلمة مرور) لا تتغيّر بنجاح.`);

  // ===================== 5. صياغة الأعداد =====================
  const cases: Array<[number, string]> = [
    [0, '0 مشروع'], [1, 'مشروع واحد'], [2, 'مشروعان'], [3, '3 مشاريع'], [10, '10 مشاريع'], [11, '11 مشروعاً'],
    [99, '99 مشروعاً'], [100, '100 مشروع'], [102, '102 مشروع'], [103, '103 مشاريع'], [111, '111 مشروعاً'], [1000, '1000 مشروع'],
  ];
  for (const [n, expected] of cases) assert.equal(countAr(n, AR_COUNT.project), expected, `countAr(${n})`);
  assert.equal(countAr(10, AR_COUNT.secret), '10 أسرار');
  assert.equal(countAr(114, AR_COUNT.file), '114 ملفاً');
  assert.equal(countAr(1, AR_COUNT.record), 'سجل واحد');
  passed.push('اختبار صياغة الأعداد بالعربية (0 و 1 و 2 و 3–10 و 11–99 والمئات وما بعدها: «3 مشاريع» لا «3 مشروعاً»، و «سجل واحد» لا «1 سجلاً») بنجاح.');

  return passed;
}

/**
 * Hint بالعربي: دالة تشغيل اختبارات أنماط التنقيح وإرجاع نتائج الفحص (داخل بيئة العزل).
 */
export async function runRedactionPatternTests(): Promise<string[]> {
  const passedChecks = runRedactionPatternChecks();

  // ===================== 6. من الطرف إلى الطرف =====================
  const entry = recordSharedAIMemory({
    sourceAI: 'manual',
    projectId: 'redaction-test',
    title: 'اختبار التنقيح',
    summaryAr: `الإعداد {"password": "${FAKE.jsonPass}", "host": "db"} مع Bearer ${FAKE.bearer}`,
    keyDecisionsAr: [`cloudflared service install ${FAKE.cfTunnel}`],
  });
  const stored = querySharedAIMemory('redaction-test').find((e) => e.id === entry.id);
  assert.ok(stored, 'السجل محفوظ');
  const storedText = JSON.stringify(stored);
  for (const s of [FAKE.jsonPass, FAKE.bearer, FAKE.cfTunnel]) assert.ok(!storedText.includes(s), `الذاكرة لا تحفظ ${s.slice(0, 6)}…`);
  assert.ok(storedText.includes('"host'), 'بقية النص تبقى');

  const config = loadSystemConfig();
  const runtimeLog = path.join(config.paths.rootDir, 'Second-Brain-System', 'data', 'logs', 'runtime.log');
  const before = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8').length : 0;
  logSystemInfo('RedactionTest', `رد الخدمة {"client_secret":"${FAKE.jsonPass}"} و REDIS redis://:${FAKE.redisPass}@cache`);
  const written = fs.readFileSync(runtimeLog, 'utf8').slice(before);
  assert.ok(written.includes('رد الخدمة'), 'السطر كُتب');
  for (const s of [FAKE.jsonPass, FAKE.redisPass]) assert.ok(!written.includes(s), `runtime.log لا يحفظ ${s.slice(0, 6)}…`);
  passedChecks.push('اختبار من الطرف إلى الطرف (الذاكرة المشتركة تحفظ الملخص والقرارات بلا سرّ JSON ولا Bearer ولا رمز نفق، و runtime.log بلا سرّ JSON ولا كلمة مرور redis) بنجاح.');

  return passedChecks;
}
