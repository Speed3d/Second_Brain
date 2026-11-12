# ============================================================================
# الملف: install/windows/open-app.ps1
# القسم: Install -> Windows (فتح Second Brain في نافذة مستقلة)
# Hint بالعربي: يتأكد أن الخادم يعمل (ويشغّله مخفياً إن لم يكن)، ثم يفتح الواجهة في نافذة تطبيق مستقلة
#               بلا شريط عنوان أو تبويبات (وضع --app في Chrome أو Edge). إن لم يوجد أي منهما يفتح المتصفح الافتراضي.
# ============================================================================
. (Join-Path $PSScriptRoot 'common.ps1')

$port = Get-SBPort
if (-not (Test-SBServer $port)) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"{0}"' -f (Join-Path $PSScriptRoot 'start-hidden.vbs')) -WindowStyle Hidden
  for ($i = 0; $i -lt 120 -and -not (Test-SBServer $port); $i++) { Start-Sleep -Milliseconds 500 }
}
$url = "http://127.0.0.1:$port/"

function Find-Browser {
  $candidates = @()
  foreach ($name in @('chrome.exe', 'msedge.exe')) {
    foreach ($hive in @('HKCU', 'HKLM')) {
      try {
        $v = (Get-ItemProperty -LiteralPath "${hive}:\Software\Microsoft\Windows\CurrentVersion\App Paths\$name" -ErrorAction Stop).'(default)'
        if ($v) { $candidates += $v }
      } catch {}
    }
  }
  $candidates += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c.Trim('"'))) { return $c.Trim('"') } }
  return $null
}

$browser = Find-Browser
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=$url", '--window-size=1440,920'
} else {
  Start-Process $url
}
