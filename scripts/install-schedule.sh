#!/bin/bash
# Installs a launchd job that runs block-time:refresh on a schedule.
#
# The schedule is read from block-time-config.json ("refreshSchedule": "hourly"|"daily"|"weekly").
# Falls back to "weekly" (every Monday at 8am) if not set.
#
# Usage:
#   npm run schedule:install               # reads refreshSchedule from config
#   npm run schedule:install -- --hourly   # override: every hour
#   npm run schedule:install -- --daily    # override: every day at 8am
#   npm run schedule:install -- --weekly   # override: every Monday at 8am

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_LABEL="com.calendar-tools.block-time"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
CONFIG_FILE="$PROJECT_DIR/block-time-config.json"

# Parse flag overrides
FLAG_SCHEDULE=""
for arg in "$@"; do
  [ "$arg" = "--hourly" ] && FLAG_SCHEDULE="hourly"
  [ "$arg" = "--daily" ]  && FLAG_SCHEDULE="daily"
  [ "$arg" = "--weekly" ] && FLAG_SCHEDULE="weekly"
done

# Read from config if no flag override
if [ -z "$FLAG_SCHEDULE" ] && [ -f "$CONFIG_FILE" ]; then
  FLAG_SCHEDULE="$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));process.stdout.write(c.refreshSchedule||'')}catch(e){}")"
fi

# Default to weekly
SCHEDULE="${FLAG_SCHEDULE:-weekly}"

mkdir -p "$LOG_DIR"

# Detect npm path
NPM_PATH="$(which npm)"
if [ -z "$NPM_PATH" ]; then
  echo "❌ npm not found. Make sure Node.js is installed and in your PATH."
  exit 1
fi

if [ "$SCHEDULE" = "hourly" ]; then
  SCHEDULE_KEY="StartInterval"
  SCHEDULE_VALUE="<integer>3600</integer>"
  SCHEDULE_DESC="every hour"
elif [ "$SCHEDULE" = "daily" ]; then
  SCHEDULE_KEY="StartCalendarInterval"
  SCHEDULE_VALUE='<dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>'
  SCHEDULE_DESC="every day at 8am"
else
  SCHEDULE_KEY="StartCalendarInterval"
  SCHEDULE_VALUE='<dict>
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

  <key>$SCHEDULE_KEY</key>
  $SCHEDULE_VALUE

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
