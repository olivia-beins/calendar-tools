#!/bin/bash
# Installs a launchd job that syncs Slack status every minute.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_LABEL="com.calendar-tools.slack-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

NPM_PATH="$(which npm)"
if [ -z "$NPM_PATH" ]; then
  echo "❌ npm not found. Make sure Node.js is installed and in your PATH."
  exit 1
fi

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NPM_PATH</string>
    <string>run</string>
    <string>slack-sync</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>StartInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/slack-sync.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/slack-sync-error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "✅ Slack status sync installed! Runs every minute."
echo "   Logs: $LOG_DIR/slack-sync.log"
echo ""
echo "   To uninstall: npm run slack-sync:schedule:uninstall"
