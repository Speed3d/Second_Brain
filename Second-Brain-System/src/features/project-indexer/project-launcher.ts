/**
 * ============================================================================
 * الملف: src/features/project-indexer/project-launcher.ts
 * القسم: Features -> Project Indexer (فتح المشروع على الجهاز)
 * Hint بالعربي: يفتح مجلد مشروع مسجّل في مستكشف الملفات أو في VS Code.
 *               أمان: يعمل فقط على مسارات المشاريع المسجّلة، ويشغّل البرامج مباشرة دون موجّه أوامر (shell)،
 *               فلا يمكن حقن أي أمر عبر اسم المسار.
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Hint بالعربي: دالة البحث عن برنامج VS Code المثبّت على هذا الجهاز. المخرجات: الأمر ومعاملاته، أو null.
 */
export function findVsCode(): { command: string; argsPrefix: string[] } | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    return found ? { command: found, argsPrefix: [] } : null;
  }
  if (process.platform === 'darwin') {
    const app = ['/Applications/Visual Studio Code.app', path.join(os.homedir(), 'Applications', 'Visual Studio Code.app')].find((c) => fs.existsSync(c));
    return app ? { command: 'open', argsPrefix: ['-a', app] } : null;
  }
  return { command: 'code', argsPrefix: [] };
}

/**
 * Hint بالعربي: دالة فتح مجلد المشروع في مستكشف الملفات أو VS Code. ترمي خطأ إن لم يوجد المجلد أو البرنامج.
 */
export function openProjectLocation(projectPath: string, target: 'folder' | 'vscode'): void {
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('مجلد المشروع غير موجود على هذا الجهاز.');
  }
  let command: string;
  let args: string[];
  if (target === 'vscode') {
    const vscode = findVsCode();
    if (!vscode) throw new Error('لم يُعثر على VS Code على هذا الجهاز.');
    command = vscode.command;
    args = [...vscode.argsPrefix, resolved];
  } else if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = [resolved];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [resolved];
  } else {
    command = 'xdg-open';
    args = [resolved];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.on('error', () => {
    /* فشل التشغيل يُتجاهل هنا؛ المستخدم يرى أن البرنامج لم يُفتح */
  });
  child.unref();
}
