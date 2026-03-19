import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import {
  makeOAuth2Client,
  setRefreshToken,
  getOrCreateBlockedCalendar,
  listOtherCalendarIds,
  queryBusyIntervals,
  listEvents,
  createEvent,
  deleteEvent,
} from './googleCalendar.js';
import {
  type Config,
  DEFAULT_CONFIG,
  scheduleBlocks,
  durationMinutes,
  formatTime,
  formatDayLabel,
  groupByWeek,
  buildTargetDays,
} from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3000;
const ENV_PATH = join(__dirname, '..', '.env');
const CONFIG_PATH = join(__dirname, '..', 'block-time-config.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// ── Env helpers ───────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const raw = readFileSync(ENV_PATH, 'utf8');
  const env: Record<string, string> = {};
  raw.split('\n').forEach((line) => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) env[key.trim()] = rest.join('=').trim();
  });
  return env;
}

function saveEnvKey(key: string, value: string): void {
  let raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (regex.test(raw)) {
    raw = raw.replace(regex, `${key}=${value}`);
  } else {
    raw = raw.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, raw, 'utf8');
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  return {
    days: parsed.days ?? DEFAULT_CONFIG.days,
    weekdaysOnly: parsed.weekdaysOnly ?? DEFAULT_CONFIG.weekdaysOnly,
    workDayStart: parsed.workDayStart ?? DEFAULT_CONFIG.workDayStart,
    workDayEnd: parsed.workDayEnd ?? DEFAULT_CONFIG.workDayEnd,
    lunch: { ...DEFAULT_CONFIG.lunch, ...parsed.lunch },
    focusTime: { ...DEFAULT_CONFIG.focusTime, ...parsed.focusTime },
    meetingBreak: { ...DEFAULT_CONFIG.meetingBreak, ...parsed.meetingBreak },
  };
}

function getOAuthClient(redirectUri: string): OAuth2Client {
  const env = loadEnv();
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri);
}

function redirectUri(): string {
  return `http://localhost:${PORT}/auth/callback`;
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/auth/start', (_req, res) => {
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    res.status(400).json({ error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first' });
    return;
  }
  const client = getOAuthClient(redirectUri());
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) { res.status(400).send('Missing code'); return; }
  try {
    const client = getOAuthClient(redirectUri());
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      res.status(400).send('No refresh token — revoke app access at myaccount.google.com/permissions and try again.');
      return;
    }
    saveEnvKey('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
    res.redirect('/?auth=success');
  } catch (e: any) {
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const env = loadEnv();
  res.json({
    hasClientId: !!env.GOOGLE_CLIENT_ID,
    hasClientSecret: !!env.GOOGLE_CLIENT_SECRET,
    authenticated: !!env.GOOGLE_REFRESH_TOKEN,
    config: loadConfig(),
  });
});

app.post('/api/config', (req, res) => {
  const incoming = req.body as Partial<Config>;
  const merged: Config = {
    days: incoming.days ?? DEFAULT_CONFIG.days,
    weekdaysOnly: incoming.weekdaysOnly ?? DEFAULT_CONFIG.weekdaysOnly,
    workDayStart: incoming.workDayStart ?? DEFAULT_CONFIG.workDayStart,
    workDayEnd: incoming.workDayEnd ?? DEFAULT_CONFIG.workDayEnd,
    lunch: { ...DEFAULT_CONFIG.lunch, ...incoming.lunch },
    focusTime: { ...DEFAULT_CONFIG.focusTime, ...incoming.focusTime },
    meetingBreak: { ...DEFAULT_CONFIG.meetingBreak, ...incoming.meetingBreak },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  res.json({ ok: true, config: merged });
});

app.post('/api/run', async (req, res) => {
  const dryRun: boolean = req.body.dryRun ?? false;
  const refresh: boolean = req.body.refresh ?? false;
  const env = loadEnv();

  if (!env.GOOGLE_REFRESH_TOKEN) {
    res.status(401).json({ error: 'Not authenticated. Connect Google Calendar first.' });
    return;
  }

  try {
    const oauthClient = makeOAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    setRefreshToken(oauthClient, env.GOOGLE_REFRESH_TOKEN);

    const config = loadConfig();
    const blockedCalId = await getOrCreateBlockedCalendar(oauthClient);

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const windowEnd = new Date(now.getTime() + config.days * 24 * 60 * 60_000);

    if (refresh && !dryRun) {
      const existing = await listEvents(oauthClient, blockedCalId, now, windowEnd);
      for (const e of existing) await deleteEvent(oauthClient, blockedCalId, e.id);
    }

    let existingGCalKeys = new Set<string>();
    if (!refresh) {
      const existing = await listEvents(oauthClient, blockedCalId, now, windowEnd);
      for (const e of existing) existingGCalKeys.add(`${e.summary}::${new Date(e.start).toISOString()}`);
    }

    const otherCalIds = await listOtherCalendarIds(oauthClient, blockedCalId);
    const busyIntervals = await queryBusyIntervals(oauthClient, otherCalIds, now, windowEnd);
    const { blocks: allBlocks, missedLunch, focusShortfall } = scheduleBlocks(config, busyIntervals.confirmed, busyIntervals.all);

    type BlockResult = {
      label: string;
      start: string;
      end: string;
      day: string;
      timeRange: string;
      duration: number;
      created?: boolean;
      skipped?: boolean;
    };

    const results: BlockResult[] = [];

    for (const block of allBlocks) {
      const gcalKey = `${block.label}::${block.start.toISOString()}`;
      const entry: BlockResult = {
        label: block.label,
        start: block.start.toISOString(),
        end: block.end.toISOString(),
        day: formatDayLabel(block.start),
        timeRange: `${formatTime(block.start)} – ${formatTime(block.end)}`,
        duration: durationMinutes(block.start, block.end),
      };

      if (dryRun) {
        results.push(entry);
      } else if (existingGCalKeys.has(gcalKey)) {
        results.push({ ...entry, skipped: true });
      } else {
        await createEvent(oauthClient, blockedCalId, block.label, block.start, block.end);
        results.push({ ...entry, created: true });
      }
    }

    const weeks = groupByWeek(buildTargetDays(config));
    const totalFocusMin = allBlocks
      .filter((b) => b.label === '🤓 Focus Time')
      .reduce((sum, b) => sum + durationMinutes(b.start, b.end), 0);

    res.json({
      dryRun,
      blocks: results,
      summary: {
        total: allBlocks.length,
        created: results.filter((r) => r.created).length,
        skipped: results.filter((r) => r.skipped).length,
        lunchCount: allBlocks.filter((b) => b.label === '🍝 Lunch').length,
        focusHours: parseFloat((totalFocusMin / 60).toFixed(1)),
        weeklyTarget: config.focusTime.weeklyTargetHours,
        weeks: weeks.length,
      },
      missedLunch,
      focusShortfall,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

createServer(app).listen(PORT, () => {
  console.log(`\n✅ Block Time running at http://localhost:${PORT}`);
  console.log(`   Add this redirect URI to your Google OAuth credentials:`);
  console.log(`   http://localhost:${PORT}/auth/callback\n`);
});
