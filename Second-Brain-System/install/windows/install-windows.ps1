# ============================================================================
# الملف: install/windows/install-windows.ps1
# القسم: Install -> Windows (مثبّت Second Brain على Windows — المرحلة ب)
# Hint بالعربي: يجعل Second Brain يعمل تلقائياً في الخلفية عند تسجيل الدخول، وينشئ اختصاراً بأيقونة
#               يفتح البرنامج في نافذة مستقلة. لا يحتاج صلاحيات مسؤول، ولا يعدّل إعدادات Windows أو جدولة المهام:
#               يضيف اختصارات فقط (مجلد بدء التشغيل، سطح المكتب، قائمة ابدأ)، ويُزال كل شيء بـ uninstall-windows.ps1.
#               يعرض ما سيفعله أولاً؛ استخدم -Preview للعرض فقط دون أي تغيير.
#   powershell -ExecutionPolicy Bypass -File install\windows\install-windows.ps1 [-DeviceName "Asus-Windows"] [-Preview]
# ============================================================================
param(
  [string]$DeviceName = $env:COMPUTERNAME,
  [switch]$Preview,
  [switch]$NoDesktopShortcut
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'common.ps1')

$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$icon = Join-Path $script:SBSystemDir 'install\second-brain.ico'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Second Brain (Background).lnk'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Second Brain.lnk'
$menuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Second Brain.lnk'
$deviceFile = Join-Path $script:SBSystemDir 'data\device.json'
$node = Get-SBNode

Write-Host '===================================================================='
Write-Host '  Second Brain — المثبّت (Windows)'
Write-Host '===================================================================='
Write-Host ("مجلد النظام : {0}" -f $script:SBSystemDir)
Write-Host ("Node.js     : {0}" -f ($(if ($node) { $node } else { 'غير موجود!' })))
Write-Host ''
Write-Host 'سيقوم المثبّت بما يلي (اختصارات فقط، بلا صلاحيات مسؤول):'
Write-Host ("  1. تشغيل تلقائي مخفي عند تسجيل الدخول : {0}" -f $startupLnk)
if (-not $NoDesktopShortcut) { Write-Host ("  2. اختصار على سطح المكتب              : {0}" -f $desktopLnk) }
Write-Host ("  3. اختصار في قائمة ابدأ               : {0}" -f $menuLnk)
Write-Host ("  4. اسم هذا الجهاز                      : {0}  ({1})" -f $DeviceName, $deviceFile)
Write-Host '  5. تشغيل الخادم الآن في الخلفية'
Write-Host ''

if (-not $node) { throw 'Node.js غير مثبّت. ثبّت Node.js 24 أو أحدث من https://nodejs.org ثم أعد التشغيل.' }
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "إصدار Node.js قديم ($major). المطلوب 24 أو أحدث." }

if ($Preview) { Write-Host 'وضع المعاينة: لم يُغيَّر أي شيء.'; exit 0 }

function New-SBShortcut([string]$Path, [string]$Script, [string]$Description) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $wscript
  $lnk.Arguments = '"{0}"' -f (Join-Path $PSScriptRoot $Script)
  $lnk.WorkingDirectory = $script:SBSystemDir
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = $Description
  $lnk.Save()
}

New-SBShortcut $startupLnk 'start-hidden.vbs' 'Second Brain — تشغيل الخادم في الخلفية'
Write-Host '✔ التشغيل التلقائي عند تسجيل الدخول'
if (-not $NoDesktopShortcut) { New-SBShortcut $desktopLnk 'open-app.vbs' 'Second Brain — العقل الثاني'; Write-Host '✔ اختصار سطح المكتب' }
New-SBShortcut $menuLnk 'open-app.vbs' 'Second Brain — العقل الثاني'
Write-Host '✔ اختصار قائمة ابدأ'

if (-not (Test-Path -LiteralPath $deviceFile)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $deviceFile) | Out-Null
  $device = [ordered]@{ deviceId = [guid]::NewGuid().ToString(); deviceName = $DeviceName; platform = 'windows'; createdAt = (Get-Date).ToString('o') }
  [System.IO.File]::WriteAllText($deviceFile, ($device | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ("✔ اسم الجهاز: {0}" -f $DeviceName)
} else {
  Write-Host '✔ هوية الجهاز موجودة مسبقاً (لم تتغير)'
}

# خادم الذاكرة (MCP): فحص فقط — التسجيل اليدوي موثّق في docs/08
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$agJson = Join-Path $env:USERPROFILE '.gemini\antigravity\mcp_config.json'
foreach ($pair in @(@('Claude Code', $claudeJson), @('Antigravity', $agJson))) {
  $ok = $false
  try { $ok = [bool]((Get-Content -LiteralPath $pair[1] -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers.'second-brain') } catch {}
  Write-Host ("{0} خادم الذاكرة في {1}" -f ($(if ($ok) { '✔ مسجّل' } else { '⚠ غير مسجّل:' }), $pair[0]))
}

if (Test-SBServer) {
  Write-Host '✔ الخادم يعمل بالفعل.'
} else {
  Start-Process -FilePath $wscript -ArgumentList ('"{0}"' -f (Join-Path $PSScriptRoot 'start-hidden.vbs'))
  for ($i = 0; $i -lt 120 -and -not (Test-SBServer); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-SBServer) { Write-Host '✔ الخادم يعمل الآن في الخلفية.' } else { Write-Host '⚠ لم يستجب الخادم بعد؛ راجع data\logs\server.log' }
}
Write-Host ''
Write-Host '🎉 اكتمل التثبيت. افتح البرنامج من اختصار «Second Brain». للإزالة: install\windows\uninstall-windows.ps1'
