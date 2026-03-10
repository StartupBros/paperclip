/**
 * Lightweight cron matching for the agent-routines plugin worker.
 *
 * Re-implements the core parsing logic from `server/src/services/cron.ts`
 * since plugin workers cannot import server modules. Only includes the
 * subset needed for matching and previewing schedules.
 *
 * Supports standard 5-field cron expressions:
 *
 *   ┌────────────── minute (0–59)
 *   │ ┌──────────── hour   (0–23)
 *   │ │ ┌────────── day of month (1–31)
 *   │ │ │ ┌──────── month  (1–12)
 *   │ │ │ │ ┌────── day of week (0–6, Sun=0)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Supported syntax per field: *, N, N-M, N/S, N-M/S, comma-separated lists.
 */

interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
];

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MAX_PREVIEW_MINUTES = 366 * 24 * 60;

function validateBounds(value: number, spec: FieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`,
    );
  }
}

function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  const parts = token.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error(`Empty element in cron ${spec.name} field`);
    }

    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step "${stepStr}" in cron ${spec.name} field`);
      }

      let rangeStart = spec.min;
      let rangeEnd = spec.max;

      if (base === "*") {
        // noop
      } else if (base.includes("-")) {
        const [a, b] = base.split("-").map((s) => parseInt(s, 10));
        if (isNaN(a!) || isNaN(b!)) {
          throw new Error(`Invalid range "${base}" in cron ${spec.name} field`);
        }
        rangeStart = a!;
        rangeEnd = b!;
      } else {
        const start = parseInt(base, 10);
        if (isNaN(start)) {
          throw new Error(`Invalid start "${base}" in cron ${spec.name} field`);
        }
        rangeStart = start;
      }

      validateBounds(rangeStart, spec);
      validateBounds(rangeEnd, spec);

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    if (trimmed.includes("-")) {
      const [aStr, bStr] = trimmed.split("-");
      const a = parseInt(aStr!, 10);
      const b = parseInt(bStr!, 10);
      if (isNaN(a) || isNaN(b)) {
        throw new Error(`Invalid range "${trimmed}" in cron ${spec.name} field`);
      }
      validateBounds(a, spec);
      validateBounds(b, spec);
      if (a > b) {
        throw new Error(`Invalid range ${a}-${b} in cron ${spec.name} field (start > end)`);
      }
      for (let i = a; i <= b; i++) {
        values.add(i);
      }
      continue;
    }

    if (trimmed === "*") {
      for (let i = spec.min; i <= spec.max; i++) {
        values.add(i);
      }
      continue;
    }

    const val = parseInt(trimmed, 10);
    if (isNaN(val)) {
      throw new Error(`Invalid value "${trimmed}" in cron ${spec.name} field`);
    }
    validateBounds(val, spec);
    values.add(val);
  }

  if (values.size === 0) {
    throw new Error(`Empty result for cron ${spec.name} field`);
  }

  return [...values].sort((a, b) => a - b);
}

function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression must not be empty");
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`,
    );
  }

  return {
    minutes: parseField(tokens[0]!, FIELD_SPECS[0]!),
    hours: parseField(tokens[1]!, FIELD_SPECS[1]!),
    daysOfMonth: parseField(tokens[2]!, FIELD_SPECS[2]!),
    months: parseField(tokens[3]!, FIELD_SPECS[3]!),
    daysOfWeek: parseField(tokens[4]!, FIELD_SPECS[4]!),
  };
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const weekday = values.weekday;
  const dayOfWeek = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;
  if (dayOfWeek == null) {
    throw new Error(`Unable to determine weekday for timezone "${timezone}"`);
  }

  return {
    year: parseInt(values.year ?? "0", 10),
    month: parseInt(values.month ?? "0", 10),
    day: parseInt(values.day ?? "0", 10),
    hour: parseInt(values.hour ?? "0", 10),
    minute: parseInt(values.minute ?? "0", 10),
    dayOfWeek,
  };
}

export function validateTimezone(timezone: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Check whether a cron expression matches the given date at minute-level
 * granularity in the provided timezone.
 */
export function shouldFireAt(
  cronExpression: string,
  date: Date,
  timezone = "UTC",
): boolean {
  const parsed = parseCron(cronExpression);
  const zoned = getZonedDateParts(date, timezone);

  return (
    parsed.minutes.includes(zoned.minute) &&
    parsed.hours.includes(zoned.hour) &&
    parsed.daysOfMonth.includes(zoned.day) &&
    parsed.months.includes(zoned.month) &&
    parsed.daysOfWeek.includes(zoned.dayOfWeek)
  );
}

/**
 * Find the next matching time after the given timestamp.
 *
 * Returns `null` if no match is found within the preview window.
 */
export function nextFireAfter(
  cronExpression: string,
  after: Date,
  timezone = "UTC",
): Date | null {
  const cursor = new Date(after);
  cursor.setUTCSeconds(0, 0);

  for (let i = 0; i < MAX_PREVIEW_MINUTES; i++) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (shouldFireAt(cronExpression, cursor, timezone)) {
      return new Date(cursor.getTime());
    }
  }

  return null;
}

/**
 * Validate a cron expression string. Returns `null` if valid, or an error
 * message string if invalid.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
