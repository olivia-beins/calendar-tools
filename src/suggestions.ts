import type { ScheduleReport, BusyInterval } from './scheduler.js';
import { formatDayLabel, formatTime, durationMinutes } from './scheduler.js';

interface SuggestionContext {
  missedLunch: ScheduleReport['missedLunch'];
  focusShortfall: ScheduleReport['focusShortfall'];
  namedBusy: BusyInterval[];
  aiInstructions?: string;
}

/**
 * Enriches scheduling report suggestions using GPT.
 * Falls back to the original rule-based suggestions if no API key or if the call fails.
 */
export async function enrichWithAI(
  report: ScheduleReport,
  openaiApiKey: string,
  namedBusy: BusyInterval[] = [],
  aiInstructions?: string
): Promise<ScheduleReport> {
  const { missedLunch, focusShortfall } = report;
  if (missedLunch.length === 0 && !focusShortfall) return report;

  const prompt = buildPrompt({ missedLunch, focusShortfall, namedBusy, aiInstructions });

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful calendar assistant. Give concise, practical, non-judgmental suggestions for how someone could make space on their calendar. Always include the full date (e.g. "Wed Mar 25") when referring to a specific day — never just the weekday name alone. When a meeting looks potentially movable (e.g. a 1:1, informal sync, recurring check-in), say so and suggest moving or shortening it. When a meeting is likely fixed (e.g. all-hands, external calls), acknowledge that. Keep each suggestion to 1-2 sentences. Never be preachy.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return report;

    const data = await res.json() as any;
    const parsed = JSON.parse(data.choices[0].message.content) as {
      missedLunch?: { day: string; suggestion: string }[];
      focusSuggestions?: string[];
    };

    // Merge AI suggestions back in, keeping original reason/day fields
    const enrichedMissedLunch = missedLunch.map((m) => {
      const aiEntry = parsed.missedLunch?.find((a) => a.day === m.day);
      return aiEntry ? { ...m, suggestion: aiEntry.suggestion } : m;
    });

    const enrichedFocusShortfall = focusShortfall && parsed.focusSuggestions
      ? { ...focusShortfall, suggestions: parsed.focusSuggestions }
      : focusShortfall;

    return { ...report, missedLunch: enrichedMissedLunch, focusShortfall: enrichedFocusShortfall };
  } catch {
    return report; // silently fall back
  }
}

function buildPrompt(ctx: SuggestionContext): string {
  // Group named events by day label for lookup
  const byDay = new Map<string, BusyInterval[]>();
  for (const b of ctx.namedBusy) {
    const key = formatDayLabel(b.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(b);
  }

  const lines: string[] = [
    'Here is a summary of scheduling problems on my calendar, with the actual meetings that caused them.',
    'Please give specific, actionable suggestions. When meetings look movable (1:1s, informal syncs, recurring check-ins), say so.',
    'Return JSON: { "missedLunch": [{ "day": "<day>", "suggestion": "<suggestion>" }], "focusSuggestions": ["<suggestion>"] }',
    '',
  ];

  if (ctx.aiInstructions?.trim()) {
    lines.push('ADDITIONAL INSTRUCTIONS FROM USER:');
    lines.push(ctx.aiInstructions.trim());
    lines.push('');
  }

  if (ctx.missedLunch.length > 0) {
    lines.push('MISSED LUNCH:');
    for (const m of ctx.missedLunch) {
      lines.push(`- ${m.day}: ${m.reason}`);
      const dayMeetings = byDay.get(m.day) ?? [];
      if (dayMeetings.length > 0) {
        const meetingList = dayMeetings
          .map((b) => `"${b.summary ?? 'Busy'}" ${formatTime(b.start)}–${formatTime(b.end)}`)
          .join(', ');
        lines.push(`  Meetings that day: ${meetingList}`);
      }
      lines.push(`  Context: ${m.suggestion}`);
    }
    lines.push('');
  }

  if (ctx.focusShortfall) {
    const fs = ctx.focusShortfall;
    lines.push(`FOCUS TIME SHORTFALL: ${fs.scheduled.toFixed(1)}h scheduled of ${fs.weeklyTarget.toFixed(1)}h target`);
    if (byDay.size > 0) {
      lines.push('Meeting load per day:');
      for (const [day, meetings] of byDay) {
        const totalMins = meetings.reduce((sum, b) => sum + durationMinutes(b.start, b.end), 0);
        const meetingList = meetings
          .map((b) => `"${b.summary ?? 'Busy'}" ${formatTime(b.start)}–${formatTime(b.end)}`)
          .join(', ');
        lines.push(`  ${day} (${totalMins}m in meetings): ${meetingList}`);
      }
      lines.push('');
    }
    for (const s of fs.suggestions) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join('\n');
}
