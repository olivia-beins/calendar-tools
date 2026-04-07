import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as http from 'http';
import { exec } from 'child_process';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const BLOCKED_TIME_CALENDAR_NAME = 'Blocked Time';

function getRedirectUri(port: number): string {
  return `http://localhost:${port}`;
}

export function makeOAuth2Client(
  clientId: string,
  clientSecret: string,
  port = 0
): OAuth2Client {
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri(port));
}

function openBrowser(url: string): void {
  // macOS
  exec(`open "${url}"`, (err) => {
    if (err) console.log(`Could not open browser automatically. Open this URL manually:\n${url}`);
  });
}

export async function runAuthFlow(
  clientId: string,
  clientSecret: string
): Promise<string> {
  // Start a local server on an OS-assigned port to receive the OAuth callback
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const client = makeOAuth2Client(clientId, clientSecret, port);
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  console.log('\n🔐 Google Calendar Authorization Required');
  console.log('Opening browser for authorization...');
  openBrowser(url);

  const code = await new Promise<string>((resolve, reject) => {
    server.once('request', (req, res) => {
      const rawUrl = req.url ?? '';
      const params = new URL(rawUrl, `http://localhost:${port}`).searchParams;
      const code = params.get('code');
      const error = params.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<h2>Authorization successful!</h2><p>You can close this tab and return to your terminal.</p>');
        resolve(code);
      } else {
        res.end(`<h2>Authorization failed</h2><p>${error ?? 'Unknown error'}</p>`);
        reject(new Error(`OAuth error: ${error ?? 'no code returned'}`));
      }
      server.close();
    });
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. Go to https://myaccount.google.com/permissions, ' +
      'revoke access for this app, and run setup-auth again.'
    );
  }
  client.setCredentials(tokens);
  return tokens.refresh_token;
}

export function setRefreshToken(client: OAuth2Client, refreshToken: string): void {
  client.setCredentials({ refresh_token: refreshToken });
}

export async function getOrCreateBlockedCalendar(auth: OAuth2Client): Promise<string> {
  const cal = google.calendar({ version: 'v3', auth });
  const { data } = await cal.calendarList.list();
  const existing = data.items?.find((c) => c.summary === BLOCKED_TIME_CALENDAR_NAME);
  if (existing?.id) {
    return existing.id;
  }

  const { data: created } = await cal.calendars.insert({
    requestBody: { summary: BLOCKED_TIME_CALENDAR_NAME },
  });
  if (!created.id) throw new Error('Failed to create calendar');
  console.log(`📅 Created new Google Calendar: "${BLOCKED_TIME_CALENDAR_NAME}"`);
  return created.id;
}

export interface GCalEvent {
  id: string;
  summary: string;
  start: string; // ISO string
  end: string;   // ISO string
}

export async function listEvents(
  auth: OAuth2Client,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<GCalEvent[]> {
  const cal = google.calendar({ version: 'v3', auth });
  const events: GCalEvent[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await cal.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });
    for (const e of data.items ?? []) {
      if (e.id && e.summary && e.start?.dateTime && e.end?.dateTime) {
        events.push({ id: e.id, summary: e.summary, start: e.start.dateTime, end: e.end.dateTime });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}

export async function createEvent(
  auth: OAuth2Client,
  calendarId: string,
  summary: string,
  start: Date,
  end: Date,
  visibility: 'public' | 'private' = 'public'
): Promise<string> {
  const cal = google.calendar({ version: 'v3', auth });
  const { data } = await cal.events.insert({
    calendarId,
    requestBody: {
      summary,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      status: 'confirmed',
      transparency: 'opaque', // shows as "busy"
      visibility,
    },
  });
  if (!data.id) throw new Error('Event creation returned no ID');
  return data.id;
}

/** Lists timed events from a calendar, returning only start/end times.
 *  Unlike listEvents, does not require a summary — works with free/busy-only access. */
export async function listEventIntervals(
  auth: OAuth2Client,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<{ start: Date; end: Date }[]> {
  const cal = google.calendar({ version: 'v3', auth });
  const intervals: { start: Date; end: Date }[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await cal.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });
    for (const e of data.items ?? []) {
      if (e.status === 'cancelled') continue;
      if (!e.start?.dateTime || !e.end?.dateTime) continue;
      intervals.push({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) });
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return intervals;
}

export async function listCalendars(
  auth: OAuth2Client
): Promise<{ id: string; name: string }[]> {
  const cal = google.calendar({ version: 'v3', auth });
  const { data } = await cal.calendarList.list();
  return (data.items ?? [])
    .filter((c) => c.id && c.summary)
    .map((c) => ({ id: c.id!, name: c.summary! }));
}

export async function deleteEvent(
  auth: OAuth2Client,
  calendarId: string,
  eventId: string
): Promise<void> {
  const cal = google.calendar({ version: 'v3', auth });
  await cal.events.delete({ calendarId, eventId });
}

export interface BusyInterval {
  start: Date;
  end: Date;
  summary?: string;
}

/** Returns IDs of all calendars the user has, excluding the given one. */
export async function listOtherCalendarIds(
  auth: OAuth2Client,
  excludeId: string
): Promise<string[]> {
  const cal = google.calendar({ version: 'v3', auth });
  const { data } = await cal.calendarList.list();
  return (data.items ?? [])
    .map((c) => c.id!)
    .filter((id) => id && id !== excludeId);
}

export interface BusyIntervals {
  confirmed: BusyInterval[];  // confirmed events only
  all: BusyInterval[];        // confirmed + tentative
}

/**
 * Lists events across multiple calendars and returns them split by status.
 * Use `confirmed` to treat tentative events as free, `all` to treat them as busy.
 */
export async function queryBusyIntervals(
  auth: OAuth2Client,
  calendarIds: string[],
  timeMin: Date,
  timeMax: Date
): Promise<BusyIntervals> {
  const cal = google.calendar({ version: 'v3', auth });
  const confirmed: BusyInterval[] = [];
  const tentative: BusyInterval[] = [];

  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    do {
      const { data } = await cal.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      for (const e of data.items ?? []) {
        if (e.status === 'cancelled') continue;
        if (!e.start?.dateTime || !e.end?.dateTime) continue;
        // Skip events where the user is the organizer with no other attendees (their own blocks)
        const interval = { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime), summary: e.summary ?? undefined };
        const selfAttendee = e.attendees?.find((a) => a.self);
        const isTentative =
          e.status === 'tentative' ||
          selfAttendee?.responseStatus === 'tentative' ||
          selfAttendee?.responseStatus === 'needsAction';
        if (isTentative) {
          tentative.push(interval);
        } else {
          confirmed.push(interval);
        }
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return { confirmed, all: [...confirmed, ...tentative] };
}
