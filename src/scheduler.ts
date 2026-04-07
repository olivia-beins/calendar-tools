export type LunchConfig = {
  enabled: boolean;
  windowStart: string;  // "HH:MM"
  windowEnd: string;    // "HH:MM"
  minMinutes: number;
  maxMinutes: number;
};

export type FocusConfig = {
  enabled: boolean;
  weeklyTargetHours: number;
  minBlockMinutes: number;
  maxBlockMinutes: number;
  maxDailyFocusHours: number;
  preferAfterTime?: string;  // "HH:MM" — try afternoons first
};

export type MeetingBreakConfig = {
  enabled: boolean;
  thresholdHours: number;   // trigger a break after this many hours of consecutive meetings
  durationMinutes: number;  // length of the break
  gapToleranceMinutes: number; // meetings within this gap are treated as consecutive
};

export type CustomCategoryType = 'fixed' | 'lunch-style' | 'focus-style';

export type CustomCategory = {
  id: string;
  name: string;
  emoji: string;
  type: CustomCategoryType;
  enabled: boolean;
  slackStatusText?: string;
  slackStatusEmoji?: string;
  // lunch-style
  windowStart?: string;
  windowEnd?: string;
  minMinutes?: number;
  maxMinutes?: number;
  // focus-style
  weeklyTargetHours?: number;
  minBlockMinutes?: number;
  maxBlockMinutes?: number;
  maxDailyHours?: number;
  preferAfterTime?: string;
  // fixed
  fixedTime?: string;
  fixedDurationMinutes?: number;
  fixedDays?: 'weekdays' | 'all';
};

export type PersonalMirrorConfig = {
  enabled: boolean;
  calendarNames: string[];  // names as they appear in Google Calendar (usually the email address)
  lookAheadDays?: number;   // how far out to mirror (default: 30)
};

export type Config = {
  days: number;
  weekdaysOnly: boolean;
  workDayStart: string;  // "HH:MM"
  workDayEnd: string;    // "HH:MM"
  lunch: LunchConfig;
  focusTime: FocusConfig;
  meetingBreak: MeetingBreakConfig;
  aiInstructions?: string;  // extra context injected into the AI suggestions prompt
  customCategories?: CustomCategory[];
  personalMirror?: PersonalMirrorConfig;
};

export const DEFAULT_CONFIG: Config = {
  days: 14,
  weekdaysOnly: true,
  workDayStart: '08:00',
  workDayEnd: '17:00',
  lunch: {
    enabled: true,
    windowStart: '11:00',
    windowEnd: '12:30',
    minMinutes: 30,
    maxMinutes: 60,
  },
  focusTime: {
    enabled: true,
    weeklyTargetHours: 8,
    minBlockMinutes: 60,
    maxBlockMinutes: 180,
    maxDailyFocusHours: 3,
    preferAfterTime: '11:00',
  },
  meetingBreak: {
    enabled: true,
    thresholdHours: 2,
    durationMinutes: 15,
    gapToleranceMinutes: 5,
  },
  customCategories: [],
};

export type ScheduledBlock = {
  start: Date;
  end: Date;
  label: string;
};

export interface BusyInterval {
  start: Date;
  end: Date;
  summary?: string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function setTimeOnDay(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function durationMinutes(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

export function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Returns free intervals within [windowStart, windowEnd] after subtracting busy intervals. */
export function getFreeIntervals(
  windowStart: Date,
  windowEnd: Date,
  busy: BusyInterval[]
): { start: Date; end: Date }[] {
  const clipped = busy
    .filter((b) => b.end > windowStart && b.start < windowEnd)
    .map((b) => ({
      start: new Date(Math.max(b.start.getTime(), windowStart.getTime())),
      end: new Date(Math.min(b.end.getTime(), windowEnd.getTime())),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const free: { start: Date; end: Date }[] = [];
  let cursor = windowStart;
  for (const b of clipped) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < windowEnd) free.push({ start: cursor, end: windowEnd });
  return free;
}

/** Schedules one lunch block for a day if a sufficient gap exists.
 *  Falls back to the first free slot after the window (up to end of work day)
 *  if the preferred window is fully booked. */
export function scheduleLunch(
  day: Date,
  config: Config,
  busy: BusyInterval[]
): ScheduledBlock | null {
  const windowStart = setTimeOnDay(day, config.lunch.windowStart);
  const windowEnd = setTimeOnDay(day, config.lunch.windowEnd);
  const free = getFreeIntervals(windowStart, windowEnd, busy);
  const slot = free.find((s) => durationMinutes(s.start, s.end) >= config.lunch.minMinutes);
  if (slot) {
    const duration = Math.min(durationMinutes(slot.start, slot.end), config.lunch.maxMinutes);
    return { start: slot.start, end: addMinutes(slot.start, duration), label: '🍝 Lunch' };
  }

  // Fallback: look for a free slot after the window, up to end of work day
  const workEnd = setTimeOnDay(day, config.workDayEnd);
  const afterFree = getFreeIntervals(windowEnd, workEnd, busy);
  const fallback = afterFree.find((s) => durationMinutes(s.start, s.end) >= config.lunch.minMinutes);
  if (!fallback) return null;
  const duration = Math.min(durationMinutes(fallback.start, fallback.end), config.lunch.maxMinutes);
  return { start: fallback.start, end: addMinutes(fallback.start, duration), label: '🍝 Lunch' };
}

/** Schedules focus blocks across days to fill targetMinutes. Mutates busy. */
export function scheduleFocusBlocks(
  days: Date[],
  config: Config,
  busy: BusyInterval[],
  targetMinutes: number
): ScheduledBlock[] {
  const blocks: ScheduledBlock[] = [];
  let remaining = targetMinutes;

  type Candidate = { start: Date; end: Date; available: number };

  function collectCandidates(windowStart: string, windowEnd: string): Candidate[] {
    const result: Candidate[] = [];
    for (const day of days) {
      const start = setTimeOnDay(day, windowStart);
      const end = setTimeOnDay(day, windowEnd);
      for (const slot of getFreeIntervals(start, end, busy)) {
        const available = durationMinutes(slot.start, slot.end);
        if (available >= config.focusTime.minBlockMinutes) {
          result.push({ start: slot.start, end: slot.end, available });
        }
      }
    }
    return result.sort((a, b) => b.available - a.available);
  }

  const afternoonStart = config.focusTime.preferAfterTime ?? '11:00';
  const candidates: Candidate[] = [
    ...collectCandidates(afternoonStart, config.workDayEnd),
    ...collectCandidates(config.workDayStart, afternoonStart),
  ];

  const maxDailyMinutes = config.focusTime.maxDailyFocusHours * 60;
  const dailyScheduled = new Map<string, number>();
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const key = dayKey(candidate.start);
    if ((dailyScheduled.get(key) ?? 0) >= maxDailyMinutes) continue;
    const stillFree = getFreeIntervals(candidate.start, candidate.end, busy);
    for (const slot of stillFree) {
      if (remaining <= 0) break;
      const dayTotal = dailyScheduled.get(key) ?? 0;
      if (dayTotal >= maxDailyMinutes) break;
      const available = durationMinutes(slot.start, slot.end);
      if (available < config.focusTime.minBlockMinutes) continue;
      const rawDuration = Math.min(available, config.focusTime.maxBlockMinutes, remaining, maxDailyMinutes - dayTotal);
      const duration = Math.floor(rawDuration / 15) * 15;
      if (duration < config.focusTime.minBlockMinutes) continue;
      const start = slot.start;
      const end = addMinutes(start, duration);
      blocks.push({ start, end, label: '🤓 Focus Time' });
      busy.push({ start, end });
      remaining -= duration;
      dailyScheduled.set(key, dayTotal + duration);
    }
  }

  return blocks;
}

/** Groups days by ISO week (Monday as start). */
export function groupByWeek(days: Date[]): Date[][] {
  const map = new Map<string, Date[]>();
  for (const d of days) {
    const monday = new Date(d);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
    monday.setDate(monday.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }
  return [...map.values()];
}

/** Builds the target day list from today for config.days. */
export function buildTargetDays(config: Config): Date[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days: Date[] = [];
  for (let i = 0; i < config.days; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60_000);
    if (config.weekdaysOnly && isWeekend(d)) continue;
    days.push(d);
  }
  return days;
}

/**
 * Finds runs of consecutive confirmed meetings >= thresholdHours on a given day
 * and schedules a break after each run if the slot is free.
 * Meetings within gapToleranceMinutes of each other count as consecutive.
 */
export function scheduleMeetingBreaks(
  day: Date,
  config: Config,
  confirmedBusy: BusyInterval[],
  allBusy: BusyInterval[]
): ScheduledBlock[] {
  const { thresholdHours, durationMinutes: breakDuration, gapToleranceMinutes } = config.meetingBreak;
  const thresholdMs = thresholdHours * 60 * 60_000;
  const gapMs = gapToleranceMinutes * 60_000;

  const workStart = setTimeOnDay(day, config.workDayStart);
  const workEnd = setTimeOnDay(day, config.workDayEnd);

  // Only look at confirmed meetings within work hours on this day
  const dayMeetings = confirmedBusy
    .filter((b) => b.start >= workStart && b.end <= workEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (dayMeetings.length === 0) return [];

  // Merge meetings that are within gapTolerance of each other into runs
  const runs: { start: Date; end: Date }[] = [];
  let runStart = dayMeetings[0].start;
  let runEnd = dayMeetings[0].end;

  for (let i = 1; i < dayMeetings.length; i++) {
    const m = dayMeetings[i];
    if (m.start.getTime() - runEnd.getTime() <= gapMs) {
      if (m.end > runEnd) runEnd = m.end;
    } else {
      runs.push({ start: runStart, end: runEnd });
      runStart = m.start;
      runEnd = m.end;
    }
  }
  runs.push({ start: runStart, end: runEnd });

  const breaks: ScheduledBlock[] = [];
  for (const run of runs) {
    if (run.end.getTime() - run.start.getTime() < thresholdMs) continue;

    // Place break immediately after the run, if that slot is free
    const breakStart = run.end;
    const breakEnd = addMinutes(breakStart, breakDuration);
    if (breakEnd > workEnd) continue;

    const free = getFreeIntervals(breakStart, breakEnd, allBusy);
    if (free.some((s) => durationMinutes(s.start, s.end) >= breakDuration)) {
      breaks.push({ start: breakStart, end: breakEnd, label: '☕ Meeting Break' });
      allBusy.push({ start: breakStart, end: breakEnd });
    }
  }

  return breaks;
}

export type ScheduleReport = {
  blocks: ScheduledBlock[];
  missedLunch: { day: string; reason: string; suggestion: string }[];
  focusShortfall: { weeklyTarget: number; scheduled: number; suggestions: string[] } | null;
};

/** Explains why lunch couldn't be placed and suggests what to do. */
function lunchMissedSuggestion(
  day: Date,
  config: Config,
  busy: BusyInterval[]
): { reason: string; suggestion: string } {
  const windowStart = setTimeOnDay(day, config.lunch.windowStart);
  const windowEnd = setTimeOnDay(day, config.lunch.windowEnd);
  const free = getFreeIntervals(windowStart, windowEnd, busy);
  const longest = free.reduce((max, s) => {
    const dur = durationMinutes(s.start, s.end);
    return dur > max.dur ? { dur, slot: s } : max;
  }, { dur: 0, slot: null as { start: Date; end: Date } | null });

  if (longest.dur === 0) {
    // Window is completely blocked — find first free time after window
    const dayEnd = setTimeOnDay(day, config.workDayEnd);
    const afterWindow = getFreeIntervals(windowEnd, dayEnd, busy);
    const next = afterWindow.find((s) => durationMinutes(s.start, s.end) >= config.lunch.minMinutes);
    const suggestion = next
      ? `First free slot is ${formatTime(next.start)} (${durationMinutes(next.start, next.end)}m available) — could you move a meeting to open up your lunch window?`
      : `No free time found after the window either — this looks like a very heavy meeting day.`;
    return { reason: `Lunch window (${config.lunch.windowStart}–${config.lunch.windowEnd}) is fully booked`, suggestion };
  }

  const needed = config.lunch.minMinutes;
  const suggestion = longest.slot
    ? `Longest gap is ${longest.dur}m at ${formatTime(longest.slot.start)} — you need ${needed}m. Ending one meeting ${needed - longest.dur}m early would do it.`
    : `No usable gap found in the window.`;
  return { reason: `Largest free gap in window is ${longest.dur}m (need ${needed}m)`, suggestion };
}

/** Core scheduling: returns blocks plus a report on what couldn't be scheduled. */
export function scheduleBlocks(
  config: Config,
  confirmedBusy: BusyInterval[],
  allBusy: BusyInterval[]
): ScheduleReport {
  const targetDays = buildTargetDays(config);
  const lunchBusy: BusyInterval[] = [...confirmedBusy];
  const focusBusy: BusyInterval[] = [...allBusy];
  const allBlocks: ScheduledBlock[] = [];
  const missedLunch: ScheduleReport['missedLunch'] = [];

  // Fixed custom blocks are immovable — add them first so built-ins schedule around them
  for (const cat of (config.customCategories ?? [])) {
    if (!cat.enabled || cat.type !== 'fixed') continue;
    const label = `${cat.emoji} ${cat.name}`;
    for (const day of targetDays) {
      const dow = day.getDay();
      if (cat.fixedDays === 'weekdays' && (dow === 0 || dow === 6)) continue;
      const start = setTimeOnDay(day, cat.fixedTime!);
      const end = addMinutes(start, cat.fixedDurationMinutes!);
      allBlocks.push({ start, end, label });
      lunchBusy.push({ start, end });
      focusBusy.push({ start, end });
    }
  }

  for (const day of targetDays) {
    if (config.meetingBreak.enabled) {
      allBlocks.push(...scheduleMeetingBreaks(day, config, confirmedBusy, focusBusy));
    }

    if (config.lunch.enabled) {
      const lunch = scheduleLunch(day, config, lunchBusy);
      if (lunch) {
        // Lunch counts as a meeting break — drop any break that overlaps with it
        const ls = lunch.start.getTime();
        const le = lunch.end.getTime();
        for (let i = allBlocks.length - 1; i >= 0; i--) {
          const b = allBlocks[i];
          if (b.label === '☕ Meeting Break' && b.start.getTime() < le && b.end.getTime() > ls) {
            allBlocks.splice(i, 1);
          }
        }
        allBlocks.push(lunch);
        lunchBusy.push({ start: lunch.start, end: lunch.end });
        focusBusy.push({ start: lunch.start, end: lunch.end });
      } else {
        const { reason, suggestion } = lunchMissedSuggestion(day, config, lunchBusy);
        missedLunch.push({ day: formatDayLabel(day), reason, suggestion });
      }
    }
  }

  const WORKDAYS_PER_WEEK = 5;
  let totalFocusScheduled = 0;
  let totalFocusTarget = 0;
  const focusSuggestions: string[] = [];

  for (const weekDays of groupByWeek(targetDays)) {
    const prorated = config.focusTime.weeklyTargetHours * (weekDays.length / WORKDAYS_PER_WEEK);
    const targetMinutes = Math.round(prorated * 60);
    totalFocusTarget += targetMinutes;

    const focusBlocks = config.focusTime.enabled
      ? scheduleFocusBlocks(weekDays, config, focusBusy, targetMinutes)
      : [];
    allBlocks.push(...focusBlocks);
    const scheduled = focusBlocks.reduce((sum, b) => sum + durationMinutes(b.start, b.end), 0);
    totalFocusScheduled += scheduled;

    const shortfall = targetMinutes - scheduled;
    if (shortfall >= config.focusTime.minBlockMinutes) {
      // Look for morning slots that were skipped due to preferAfterTime
      const afternoonStart = config.focusTime.preferAfterTime ?? '11:00';
      const morningSlots: string[] = [];
      for (const day of weekDays) {
        const start = setTimeOnDay(day, config.workDayStart);
        const end = setTimeOnDay(day, afternoonStart);
        for (const slot of getFreeIntervals(start, end, focusBusy)) {
          const dur = durationMinutes(slot.start, slot.end);
          if (dur >= config.focusTime.minBlockMinutes) {
            morningSlots.push(`${formatDayLabel(day)} ${formatTime(slot.start)}–${formatTime(slot.end)} (${dur}m)`);
          }
        }
      }

      const shortHours = (shortfall / 60).toFixed(1);
      if (morningSlots.length > 0) {
        focusSuggestions.push(
          `${shortHours}h short. Available morning slots (before ${afternoonStart}): ${morningSlots.slice(0, 3).join(', ')}${morningSlots.length > 3 ? ` (+${morningSlots.length - 3} more)` : ''}.`
        );
      } else {
        focusSuggestions.push(`${shortHours}h short and no remaining morning slots either — this is a heavy meeting week.`);
      }
    }
  }

  const focusShortfall = totalFocusScheduled < totalFocusTarget
    ? { weeklyTarget: totalFocusTarget / 60, scheduled: totalFocusScheduled / 60, suggestions: focusSuggestions }
    : null;

  // Lunch-style and focus-style custom categories (scheduled after built-ins)
  for (const cat of (config.customCategories ?? [])) {
    if (!cat.enabled || cat.type === 'fixed') continue;
    const label = `${cat.emoji} ${cat.name}`;

    if (cat.type === 'lunch-style') {
      const tempConfig: Config = {
        ...config,
        lunch: {
          enabled: true,
          windowStart: cat.windowStart ?? '12:00',
          windowEnd: cat.windowEnd ?? '13:00',
          minMinutes: cat.minMinutes ?? 30,
          maxMinutes: cat.maxMinutes ?? 60,
        },
      };
      for (const day of targetDays) {
        const block = scheduleLunch(day, tempConfig, focusBusy);
        if (block) {
          allBlocks.push({ start: block.start, end: block.end, label });
          lunchBusy.push({ start: block.start, end: block.end });
          focusBusy.push({ start: block.start, end: block.end });
        }
      }
    } else if (cat.type === 'focus-style') {
      const tempConfig: Config = {
        ...config,
        focusTime: {
          enabled: true,
          weeklyTargetHours: cat.weeklyTargetHours ?? 4,
          minBlockMinutes: cat.minBlockMinutes ?? 30,
          maxBlockMinutes: cat.maxBlockMinutes ?? 120,
          maxDailyFocusHours: cat.maxDailyHours ?? 2,
          preferAfterTime: cat.preferAfterTime,
        },
      };
      for (const weekDays of groupByWeek(targetDays)) {
        const prorated = (cat.weeklyTargetHours ?? 4) * (weekDays.length / 5);
        const targetMinutes = Math.round(prorated * 60);
        const blocks = scheduleFocusBlocks(weekDays, tempConfig, focusBusy, targetMinutes);
        for (const block of blocks) {
          allBlocks.push({ start: block.start, end: block.end, label });
          lunchBusy.push({ start: block.start, end: block.end });
          // focusBusy already mutated by scheduleFocusBlocks
        }
      }
    }
  }

  // Drop meeting breaks immediately followed by focus time — focus already serves as a break
  const focusStarts = new Set(allBlocks.filter(b => b.label === '🤓 Focus Time').map(b => b.start.getTime()));
  const blocks = allBlocks
    .filter(b => b.label !== '☕ Meeting Break' || !focusStarts.has(b.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    blocks,
    missedLunch,
    focusShortfall,
  };
}
