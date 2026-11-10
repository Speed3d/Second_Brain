/**
 * ============================================================================
 * الملف: src/tools/code-registry-scanner.ts
 * القسم: Tools (الأدوات المستقلة — الفاحص والمفهرس الآلي للأكواد والدوال)
 * Hint بالعربي: تطبيقاً للقانون السابع (7)، يقوم هذا الملف بفحص جميع ملفات الكود
 *               في المشروع، واستخراج كل دالة، وظيفتها بالعربية، مكان تعريفها،
 *               الأماكن التي استُخدمت فيها، وهل هي (مستخدمة Active) أم (غير مستخدمة Unused)،
 *               ثم يحدّث وثيقة الفهرس تلقائياً في docs/ وداخل Obsidian!
 * ============================================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeRegistryEntry } from '../shared/types.ts';
import { formatTimestampIso, listFilesRecursive, writeTextFileSafe } from '../shared/file-helpers.ts';
import { getSystemRootDir, loadSystemConfig } from '../core/config-manager.ts';

/**
 * Hint بالعربي: دالة فحص جميع ملفات الكود في src/ و tests/ وبناء الفهرس الشامل للدوال والأدوات.
 */
export function scanAndGenerateCodeRegistry(): {
  entries: CodeRegistryEntry[];
  docsIndexPath: string;
  obsidianMirrorPath: string;
} {
  const config = loadSystemConfig();
  // مكان الكود يُحسب من موقع الأداة نفسها (وليس من الإعدادات) ليعمل الفحص من أي مسار
  const systemRoot = getSystemRootDir();
  const srcRoot = path.join(systemRoot, 'src');
  const testsRoot = path.join(systemRoot, 'tests');

  const srcFiles = listFilesRecursive(srcRoot).filter((f) => f.endsWith('.ts'));
  const testFiles = listFilesRecursive(testsRoot).filter((f) => f.endsWith('.ts'));
  const allCodeFiles = [...srcFiles, ...testFiles];

  const fileContentsMap = new Map<string, string>();
  for (const f of allCodeFiles) {
    fileContentsMap.set(f, fs.readFileSync(f, 'utf-8'));
  }

  const entries: CodeRegistryEntry[] = [];

  for (const filePath of srcFiles) {
    const content = fileContentsMap.get(filePath) ?? '';
    const lines = content.split(/\r?\n/);
    const relPath = path.relative(systemRoot, filePath).replace(/\\/g, '/');

    let layer: CodeRegistryEntry['layer'] = 'Features';
    if (relPath.startsWith('src/core/')) layer = 'Core';
    else if (relPath.startsWith('src/shared/')) layer = 'Shared';
    else if (relPath.startsWith('src/tools/')) layer = 'Tools';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fnMatch = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (fnMatch) {
        const symbolName = fnMatch[1];
        const lineNumber = i + 1;

        // البحث عن شرح Hint بالعربي في الأسطر السابقة للدالة
        let arabicHint = 'دالة برمجية ضمن النظام';
        const commentBlockLines: string[] = [];
        for (let k = Math.max(0, i - 6); k < i; k++) {
          const prevLine = lines[k].trim();
          if (prevLine.includes('Hint بالعربي:')) {
            commentBlockLines.push(prevLine.replace(/^(\*|\/*)\s*Hint بالعربي:\s*/, '').trim());
          } else if (commentBlockLines.length > 0 && prevLine.startsWith('*') && !prevLine.startsWith('*/')) {
            commentBlockLines.push(prevLine.replace(/^\*\s*/, '').trim());
          }
        }
        if (commentBlockLines.length > 0) {
          arabicHint = commentBlockLines.join(' ');
        }

        // البحث عن جميع الملفات التي استخدمت أو استدعت هذه الدالة
        const usedInFiles: string[] = [];
        const usageRegex = new RegExp(`\\b${symbolName}\\b`, 'g');

        for (const [otherPath, otherContent] of fileContentsMap.entries()) {
          const otherRel = path.relative(systemRoot, otherPath).replace(/\\/g, '/');
          if (otherPath === filePath) {
            // إذا تم استدعاؤها داخل نفس الملف أكثر من مرة (غير سطر التعريف)
            const matches = otherContent.match(usageRegex);
            if (matches && matches.length > 1) {
              usedInFiles.push(`${otherRel} (داخلي)`);
            }
          } else if (usageRegex.test(otherContent)) {
            usedInFiles.push(otherRel);
          }
        }

        entries.push({
          symbolName,
          symbolType: layer === 'Tools' ? 'tool' : 'function',
          layer,
          filePath: relPath,
          lineNumber,
          arabicHint,
          usedInFiles,
          status: usedInFiles.length > 0 ? 'مستخدم (Active)' : 'غير مستخدم / جاهز للتوسع (Unused)',
        });
      }
    }
  }

  const markdownTable = entries
    .map(
      (e) =>
        `| \`${e.symbolName}\` | **${e.layer}** | \`${e.filePath}#L${e.lineNumber}\` | ${e.arabicHint} | ${
          e.usedInFiles.length > 0 ? e.usedInFiles.map((u) => `\`${u}\``).join(', ') : '—'
        } | **${e.status}** |`
    )
    .join('\n');

  const activeCount = entries.filter((e) => e.status === 'مستخدم (Active)').length;
  const unusedCount = entries.length - activeCount;

  const fullMarkdown = `# 📑 الفهرس الحي الشامل للدوال والأكواد والأدوات (Live Code & Function Registry)

> **تطبيقاً للقانون السابع (7):** يتم توليد وتحديث هذا الفهرس تلقائياً بواسطة الأداة \`src/tools/code-registry-scanner.ts\`.  
> **تاريخ آخر فحص آلي:** \`${formatTimestampIso()}\`  
> **إجمالي الدوال المفحوصة:** \`${entries.length}\` | **المستخدمة حالياً (Active):** \`${activeCount}\` | **الجاهزة للتوسع المستقبلي:** \`${unusedCount}\`

---

## 📊 جدول الدوال والأكواد المفهرسة حسب الطبقات (\`Core\` / \`Features\` / \`Shared\` / \`Tools\`)

| اسم الدالة / الأداة | القسم (Layer) | الملف ورقم السطر | لماذا كُتبت؟ (Hint بالعربي) | أين تم استخدامها واستدعاؤها؟ | الحالة الراهنة |
| :--- | :--- | :--- | :--- | :--- | :--- |
${markdownTable}
`;

  const docsIndexPath = path.join(config.paths.docsDir, '04-CODE-AND-FUNCTIONS-INDEX.md');
  const obsidianMirrorPath = path.join(
    config.paths.obsidianVaultDir,
    '00-Command-Center',
    'Code-Registry-Mirror.md'
  );

  writeTextFileSafe(docsIndexPath, fullMarkdown);
  writeTextFileSafe(obsidianMirrorPath, fullMarkdown);

  return { entries, docsIndexPath, obsidianMirrorPath };
}

// تشغيل الفاحص مباشرة إذا استُدعي من سطر الأوامر
if (process.argv[1] && process.argv[1].endsWith('code-registry-scanner.ts')) {
  const result = scanAndGenerateCodeRegistry();
  console.log(`✅ تم تحديث فهرس الدوال بنجاح (${result.entries.length} دالة) في: ${result.docsIndexPath}`);
}
