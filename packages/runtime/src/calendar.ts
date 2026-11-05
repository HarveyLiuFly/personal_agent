import { CronExpressionParser } from 'cron-parser';
export interface CronSpec {
  expression: string;
  timezone: string;
}
export class ScheduleTimeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new ScheduleTimeError(code);
};
// Explicit supported calendar horizon, independent of the machine's default timezone.
export const calendarRange = { min: Date.UTC(2020, 0, 1), max: Date.UTC(2100, 0, 1) } as const;
export function scheduleTime(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < calendarRange.min ||
    Number(value) >= calendarRange.max
  )
    return fail('INVALID_SCHEDULE_TIME');
  return Number(value);
}
function formatter(timezone: unknown) {
  if (
    typeof timezone !== 'string' ||
    timezone.length > 100 ||
    (timezone !== 'UTC' && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timezone))
  )
    return fail('INVALID_SCHEDULE_TIMEZONE');
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return fail('INVALID_SCHEDULE_TIMEZONE');
  }
}
type Wall = { year: number; month: number; day: number; hour: number; minute: number };
function wall(format: Intl.DateTimeFormat, at: number): Wall {
  const parts = Object.fromEntries(
    format
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}
const wallMs = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
/** Collect neighboring offsets rather than assuming every DST change is exactly one hour. */
function offsets(format: Intl.DateTimeFormat, at: number): number[] {
  const values = new Set<number>();
  const minute = Math.floor(at / 60000) * 60000;
  for (let hour = -36; hour <= 36; hour += 6) {
    const probe = minute + hour * 3600000;
    values.add(wallMs(wall(format, probe)) - probe);
  }
  return [...values];
}
function earlierInstant(format: Intl.DateTimeFormat, local: number): number | undefined {
  const candidates = offsets(format, local)
    .map((offset) => local - offset)
    .filter((at) => wallMs(wall(format, at)) === local);
  return candidates.length ? Math.min(...candidates) : undefined;
}
function parse(spec: CronSpec, at: number) {
  if (
    !spec ||
    typeof spec !== 'object' ||
    Object.keys(spec).length !== 2 ||
    !Object.hasOwn(spec, 'expression') ||
    !Object.hasOwn(spec, 'timezone') ||
    typeof spec.expression !== 'string' ||
    spec.expression.length > 128
  )
    return fail('INVALID_CRON_SPEC');
  const expression = spec.expression.trim().replace(/\s+/g, ' '),
    fields = expression.split(' '),
    format = formatter(spec.timezone);
  // Minute resolution, deterministic numeric fields. H/L/#, macros and seconds are intentionally unsupported.
  if (fields.length !== 5 || fields.some((f) => !f || !/^[\d*,/\-]+$/.test(f)))
    return fail('INVALID_CRON_EXPRESSION');
  try {
    return {
      iterator: CronExpressionParser.parse('0 ' + expression, {
        currentDate: at,
        tz: 'UTC',
        strict: true,
      }),
      format,
      expression,
    };
  } catch {
    return fail('INVALID_CRON_EXPRESSION');
  }
}
export function validateCron(spec: CronSpec): CronSpec {
  const parsed = parse(spec, calendarRange.min);
  return { expression: parsed.expression, timezone: spec.timezone };
}
/** Strictly after `after`; repeated local minutes select the earlier UTC occurrence, gaps are skipped. */
export function nextCron(spec: CronSpec, after: number): number {
  scheduleTime(after);
  const format = formatter(spec.timezone),
    parsed = parse(spec, wallMs(wall(format, after)));
  for (let n = 0; n < 512; n++) {
    let at: number;
    try {
      at = parsed.iterator.next().getTime();
    } catch {
      return fail('CRON_NO_OCCURRENCE');
    }
    if (at > calendarRange.max + 86400000) return fail('CRON_NO_OCCURRENCE');
    const utc = earlierInstant(format, at);
    if (utc === undefined || utc <= after) continue;
    if (utc >= calendarRange.max) return fail('CRON_NO_OCCURRENCE');
    return utc;
  }
  return fail('CRON_SEARCH_LIMIT');
}
/** At or before `at`; suitable for choosing the latest missed occurrence without unbounded replay. */
export function previousCron(spec: CronSpec, at: number): number {
  scheduleTime(at);
  const format = formatter(spec.timezone),
    local = wallMs(wall(format, at)),
    currentOffset = local - Math.floor(at / 60000) * 60000;
  // During a fall-back interval a later wall minute from the first pass can still be the latest past occurrence.
  const lookAhead = Math.max(0, ...offsets(format, at).map((offset) => offset - currentOffset)),
    parsed = parse(spec, local + lookAhead + 1);
  for (let n = 0; n < 512; n++) {
    let candidate: number;
    try {
      candidate = parsed.iterator.prev().getTime();
    } catch {
      return fail('CRON_NO_OCCURRENCE');
    }
    if (candidate < calendarRange.min - 86400000) return fail('CRON_NO_OCCURRENCE');
    const earlier = earlierInstant(format, candidate);
    if (earlier === undefined || earlier > at) continue;
    if (earlier < calendarRange.min) return fail('CRON_NO_OCCURRENCE');
    return earlier;
  }
  return fail('CRON_SEARCH_LIMIT');
}
export function calendarBaseline() {
  return {
    cronParser: '5.10.3',
    node: process.versions.node,
    icu: process.versions.icu,
    tz: process.versions.tz,
    defaultPolicy: { ambiguous: 'earlier_once', nonexistent: 'skip' },
    rangeUTC: {
      from: new Date(calendarRange.min).toISOString(),
      untilExclusive: new Date(calendarRange.max).toISOString(),
    },
  } as const;
}
