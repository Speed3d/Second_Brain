/**
 * ============================================================================
 * الملف: src/features/dashboard-app/desktop-server.ts
 * القسم: Features -> Dashboard App (خادم تطبيق سطح المكتب المحلي)
 * Hint بالعربي: يقوم هذا الملف بتشغيل خادم سطح المكتب المحلي على المنفذ 4777
 *               ويربط واجهة القائد (HUD) وواجهة الزوجة (Wife Mode) بجميع محركات
 *               التشفير، فحص المشاريع، الذاكرة المشتركة، وتوليد حقيبة الطوارئ.
 * ============================================================================
 */

import * as http from 'node:http';
import { loadSystemConfig, registerWatchedProject } from '../../core/config-manager.ts';
import { generateEmergencyRecoveryKey } from '../../core/crypto-engine.ts';
import { logSystemError, logSystemInfo } from '../../core/logger.ts';
import { formatTimestampIso } from '../../shared/file-helpers.ts';
import { querySharedAIMemory } from '../ai-memory/shared-memory-service.ts';
import { harvestLocalAITranscripts } from '../ai-memory/transcript-harvester.ts';
import { askSecondBrainAssistant } from '../assistant/assistant-engine.ts';
import { createEncryptedSystemBackup } from '../family-emergency/backup-service.ts';
import { generatePrintableEmergencyKit } from '../family-emergency/emergency-kit-service.ts';
import { syncProjectToObsidianVault } from '../project-indexer/obsidian-sync.ts';
import { scanAndAnalyzeProject } from '../project-indexer/project-scanner.ts';
import { initializeEncryptedVault, unlockAndReadVault, upsertVaultSecret } from '../vault/vault-manager.ts';
import { renderSecondBrainDesktopHTML } from './ui-renderer.ts';

/**
 * Hint بالعربي: دالة لإنشاء خادم HTTP الخاص بواجهة سطح المكتب والـ APIs المحلية
 * (مفصولة في دالة قابلة للاستدعاء من المشغل الرئيسي أو من ملفات الاختبار).
 */
export function createSecondBrainDesktopServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // الصفحة الرئيسية للبرنامج
      if (method === 'GET' && url === '/') {
        const config = loadSystemConfig();
        const reports = config.watchedProjects.map((p) => {
          const rep = scanAndAnalyzeProject(p);
          syncProjectToObsidianVault(p, rep);
          return rep;
        });
        const memories = querySharedAIMemory();
        const html = renderSecondBrainDesktopHTML(config, reports, memories);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // نقطة فحص حالة الخادم (Health Check)
      if (method === 'GET' && url === '/api/health') {
        const config = loadSystemConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', appName: config.appName, version: config.version }));
        return;
      }

      const bodyData = await readRequestBodyJson(req);

      // نقطة التفاعل مع المساعد الذكي (وضع القائد + وضع الزوجة)
      if (method === 'POST' && url === '/api/assistant') {
        const question = String(bodyData.question ?? '');
        const mode = bodyData.mode === 'wife_emergency' ? 'wife_emergency' : 'commander';
        const reply = await askSecondBrainAssistant(question, mode);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(reply));
        return;
      }

      // نقطة إضافة وفحص مشروع جديد وتوثيقه في Obsidian
      if (method === 'POST' && url === '/api/projects/add') {
        const name = String(bodyData.name ?? '').trim();
        const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const newProj = {
          id: id || `proj-${Date.now()}`,
          name,
          path: String(bodyData.path ?? '').trim(),
          descriptionAr: String(bodyData.descriptionAr ?? 'مشروع مضاف للمراقبة الذكية'),
          wifeSummaryAr: String(bodyData.wifeSummaryAr ?? 'تطبيق برمجي مسجل في النظام'),
          monthlyIncome: String(bodyData.monthlyIncome ?? 'غير محدد بعد'),
          billingNotes: String(bodyData.billingNotes ?? 'راجع تفاصيل الاستضافة في الخزنة'),
        };
        registerWatchedProject(newProj);
        const scanRep = scanAndAnalyzeProject(newProj);
        syncProjectToObsidianVault(newProj, scanRep);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            messageAr: `✅ تم فحص مشروع (${name}) وتوثيقه في Obsidian واكتشاف (${scanRep.criticalFilesFound.length}) ملفات حساسة!`,
          })
        );
        return;
      }

      // نقطة سحب محادثات Antigravity و Claude Code تلقائياً
      if (method === 'POST' && url === '/api/memory/harvest') {
        const harvested = harvestLocalAITranscripts();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            messageAr: `✅ تم سحب وأرشفة (${harvested.antigravityCount}) محادثة من Antigravity و (${harvested.claudeCodeCount}) من Claude Code داخل Obsidian!`,
          })
        );
        return;
      }

      // نقطة حفظ عنصر جديد في الخزنة المشفرة
      if (method === 'POST' && url === '/api/vault/save') {
        const masterPassword = String(bodyData.masterPassword ?? '');
        const emergencyKey = String(bodyData.emergencyRecoveryKey ?? '').trim() || generateEmergencyRecoveryKey();
        const secretItem = {
          id: `SEC-${Date.now()}`,
          category: 'password' as const,
          title: String(bodyData.title ?? ''),
          usernameOrEmail: String(bodyData.usernameOrEmail ?? ''),
          secretValue: String(bodyData.secretValue ?? ''),
          notesForCommanderAr: 'حساب محفوظ ومشفر بـ AES-256-GCM',
          notesForWifeAr: String(bodyData.notesForWifeAr ?? 'حساب مهم لإدارة المشاريع'),
          updatedAt: formatTimestampIso(),
        };
        upsertVaultSecret(secretItem, masterPassword, emergencyKey);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            emergencyRecoveryKey: emergencyKey,
            messageAr: `🔒 تم تشفير وحفظ (${secretItem.title}) بنجاح!\n🔑 مفتاح الطوارئ العائلي لزوجتك هو:\n${emergencyKey}\n(احتفظ به أو اضغط على زر توليد كتيب الطوارئ المطبوع)`,
          })
        );
        return;
      }

      // نقطة فتح الخزنة وعرض الحسابات (تعمل بكلمة مرور القائد أو بمفتاح الطوارئ للزوجة)
      if (method === 'POST' && url === '/api/vault/unlock') {
        const key = String(bodyData.key ?? '');
        const unlocked = unlockAndReadVault(key);
        const roleLabel =
          unlocked.unlockedBy === 'wife_emergency'
            ? '❤️ تم فتح الخزنة بنجاح عبر [مفتاح الطوارئ العائلي للزوجة]'
            : '⚡ تم فتح الخزنة بنجاح عبر [كلمة المرور الرئيسية للقائد]';

        const lines = unlocked.secrets.map(
          (s, i) =>
            `${i + 1}. 🔐 [${s.title}]\n   - الإيميل/المستخدم: ${s.usernameOrEmail || '—'}\n   - القيمة السرية / الباسوورد: ${
              s.category === 'critical_file' ? '(ملف مشفر جاهز للاسترجاع)' : s.secretValue
            }\n   - ملاحظة لزوجتي: ${s.notesForWifeAr}`
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            formattedText: `${roleLabel}\nإجمالي الأسرار المحفوظة: (${unlocked.secrets.length})\n\n${lines.join('\n\n')}`,
          })
        );
        return;
      }

      // نقطة توليد كتيب الطوارئ المطبوع والنسخة الاحتياطية المشفرة
      if (method === 'POST' && url === '/api/emergency/generate') {
        const masterPassword = String(bodyData.masterPassword ?? 'SECOND-BRAIN-MASTER');
        const emergencyKey = String(bodyData.emergencyKey ?? '').trim() || generateEmergencyRecoveryKey();
        initializeEncryptedVault(masterPassword, [], emergencyKey);
        const kit = generatePrintableEmergencyKit(emergencyKey);
        const backup = createEncryptedSystemBackup(emergencyKey);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            emergencyKey,
            messageAr: `✅ تم توليد حقيبة الطوارئ العائلية بنجاح!\n1. كتيب الطوارئ للطباعة: ${kit.htmlFilePath}\n2. النسخة الاحتياطية المشفرة (${backup.filesIncluded} ملف): ${backup.backupFilePath}\n3. مفتاح الطوارئ لزوجتك: ${emergencyKey}`,
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'المسار غير موجود' }));
    } catch (err) {
      logSystemError('DesktopServer', 'خطأ أثناء معالجة الطلب في خادم سطح المكتب', err);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'حدث خطأ غير متوقع' }));
    }
  });
}

/**
 * Hint بالعربي: دالة مساعدة لقراءة بيانات JSON المرسلة في طلبات POST بأمان.
 */
export function readRequestBodyJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// تشغيل الخادم إذا تم استدعاء الملف مباشرة
if (process.argv[1] && process.argv[1].endsWith('desktop-server.ts')) {
  const config = loadSystemConfig();
  const server = createSecondBrainDesktopServer();
  server.listen(config.serverPort, () => {
    logSystemInfo('DesktopServer', `تم تشغيل واجهة سطح المكتب على الرابط: http://localhost:${config.serverPort}`);
    console.log(`\n🛡️  ${config.appTitleAr}`);
    console.log(`🚀 واجهة القائد ووضع العائلة يعملان الآن على: http://localhost:${config.serverPort}\n`);
  });
}
