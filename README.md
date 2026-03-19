# Calendar Tools

Automatically block focus time and lunch on your Google Calendar — a self-hosted alternative to Clockwise.

Checks your existing events, finds free slots, and creates blocks in a dedicated "Blocked Time" calendar so colleagues see you as busy without exposing the names of your private events.

## How it works

- Creates a separate **Blocked Time** calendar in your Google account
- Queries your real calendar for busy time before scheduling anything
- Schedules **🍝 Lunch** in the first available gap in your lunch window
- Schedules **🤓 Focus Time** to hit a weekly hour target, preferring afternoons
- Adds **☕ Meeting Breaks** after long stretches of back-to-back meetings
- Respects tentative events for focus time, but lunch can go over them
- Prorates focus time automatically if you run it mid-week
- Optionally uses OpenAI to explain missed blocks and suggest which specific meetings to move

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get Google OAuth credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project
2. Enable the **Google Calendar API**
3. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Choose **Desktop app** (for CLI) or **Web application** (for the UI — add `http://localhost:3000/auth/callback` as an authorized redirect URI)
5. Copy the Client ID and Client Secret

### 3. Configure your environment

```bash
cp env.example .env
```

Add your credentials to `.env`:

```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here

# Optional: enables AI suggestions for missed blocks
OPENAI_API_KEY=your_openai_key_here
```

### 4. Connect your Google account

**Web UI (recommended):**
```bash
npm run server
```
Open `http://localhost:3000` and click **Connect Google**.

**CLI:**
```bash
npm run block-time:setup-auth
```

## Usage

### Web UI

```bash
npm run server
```

Open `http://localhost:3000` — configure your schedule, preview blocks, and create or refresh them all from the browser.

### CLI

```bash
# Preview what would be created (reads your real calendar, creates nothing)
npm run block-time:dry-run

# Create blocks for the next 14 days (skips ones that already exist)
npm run block-time

# Wipe and recreate all blocks — use after your calendar changes
npm run block-time:refresh
```

## Configuration

All settings are available in the web UI. To configure via file, create `block-time-config.json` in the project root:

```json
{
  "days": 14,
  "weekdaysOnly": true,
  "workDayStart": "08:00",
  "workDayEnd": "17:00",
  "lunch": {
    "windowStart": "11:00",
    "windowEnd": "12:30",
    "minMinutes": 30,
    "maxMinutes": 60
  },
  "focusTime": {
    "weeklyTargetHours": 8,
    "minBlockMinutes": 60,
    "maxBlockMinutes": 180,
    "maxDailyFocusHours": 3,
    "preferAfterTime": "11:00"
  },
  "meetingBreak": {
    "enabled": true,
    "thresholdHours": 2,
    "durationMinutes": 15,
    "gapToleranceMinutes": 5
  },
  "aiInstructions": "Never suggest moving Weekly All-Hands."
}
```

| Field | Description |
|---|---|
| `days` | How many days ahead to schedule |
| `weekdaysOnly` | Skip weekends |
| `workDayStart` / `workDayEnd` | Focus blocks won't go outside these hours |
| `lunch.windowStart` / `windowEnd` | Earliest start and latest end for lunch |
| `lunch.minMinutes` | Skip lunch if less than this is free in the window |
| `lunch.maxMinutes` | Cap lunch at this length |
| `focusTime.weeklyTargetHours` | Hours of focus to schedule per week |
| `focusTime.minBlockMinutes` | Don't create a focus block shorter than this |
| `focusTime.maxBlockMinutes` | Cap any single focus block at this length |
| `focusTime.maxDailyFocusHours` | Cap total focus time across all blocks in a single day |
| `focusTime.preferAfterTime` | Try afternoon slots first, fall back to morning |
| `meetingBreak.enabled` | Whether to insert breaks after long meeting runs |
| `meetingBreak.thresholdHours` | Insert a break after this many consecutive hours of meetings |
| `meetingBreak.durationMinutes` | Length of the break |
| `meetingBreak.gapToleranceMinutes` | Meetings within this gap count as consecutive |
| `aiInstructions` | Extra context for the AI suggestions (requires `OPENAI_API_KEY`) |

## Requirements

- Node.js 18+
- A Google account

---

## Other files in this repo

This repo also contains some personal tooling for [Motion](https://www.usemotion.com) (a task manager) that isn't part of the calendar blocking feature:

| File | What it does |
|---|---|
| `index.js` / `tasks.json` | Bulk-creates Motion tasks from a JSON file |
| `src/cliMotionNotes.ts` | Converts freeform notes into Motion tasks via OpenAI |
| `pull-open-tasks.js` | Dumps open Motion tasks to markdown for LLM prioritization |
| `fetch-projects.js` | Lists/searches Motion projects by name |

These require a `MOTION_API_KEY` and `MOTION_WORKSPACE_ID` in your `.env`. They're independent of the calendar tools and can be ignored if you're only here for the focus blocking.
