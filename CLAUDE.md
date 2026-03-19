# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build                   # Compile TypeScript → dist/

# Calendar blocking (primary feature)
npm run block-time              # Create blocks for next 14 days (skips existing)
npm run block-time:dry-run      # Preview without creating
npm run block-time:refresh      # Delete and recreate all blocks
npm run block-time:setup-auth   # One-time Google OAuth setup

# Web UI
npm run server                  # Start UI at http://localhost:3000

# macOS scheduling
npm run schedule:install        # Install launchd job (Monday 8am refresh)
npm run schedule:uninstall      # Remove launchd job

# Motion tooling (secondary)
npm run motion-notes -- "text"  # Convert notes to Motion tasks
npm run fetch-projects          # List Motion projects
npm run pull-open-tasks         # Export open tasks to markdown
```

No test suite exists in this project.

## Architecture

This is a **Google Calendar automation tool** (Clockwise replacement) that schedules focus time and lunch blocks. Two interfaces: CLI (`cliBlockTime.ts`) and Express web UI (`server.ts`).

### Primary flow

1. **Auth**: OAuth2 via `googleCalendar.ts` — saves refresh token to `.env`
2. **Config**: Loaded from `block-time-config.json` (created by web UI) or hardcoded defaults in `scheduler.ts`
3. **Busy query**: `googleCalendar.ts:queryBusyIntervals()` returns two sets — confirmed-only and confirmed+tentative — from all user calendars
4. **Scheduling** (`scheduler.ts:scheduleBlocks()`):
   - Lunch: first gap in window; respects confirmed events only (tentative don't block lunch)
   - Focus blocks: prefers afternoon (`preferAfterTime`), falls back to morning; capped at `maxBlockMinutes`
   - Meeting breaks: 15-min gaps after 2+ consecutive hours of meetings
   - Focus target is prorated for partial weeks
5. **AI enrichment** (optional): `suggestions.ts` calls GPT-4o-mini if `OPENAI_API_KEY` is set — explains missed lunch and suggests alternatives for focus shortfalls
6. **Event creation**: Creates events in a dedicated "Blocked Time" calendar; skips duplicates by matching `summary + start time`

### Key files

| File | Role |
|------|------|
| `src/scheduler.ts` | Core algorithm — free interval detection, lunch/focus/break scheduling, proration |
| `src/googleCalendar.ts` | Google Calendar API — OAuth, event CRUD, busy intervals |
| `src/cliBlockTime.ts` | CLI entry point — wires auth → schedule → create |
| `src/server.ts` | Web server — OAuth callback, config API, `/api/run` endpoint |
| `src/suggestions.ts` | GPT integration for schedule report enrichment |

### Secondary feature: Motion task tooling

`src/motionNotesAgent.ts` uses GPT-4o-mini to parse freeform notes into structured tasks, then fuzzy-matches them to Motion projects (`src/motionProjects.ts`) and creates them via `src/motionClient.ts` (rate-limited to 12 req/min).

## Environment variables

Required for calendar blocking:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
- `GOOGLE_REFRESH_TOKEN` — auto-set by `setup-auth`

Optional:
- `OPENAI_API_KEY` — enables AI suggestions
- `MOTION_API_KEY`, `MOTION_WORKSPACE_ID` — for Motion task features
- `TRIAGE_PROJECT_ID`, `DEFAULT_PROJECT_ID`, `CLOCKWISE_PROJECT_NAME` — Motion routing
- `DEBUG=true` — verbose logging

## Calendar event conventions

Blocked events are created with `transparency: "opaque"` (shows as busy), `visibility: "public"` (colleagues see event names, not details), in a calendar named "Blocked Time" separate from the user's primary calendar.
