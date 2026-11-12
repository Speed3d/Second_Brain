#!/bin/bash
# ============================================================================
# الملف: install/macos/install-macos.sh
# القسم: Install -> macOS (مثبّت Second Brain على الماك — المرحلة ب)
# Hint بالعربي: يسجّل LaunchAgent للمستخدم الحالي فيعمل الخادم في الخلفية عند تسجيل الدخول، ويعيد تشغيله
#               إن توقف فجأة. ويضع «Second Brain.command» على سطح المكتب لفتح البرنامج في نافذة مستقلة.
#               لا يحتاج sudo، ولا يمس البيانات. للإزالة: install/macos/uninstall-macos.sh
#   bash install/macos/install-macos.sh [--device-name "MacBook-M5"] [--preview]
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.secondbrain.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DESKTOP_CMD="$HOME/Desktop/Second Brain.command"
DEVICE_FILE="$SYSTEM_DIR/data/device.json"
LOG_DIR="$SYSTEM_DIR/data/logs"
DEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
PREVIEW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --device-name) DEVICE_NAME="$2"; shift 2 ;;
    --preview) PREVIEW=1; shift ;;
    *) echo "معامل غير معروف: $1"; exit 2 ;;
  esac
done

NODE="$(command -v node || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node

echo "===================================================================="
echo "  Second Brain — المثبّت (macOS)"
echo "===================================================================="
echo "مجلد النظام : $SYSTEM_DIR"
echo "Node.js     : ${NODE:-غير موجود!}"
echo ""
echo "سيقوم المثبّت بما يلي (بلا sudo):"
echo "  1. تشغيل تلقائي في الخلفية عند تسجيل الدخول : $PLIST"
echo "  2. ملف فتح البرنامج على سطح المكتب          : $DESKTOP_CMD"
echo "  3. اسم هذا الجهاز                            : $DEVICE_NAME ($DEVICE_FILE)"
echo "  4. تشغيل الخادم الآن"
echo ""

if [ -z "$NODE" ]; then echo "❌ Node.js غير مثبّت. ثبّت Node.js 24 أو أحدث من https://nodejs.org"; exit 1; fi
MAJOR="$("$NODE" --version | sed 's/^v//' | cut -d. -f1)"
if [ "$MAJOR" -lt 24 ]; then echo "❌ إصدار Node.js قديم ($MAJOR). المطلوب 24 أو أحدث."; exit 1; fi
if [ "$PREVIEW" = "1" ]; then echo "وضع المعاينة: لم يُغيَّر أي شيء."; exit 0; fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>src/features/dashboard-app/desktop-server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$SYSTEM_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ التشغيل التلقائي عند تسجيل الدخول"

cat > "$DESKTOP_CMD" <<CMD
#!/bin/bash
exec "$SCRIPT_DIR/open-app.sh"
CMD
chmod +x "$DESKTOP_CMD" "$SCRIPT_DIR/open-app.sh"
echo "✔ ملف «Second Brain» على سطح المكتب"

if [ ! -f "$DEVICE_FILE" ]; then
  mkdir -p "$(dirname "$DEVICE_FILE")"
  "$NODE" -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({deviceId:require("crypto").randomUUID(),deviceName:process.argv[2],platform:"macos",createdAt:new Date().toISOString()},null,2))' "$DEVICE_FILE" "$DEVICE_NAME"
  echo "✔ اسم الجهاز: $DEVICE_NAME"
else
  echo "✔ هوية الجهاز موجودة مسبقاً (لم تتغير)"
fi

echo ""
echo "🎉 اكتمل التثبيت. افتح البرنامج من «Second Brain» على سطح المكتب. للإزالة: install/macos/uninstall-macos.sh"
