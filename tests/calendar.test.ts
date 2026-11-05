import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calendarBaseline,
  nextCron,
  previousCron,
  scheduleTime,
  validateCron,
} from '../packages/runtime/src/calendar.ts';
const ms = (iso: string) => Date.parse(iso),
  iso = (at: number) => new Date(at).toISOString();
test('numeric five-field Cron is normalized and validates a named timezone without using the host default', () => {
  assert.deepEqual(
    validateCron({ expression: '  */15   9-17 * * 1-5  ', timezone: 'Asia/Shanghai' }),
    { expression: '*/15 9-17 * * 1-5', timezone: 'Asia/Shanghai' },
  );
  assert.equal(
    iso(
      nextCron({ expression: '0 9 * * *', timezone: 'Asia/Shanghai' }, ms('2026-11-03T00:00:00Z')),
    ),
    '2026-11-03T01:00:00.000Z',
  );
});
test('next is exclusive and previous inclusive at the exact minute, with seconds never inherited', () => {
  const spec = { expression: '*/15 * * * *', timezone: 'UTC' },
    at = ms('2026-01-01T12:00:00Z');
  assert.equal(nextCron(spec, at), at + 900000);
  assert.equal(previousCron(spec, at), at);
  assert.equal(previousCron(spec, at - 1), at - 900000);
  assert.equal(nextCron(spec, at + 4321), at + 900000);
});
test('New York nonexistent spring time is skipped rather than silently shifted to another hour', () => {
  const spec = { expression: '30 2 * * *', timezone: 'America/New_York' };
  assert.equal(iso(nextCron(spec, ms('2026-03-08T05:00:00Z'))), '2026-03-09T06:30:00.000Z');
  assert.equal(iso(previousCron(spec, ms('2026-03-08T08:00:00Z'))), '2026-03-07T07:30:00.000Z');
});
test('New York repeated fall time selects only its earlier UTC occurrence in either direction', () => {
  const spec = { expression: '30 1 * * *', timezone: 'America/New_York' },
    first = ms('2026-11-01T05:30:00Z');
  assert.equal(nextCron(spec, first - 1), first);
  assert.equal(iso(nextCron(spec, first)), '2026-11-02T06:30:00.000Z');
  assert.equal(previousCron(spec, ms('2026-11-01T06:45:00Z')), first);
  assert.equal(previousCron(spec, first), first);
});
test('every-minute expressions suppress all repeated fall minutes, not just daily Cron', () => {
  const spec = { expression: '* * * * *', timezone: 'America/New_York' };
  assert.equal(iso(nextCron(spec, ms('2026-11-01T05:59:00Z'))), '2026-11-01T07:00:00.000Z');
  assert.equal(iso(previousCron(spec, ms('2026-11-01T06:20:00Z'))), '2026-11-01T05:59:00.000Z');
});
test('Lord Howe half-hour repeated time also selects the earlier occurrence', () => {
  const spec = { expression: '45 1 * * *', timezone: 'Australia/Lord_Howe' },
    first = ms('2026-04-04T14:45:00Z');
  assert.equal(nextCron(spec, first - 1), first);
  assert.equal(iso(nextCron(spec, first)), '2026-04-05T15:15:00.000Z');
  assert.equal(previousCron(spec, ms('2026-04-04T15:20:00Z')), first);
});
test('Lord Howe half-hour gap is skipped while the next ordinary day remains valid', () => {
  const spec = { expression: '15 2 * * *', timezone: 'Australia/Lord_Howe' };
  assert.equal(iso(nextCron(spec, ms('2026-10-03T12:00:00Z'))), '2026-10-04T15:15:00.000Z');
  assert.equal(iso(previousCron(spec, ms('2026-10-03T17:00:00Z'))), '2026-10-02T15:45:00.000Z');
});
test('leap dates and month boundaries retain calendar semantics', () => {
  const spec = { expression: '0 0 29 2 *', timezone: 'UTC' };
  assert.equal(iso(nextCron(spec, ms('2025-01-01T00:00:00Z'))), '2028-02-29T00:00:00.000Z');
  assert.equal(iso(previousCron(spec, ms('2027-12-31T00:00:00Z'))), '2024-02-29T00:00:00.000Z');
});
test('latest missed occurrence is computed directly over years instead of replaying every minute', () => {
  const spec = { expression: '* * * * *', timezone: 'UTC' };
  assert.equal(iso(previousCron(spec, ms('2099-12-31T23:59:59.999Z'))), '2099-12-31T23:59:00.000Z');
});
test('malformed, nondeterministic, ambiguous day fields and extra fields are rejected', () => {
  for (const expression of [
    '',
    '* * * * * *',
    '@daily',
    'H * * * *',
    '0 0 L * *',
    '0 0 * * MON',
    '60 * * * *',
    '0 0 1 * 1',
    '0/0 * * * *',
    '0 0 32 * *',
  ])
    assert.throws(() => validateCron({ expression, timezone: 'UTC' }), /INVALID_CRON/);
  for (const timezone of ['UTC+8', '+08:00', 'Asia/Unknown', 'EST', ''])
    assert.throws(
      () => validateCron({ expression: '* * * * *', timezone }),
      /INVALID_SCHEDULE_TIMEZONE/,
    );
  assert.throws(
    () => validateCron({ expression: '* * * * *', timezone: 'UTC', argv: [] } as never),
    /INVALID_CRON_SPEC/,
  );
});
test('unsupported dates and impossible future occurrences fail closed without silently changing the expression', () => {
  for (const time of [0, NaN, Infinity, 1.5, ms('2100-01-01T00:00:00Z')])
    assert.throws(() => scheduleTime(time), /INVALID_SCHEDULE_TIME/);
  assert.throws(
    () => nextCron({ expression: '0 0 29 2 *', timezone: 'UTC' }, ms('2099-01-01T00:00:00Z')),
    /CRON_NO_OCCURRENCE/,
  );
  assert.throws(
    () => nextCron({ expression: '0 0 30 2 *', timezone: 'UTC' }, ms('2026-01-01T00:00:00Z')),
    /INVALID_CRON|CRON_NO_OCCURRENCE/,
  );
  assert.equal(calendarBaseline().cronParser, '5.10.3');
  assert.ok(calendarBaseline().tz);
});
test('independent UTC-minute enumeration agrees across four DST boundaries without duplicate local slots', () => {
  for (const [timezone, start] of [
    ['America/New_York', '2026-03-07T12:00:00Z'],
    ['America/New_York', '2026-10-31T12:00:00Z'],
    ['Australia/Lord_Howe', '2026-04-04T00:00:00Z'],
    ['Australia/Lord_Howe', '2026-10-03T00:00:00Z'],
  ] as const) {
    const from = ms(start),
      until = from + 48 * 3600000,
      spec = { expression: '*/15 * * * *', timezone },
      format = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
      seen = new Set<string>(),
      expected: number[] = [];
    // Oracle enumerates actual UTC minutes, using no parser or production conversion helpers.
    for (let at = from; at < until; at += 60000) {
      const parts = format.formatToParts(at),
        minute = Number(parts.find((p) => p.type === 'minute')!.value),
        slot = format.format(at);
      if (minute % 15 === 0 && !seen.has(slot)) {
        expected.push(at);
        seen.add(slot);
      }
    }
    let cursor = from - 1;
    for (const at of expected) {
      cursor = nextCron(spec, cursor);
      assert.equal(cursor, at, timezone + ' next');
    }
    assert.ok(nextCron(spec, cursor) >= until);
    for (let query = from + 4 * 3600000; query < until; query += 7 * 60000) {
      const past = expected.filter((at) => at <= query);
      assert.equal(previousCron(spec, query), past.at(-1), timezone + ' previous');
    }
  }
});
