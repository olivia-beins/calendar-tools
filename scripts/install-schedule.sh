#!/bin/bash
# Installs a launchd job that runs block-time:refresh on a schedule.
# Usage:
#   npm run schedule:install            # every Monday at 8am (default)
#   npm run schedule:install -- --daily # every day at 8am

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_LABEL="com.calendar-tools.block-time"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

DAILY=false
for arg in "$@"; do
  [ "$arg" = "--daily" ] && DAILY=true
done

mkdir -p "$LOG_DIR"

# Detect npm path
NPM_PATH="$(which npm)"
if [ -z "$NPM_PATH" ]; then
  echo "❌ npm not found. Make sure Node.js is installed and in your PATH."
  exit 1
fi

if [ "$DAILY" = true ]; then
  CALENDAR_INTERVAL='<dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>'
  SCHEDULE_DESC="every day at 8am"
else
  CALENDAR_INTERVAL='<dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>'
  SCHEDULE_DESC="every Monday at 8am"
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
    <string>block-time:refresh</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>StartCalendarInterval</key>
  $CALENDAR_INTERVAL

  <key>StandardOutPath</key>
  <string>$LOG_DIR/block-time.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/block-time-error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

# Load (or reload) the job
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "✅ Scheduled! block-time:refresh will run $SCHEDULE_DESC."
echo "   Logs: $LOG_DIR/block-time.log"
echo ""
echo "   To uninstall: npm run schedule:uninstall"
