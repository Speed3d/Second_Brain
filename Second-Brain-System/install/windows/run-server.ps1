# ============================================================================
# الملف: install/windows/run-server.ps1
# القسم: Install -> Windows (تشغيل الخادم في الخلفية مع إعادة التشغيل عند التعطل)
# Hint بالعربي: يُشغَّل مخفياً عند تسجيل الدخول (عبر start-hidden.vbs). إن كان الخادم يعمل يخرج فوراً.
#               يكتب السجل في data/logs/server.log، ويعيد تشغيل الخادم إن توقف فجأة
#               (حتى 5 مرات خلال 10 دقائق، ثم يتوقف حتى لا يدور بلا نهاية).
# ============================================================================
. (Join-Path $PSScriptRoot 'common.ps1')

$mutex = New-Object System.Threading.Mutex($false, 'Local\SecondBrainServerRunner')
if (-not $mutex.WaitOne(0)) { exit 0 }  # نسخة أخرى من المشغّل تعمل بالفعل

try {
  if (Test-SBServer) { exit 0 }
  $node = Get-SBNode
  $logDir = Join-Path $script:SBSystemDir 'data\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir 'server.log'
  $crashes = New-Object System.Collections.Generic.List[datetime]

  while ($true) {
    if (Test-Path -LiteralPath $log) {
      if ((Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -LiteralPath $log -Destination "$log.old" -Force }
    }
    if (-not $node) {
      Add-Content -LiteralPath $log -Value ("[{0}] Node.js not found." -f (Get-Date -Format s)) -Encoding UTF8
      exit 1
    }
    Add-Content -LiteralPath $log -Value ("[{0}] starting server" -f (Get-Date -Format s)) -Encoding UTF8
    $p = Start-Process -FilePath $node -ArgumentList 'src/features/dashboard-app/desktop-server.ts' `
      -WorkingDirectory $script:SBSystemDir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
    $null = $p.Handle  # يحفظ مقبض العملية حتى يُقرأ رمز الخروج بعد انتهائها (خاصية معروفة في PowerShell 5.1)
    $p.WaitForExit()
    foreach ($part in @("$log.out", "$log.err")) {
      if (Test-Path -LiteralPath $part) { Get-Content -LiteralPath $part -Encoding UTF8 | Add-Content -LiteralPath $log -Encoding UTF8; Remove-Item -LiteralPath $part -Force }
    }
    Add-Content -LiteralPath $log -Value ("[{0}] server exited with code {1}" -f (Get-Date -Format s), $p.ExitCode) -Encoding UTF8
    if ($p.ExitCode -eq 0) { break }               # إيقاف مقصود
    if (Test-SBServer) { break }                    # نسخة أخرى تعمل على المنفذ
    $now = Get-Date
    $crashes.Add($now)
    $recent = @($crashes | Where-Object { ($now - $_).TotalMinutes -lt 10 })
    if ($recent.Count -ge 5) {
      Add-Content -LiteralPath $log -Value ("[{0}] too many crashes, giving up" -f (Get-Date -Format s)) -Encoding UTF8
      exit 1
    }
    Start-Sleep -Seconds (5 * $recent.Count)
  }
} finally {
  $mutex.ReleaseMutex() | Out-Null
}
