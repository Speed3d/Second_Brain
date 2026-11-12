#!/bin/bash
# ============================================================================
# الملف: install/macos/uninstall-macos.sh
# القسم: Install -> macOS (إزالة التشغيل التلقائي)
# Hint بالعربي: يوقف خدمة الخلفية ويحذف LaunchAgent وملف سطح المكتب. لا يمس أي بيانات.
# ============================================================================
LABEL="com.secondbrain.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "✔ أُوقفت خدمة الخلفية"
[ -f "$PLIST" ] && rm -f "$PLIST" && echo "✔ حُذف: $PLIST"
[ -f "$HOME/Desktop/Second Brain.command" ] && rm -f "$HOME/Desktop/Second Brain.command" && echo "✔ حُذف ملف سطح المكتب"
echo "🎉 اكتملت الإزالة. بياناتك كما هي."
