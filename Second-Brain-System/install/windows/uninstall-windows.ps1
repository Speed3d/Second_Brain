# ============================================================================
# الملف: install/windows/uninstall-windows.ps1
# القسم: Install -> Windows (إزالة التشغيل التلقائي والاختصارات)
# Hint بالعربي: يحذف اختصارات التشغيل التلقائي وسطح المكتب وقائمة ابدأ، ويوقف الخادم العامل في الخلفية.
#               لا يمس أي بيانات (الخزنة، المحادثات، الإعدادات، الأصوات المنزّلة) ولا تسجيل خادم الذاكرة.
#   powershell -ExecutionPolicy Bypass -File install\windows\uninstall-windows.ps1 [-KeepRunning]
# ============================================================================
param([switch]$KeepRunning)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'common.ps1')

foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Second Brain (Background).lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Second Brain.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Second Brain.lnk')
)) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -Confirm:$false; Write-Host "✔ حُذف: $lnk" }
}

if (-not $KeepRunning) {
  # أولاً المشغّل (حتى لا يعيد تشغيل الخادم)، ثم الخادم نفسه — فقط العمليات التابعة لهذا المجلد
  $sys = $script:SBSystemDir
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.ProcessId -ne $PID -and (
      ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$sys*run-server.ps1*") -or
      ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*desktop-server.ts*' -and $_.ExecutablePath -and (Test-Path -LiteralPath $sys))
    )
  } | Sort-Object { if ($_.Name -eq 'powershell.exe') { 0 } else { 1 } }
  foreach ($p in $procs) {
    if ($p.Name -eq 'node.exe') {
      # نتأكد أن الخادم من هذا المجلد: مجلد العمل غير متاح، فنتحقق من أنه يخدم المنفذ المحدد
      $listening = Get-NetTCPConnection -State Listen -LocalPort (Get-SBPort) -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $p.ProcessId
      if (-not $listening) { continue }
    }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("✔ أُوقفت العملية {0} ({1})" -f $p.ProcessId, $p.Name)
  }
}
Write-Host '🎉 اكتملت الإزالة. بياناتك كما هي، ويمكنك التشغيل يدوياً عبر Launch-Second-Brain.bat'
