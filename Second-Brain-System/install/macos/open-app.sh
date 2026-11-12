#!/bin/bash
# ============================================================================
# الملف: install/macos/open-app.sh
# القسم: Install -> macOS (فتح Second Brain في نافذة مستقلة)
# Hint بالعربي: ينتظر أن يعمل الخادم (ويشغّل خدمة الخلفية إن لزم)، ثم يفتح الواجهة في نافذة تطبيق مستقلة
#               عبر Chrome أو Edge (وضع --app)، وإلا في المتصفح الافتراضي.
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# قراءة المنفذ عبر Node (المثبّت أصلاً)؛ /usr/bin/python3 قد يطلب تثبيت أدوات Xcode على ماك جديد
NODE="$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)"
PORT="$("$NODE" -e 'const fs=require("fs");for(const f of process.argv.slice(1)){try{const p=JSON.parse(fs.readFileSync(f,"utf8")).serverPort;if(p){console.log(p);process.exit(0)}}catch{}}console.log(4777)' "$SYSTEM_DIR/config/settings.json" "$SYSTEM_DIR/config/branding.json" 2>/dev/null || echo 4777)"
URL="http://127.0.0.1:$PORT/"

healthy() { curl -fsS --max-time 2 "${URL}api/health" 2>/dev/null | grep -q '"status":"ok"'; }
if ! healthy; then
  launchctl kickstart "gui/$(id -u)/com.secondbrain.server" 2>/dev/null || true
  for _ in $(seq 1 120); do healthy && break; sleep 0.5; done
fi

for app in "Google Chrome" "Microsoft Edge"; do
  if [ -d "/Applications/$app.app" ]; then
    open -na "$app" --args --app="$URL" --window-size=1440,920
    exit 0
  fi
done
open "$URL"
