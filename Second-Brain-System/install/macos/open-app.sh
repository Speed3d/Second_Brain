#!/bin/bash
# ============================================================================
# الملف: install/macos/open-app.sh
# القسم: Install -> macOS (فتح Second Brain في نافذة مستقلة)
# Hint بالعربي: ينتظر أن يعمل الخادم (ويشغّل خدمة الخلفية إن لزم)، ثم يفتح الواجهة في نافذة تطبيق مستقلة
#               عبر Chrome أو Edge (وضع --app)، وإلا في المتصفح الافتراضي.
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="$(/usr/bin/python3 -c 'import json,sys
for f in sys.argv[1:]:
    try:
        p=json.load(open(f)).get("serverPort")
        if p: print(p); break
    except Exception: pass
else: print(4777)' "$SYSTEM_DIR/config/settings.json" "$SYSTEM_DIR/config/branding.json" 2>/dev/null || echo 4777)"
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
