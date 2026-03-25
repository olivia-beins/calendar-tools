#!/bin/bash
PLIST_LABEL="com.calendar-tools.slack-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "No Slack sync job found."
  exit 0
fi

launchctl unload "$PLIST_PATH"
rm "$PLIST_PATH"
echo "✅ Slack sync schedule removed."
