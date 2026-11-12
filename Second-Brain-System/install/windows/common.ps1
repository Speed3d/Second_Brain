# ============================================================================
# الملف: install/windows/common.ps1
# القسم: Install -> Windows (دوال مشتركة لسكربتات التشغيل والتثبيت)
# Hint بالعربي: تحديد مجلد النظام، وقراءة المنفذ من الإعدادات، وفحص هل الخادم يعمل، والبحث عن Node.
# ============================================================================

$script:SBSystemDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Get-SBPort {
  foreach ($f in @('config\settings.json', 'config\branding.json')) {
    $p = Join-Path $script:SBSystemDir $f
    try {
      $c = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($c.serverPort) { return [int]$c.serverPort }
    } catch {}
  }
  return 4777
}

function Test-SBServer([int]$Port = (Get-SBPort)) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ("http://127.0.0.1:{0}/api/health" -f $Port)
    return ($r.Content -match '"status":"ok"')
  } catch { return $false }
}

function Get-SBNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}
