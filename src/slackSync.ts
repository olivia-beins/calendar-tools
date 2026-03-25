import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeOAuth2Client, setRefreshToken, listOtherCalendarIds, queryBusyIntervals } from './googleCalendar.js';
import { DEFAULT_CONFIG, type Config } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const CONFIG_PATH = join(__dirname, '..', 'block-time-config.json');

// ── Env ────────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  readFileSync(ENV_PATH, 'utf8').split('\n').forEach((line) => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) env[key.trim()] = rest.join('=').trim();
  });
  return env;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    lunch: { ...DEFAULT_CONFIG.lunch, ...parsed.lunch },
    focusTime: { ...DEFAULT_CONFIG.focusTime, ...parsed.focusTime },
    meetingBreak: { ...DEFAULT_CONFIG.meetingBreak, ...parsed.meetingBreak },
    customCategories: parsed.customCategories ?? [],
  };
}

// ── Slack ──────────────────────────────────────────────────────────────────────

type SlackStatus = {
  status_text: string;
  status_emoji: string;
  status_expiration: number;
};

async function setSlackStatus(token: string, status: SlackStatus): Promise<void> {
  const res = await fetch('https://slack.com/api/users.profile.set', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ profile: status }),
  });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
}

async function clearSlackStatus(token: string): Promise<void> {
  await setSlackStatus(token, { status_text: '', status_emoji: '', status_expiration: 0 });
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function syncSlackStatus(): Promise<void> {
  const env = loadEnv();

  if (!env.SLACK_USER_TOKEN) throw new Error('SLACK_USER_TOKEN not set in .env');
  if (!env.GOOGLE_REFRESH_TOKEN) throw new Error('GOOGLE_REFRESH_TOKEN not set in .env');

  const oauthClient = makeOAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  setRefreshToken(oauthClient, env.GOOGLE_REFRESH_TOKEN);

  const config = loadConfig();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 60 * 60_000);

  const otherCalIds = await listOtherCalendarIds(oauthClient, '');
  const { confirmed, all } = await queryBusyIntervals(oauthClient, otherCalIds, now, windowEnd);

  // Check custom categories with Slack status defined
  const activeCustomCategory = (config.customCategories ?? []).find(cat => {
    if (!cat.enabled || !cat.slackStatusText) return false;
    const label = `${cat.emoji} ${cat.name}`;
    return all.some(e => e.start <= now && e.end > now && e.summary === label);
  });

  // Check built-in blocks
  const blockedLabels = ['🤓 Focus Time', '🍝 Lunch', '☕ Meeting Break'];
  const activeBlock = all.find(
    (e) => e.start <= now && e.end > now && blockedLabels.some((l) => e.summary?.includes(l))
  );

  // Check regular meetings
  const activeEvent = confirmed.find((e) => e.start <= now && e.end > now);

  if (activeCustomCategory) {
    const label = `${activeCustomCategory.emoji} ${activeCustomCategory.name}`;
    const matchingEvent = all.find(e => e.start <= now && e.end > now && e.summary === label);
    const expiration = matchingEvent ? Math.floor(matchingEvent.end.getTime() / 1000) : 0;
    await setSlackStatus(env.SLACK_USER_TOKEN, {
      status_text: activeCustomCategory.slackStatusText!,
      status_emoji: activeCustomCategory.slackStatusEmoji || ':calendar:',
      status_expiration: expiration,
    });
    console.log(`✅ Status set: ${activeCustomCategory.slackStatusText} (until ${matchingEvent?.end.toLocaleTimeString() ?? 'unknown'})`);
  } else if (activeBlock) {
    const expiration = Math.floor(activeBlock.end.getTime() / 1000);
    const isLunch = activeBlock.summary?.includes('Lunch');
    const isBreak = activeBlock.summary?.includes('Meeting Break');
    await setSlackStatus(env.SLACK_USER_TOKEN, {
      status_text: isLunch ? 'Out for lunch' : isBreak ? 'Taking a break' : 'Focusing',
      status_emoji: isLunch ? ':fork_and_knife:' : isBreak ? ':coffee:' : ':headphones:',
      status_expiration: expiration,
    });
    console.log(`✅ Status set: ${isLunch ? 'Out for lunch' : isBreak ? 'Taking a break' : 'Focusing'} (until ${activeBlock.end.toLocaleTimeString()})`);
  } else if (activeEvent) {
    const expiration = Math.floor(activeEvent.end.getTime() / 1000);
    await setSlackStatus(env.SLACK_USER_TOKEN, {
      status_text: 'In a meeting',
      status_emoji: ':calendar:',
      status_expiration: expiration,
    });
    console.log(`✅ Status set: In a meeting (until ${activeEvent.end.toLocaleTimeString()})`);
  } else {
    await clearSlackStatus(env.SLACK_USER_TOKEN);
    console.log('✅ Status cleared (no active event)');
  }
}
