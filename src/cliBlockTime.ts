#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  makeOAuth2Client,
  runAuthFlow,
  setRefreshToken,
  getOrCreateBlockedCalendar,
  listOtherCalendarIds,
  queryBusyIntervals,
  listEvents,
  createEvent,
  deleteEvent,
} from './googleCalendar.js';
import { enrichWithAI } from './suggestions.js';
import {
  type Config,
  type ScheduleReport,
  DEFAULT_CONFIG,
  scheduleBlocks,
  durationMinutes,
  formatTime,
  formatDayLabel,
  groupByWeek,
  buildTargetDays,
} from './scheduler.js';

function printReport(
  missedLunch: ScheduleReport['missedLunch'],
  focusShortfall: ScheduleReport['focusShortfall']
): void {
  if (missedLunch.length === 0 && !focusShortfall) return;
  console.log('\n⚠️  Heads up:');
  for (const m of missedLunch) {
    console.log(`\n  🍝 No lunch on ${m.day}`);
    console.log(`     ${m.reason}`);
    console.log(`     💡 ${m.suggestion}`);
  }
  if (focusShortfall) {
    console.log(`\n  🤓 Focus time: ${focusShortfall.scheduled.toFixed(1)}h scheduled of ${focusShortfall.weeklyTarget.toFixed(1)}h target`);
    for (const s of focusShortfall.suggestions) {
      console.log(`     💡 ${s}`);
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Env helpers ───────────────────────────────────────────────────────────────

const ENV_PATH = join(__dirname, '..', '.env');

function loadEnv(): Record<string, string> {
  const raw = readFileSync(ENV_PATH, 'utf8');
  const env: Record<string, string> = {};
  raw.split('\n').forEach((line) => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) env[key.trim()] = rest.join('=').trim();
  });
  return env;
}

function saveEnvKey(key: string, value: string): void {
  let raw = readFileSync(ENV_PATH, 'utf8');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (regex.test(raw)) {
    raw = raw.replace(regex, `${key}=${value}`);
  } else {
    raw = raw.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, raw, 'utf8');
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  configPath?: string;
  days?: number;
  dryRun: boolean;
  refresh: boolean;
  setupAuth: boolean;
} {
  const out = { dryRun: false, refresh: false, setupAuth: false } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' && argv[i + 1]) out.configPath = argv[++i];
    else if (a === '--days' && argv[i + 1]) out.days = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--setup-auth') out.setupAuth = true;
  }
  return out;
}

function loadConfig(pathFromArg?: string): Config {
  if (!pathFromArg) return { ...DEFAULT_CONFIG };
  const raw = readFileSync(join(process.cwd(), pathFromArg), 'utf8');
  const parsed = JSON.parse(raw) as Partial<Config>;
  return {
    days: parsed.days ?? DEFAULT_CONFIG.days,
    weekdaysOnly: parsed.weekdaysOnly ?? DEFAULT_CONFIG.weekdaysOnly,
    workDayStart: parsed.workDayStart ?? DEFAULT_CONFIG.workDayStart,
    workDayEnd: parsed.workDayEnd ?? DEFAULT_CONFIG.workDayEnd,
    lunch: { ...DEFAULT_CONFIG.lunch, ...parsed.lunch },
    focusTime: { ...DEFAULT_CONFIG.focusTime, ...parsed.focusTime },
    meetingBreak: { ...DEFAULT_CONFIG.meetingBreak, ...parsed.meetingBreak },
    aiInstructions: parsed.aiInstructions,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { configPath, days, dryRun, refresh, setupAuth } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  if (Number.isFinite(days)) config.days = Math.max(1, Math.floor(days!));

  const env = loadEnv();

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
    process.exit(1);
  }

  let oauthClient = makeOAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);

  if (setupAuth || !env.GOOGLE_REFRESH_TOKEN) {
    if (!setupAuth) console.log('ℹ️  No GOOGLE_REFRESH_TOKEN found — starting one-time auth setup...');
    const refreshToken = await runAuthFlow(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    saveEnvKey('GOOGLE_REFRESH_TOKEN', refreshToken);
    console.log('✅ Refresh token saved to .env');
    if (setupAuth) { console.log('   Run `npm run block-time` to create your blocks.'); return; }
    const freshEnv = loadEnv();
    oauthClient = makeOAuth2Client(freshEnv.GOOGLE_CLIENT_ID, freshEnv.GOOGLE_CLIENT_SECRET);
    setRefreshToken(oauthClient, freshEnv.GOOGLE_REFRESH_TOKEN);
  } else {
    setRefreshToken(oauthClient, env.GOOGLE_REFRESH_TOKEN);
  }

  const blockedCalId = await getOrCreateBlockedCalendar(oauthClient);
  console.log(`📅 Using calendar ID: ${blockedCalId}`);

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const windowEnd = new Date(now.getTime() + config.days * 24 * 60 * 60_000);

  if (refresh && !dryRun) {
    console.log('\n🗑️  Clearing existing blocks...');
    const existingEvents = await listEvents(oauthClient, blockedCalId, now, windowEnd);
    for (const e of existingEvents) await deleteEvent(oauthClient, blockedCalId, e.id);
    console.log(`   Deleted ${existingEvents.length} events`);
  }

  let existingGCalKeys = new Set<string>();
  if (!refresh) {
    const existingEvents = await listEvents(oauthClient, blockedCalId, now, windowEnd);
    for (const e of existingEvents) {
      existingGCalKeys.add(`${e.summary}::${new Date(e.start).toISOString()}`);
    }
  }

  console.log('\n📅 Checking calendar availability...');
  const otherCalIds = await listOtherCalendarIds(oauthClient, blockedCalId);
  const busyIntervals = await queryBusyIntervals(oauthClient, otherCalIds, now, windowEnd);
  console.log(`   Found ${busyIntervals.confirmed.length} confirmed, ${busyIntervals.all.length - busyIntervals.confirmed.length} tentative intervals across ${otherCalIds.length} calendars`);

  let report = scheduleBlocks(config, busyIntervals.confirmed, busyIntervals.all);
  if (env.OPENAI_API_KEY) report = await enrichWithAI(report, env.OPENAI_API_KEY, busyIntervals.confirmed, config.aiInstructions);
  const { blocks: allBlocks, missedLunch, focusShortfall } = report;

  if (dryRun) {
    let totalFocusMin = 0, lunchCount = 0;
    const lines: string[] = [];
    for (const b of allBlocks) {
      const dur = durationMinutes(b.start, b.end);
      const timeRange = `${formatTime(b.start)} – ${formatTime(b.end)}`;
      lines.push(`  ${formatDayLabel(b.start).padEnd(16)} ${timeRange.padEnd(22)} ${b.label}  (${dur}m)`);
      if (b.label === '🤓 Focus Time') totalFocusMin += dur;
      else lunchCount++;
    }
    const weeks = groupByWeek(buildTargetDays(config));
    console.log(`\nWould create ${allBlocks.length} blocks:`);
    console.log(lines.join('\n'));
    console.log(`\n  Lunch:      ${lunchCount} blocks`);
    console.log(`  Focus time: ${(totalFocusMin / 60).toFixed(1)}h total (target: ${config.focusTime.weeklyTargetHours}h/week × ${weeks.length} week${weeks.length !== 1 ? 's' : ''})`);
    printReport(missedLunch, focusShortfall);
    return;
  }

  console.log(`\n📝 Scheduling ${allBlocks.length} blocks...`);
  let created = 0, skipped = 0;
  for (const block of allBlocks) {
    const gcalKey = `${block.label}::${block.start.toISOString()}`;
    if (existingGCalKeys.has(gcalKey)) {
      skipped++;
    } else {
      await createEvent(oauthClient, blockedCalId, block.label, block.start, block.end);
      console.log(`   ✓ ${block.label}: ${formatDayLabel(block.start)} ${formatTime(block.start)} – ${formatTime(block.end)}`);
      created++;
    }
  }
  console.log(`\n✅ Done.  Created: ${created}  Skipped: ${skipped}`);
  printReport(missedLunch, focusShortfall);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
