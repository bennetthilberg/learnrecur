import { z } from "zod";

export const DEFAULT_PRACTICE_TIMEZONE = "UTC";

export const dailyNewSkillLimitSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .nullable();
export const practiceTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone.");

export const practiceDayStartMinutesSchema = z
  .number()
  .int()
  .min(0)
  .max(1439);

export const practiceDayStartTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use a local time in HH:mm format.");

export function formatPracticeDayStart(minutes: number): string {
  practiceDayStartMinutesSchema.parse(minutes);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

export function parsePracticeDayStart(value: string): number {
  practiceDayStartTimeSchema.parse(value);
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type PracticeDayBounds = {
  start: Date;
  end: Date;
  localDate: string;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getLocalDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timezone);
  if (existing) return existing;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function getLocalDateTimeParts(value: Date, timezone: string): LocalDateTimeParts {
  const parts = getLocalDateTimeFormatter(timezone).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`Timezone formatter omitted ${type}.`);
    return Number(part.value);
  };

  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
  };
}

function localDateKey(parts: Pick<LocalDateTimeParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(
    2,
    "0",
  )}-${String(parts.day).padStart(2, "0")}`;
}

function parseLocalDateKey(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local date key: ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function shiftLocalDateKey(value: string, days: number): string {
  const date = parseLocalDateKey(value);
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return localDateKey({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

function compareLocalWallTime(
  parts: LocalDateTimeParts,
  target: { year: number; month: number; day: number; minute: number },
): number {
  const actual = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const expected = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    Math.floor(target.minute / 60),
    target.minute % 60,
  );
  return actual - expected;
}

function findLocalBoundary(
  dateKey: string,
  startMinutes: number,
  timezone: string,
): Date {
  const date = parseLocalDateKey(dateKey);
  const targetHour = Math.floor(startMinutes / 60);
  const targetMinute = startMinutes % 60;
  const target = {
    ...date,
    minute: startMinutes,
  };
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, targetHour, targetMinute);

  // Most boundaries can be resolved from the offsets around the requested wall
  // time. Trying every observed offset preserves the earliest occurrence when a
  // fall-back transition repeats the boundary.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = new Date(naiveUtc + hours * 60 * 60 * 1000);
    const parts = getLocalDateTimeParts(instant, timezone);
    const localAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    offsets.add(localAsUtc - instant.getTime());
  }

  const exactCandidates = [...offsets]
    .map((offset) => new Date(naiveUtc - offset))
    .filter((candidate) => {
      const parts = getLocalDateTimeParts(candidate, timezone);
      return (
        localDateKey(parts) === dateKey &&
        parts.hour === targetHour &&
        parts.minute === targetMinute &&
        parts.second === 0
      );
    })
    .sort((left, right) => left.getTime() - right.getTime());

  if (exactCandidates[0]) return exactCandidates[0];

  // A spring-forward gap has no exact instant. Walk the local wall clock in
  // minute increments and advance to the first valid local time after the
  // requested boundary. The wide search also handles rare date skips without
  // using a fixed 24-hour day for the resulting bounds.
  const searchStart = naiveUtc - 36 * 60 * 60 * 1000;
  const searchEnd = naiveUtc + 72 * 60 * 60 * 1000;
  for (let timestamp = searchStart; timestamp <= searchEnd; timestamp += 60 * 1000) {
    const candidate = new Date(timestamp);
    const parts = getLocalDateTimeParts(candidate, timezone);
    if (parts.second !== 0 || compareLocalWallTime(parts, target) < 0) continue;
    return candidate;
  }

  throw new Error(`Could not resolve ${dateKey} ${formatPracticeDayStart(startMinutes)} in ${timezone}.`);
}

export function getPracticeDayBoundary(
  localDate: string,
  timezone: string,
  startMinutes = 0,
): Date {
  practiceTimezoneSchema.parse(timezone);
  practiceDayStartMinutesSchema.parse(startMinutes);
  return findLocalBoundary(localDate, startMinutes, timezone);
}

export function getPracticeDayBounds(
  now: Date,
  timezone: string,
  startMinutes = 0,
): PracticeDayBounds {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Practice day bounds require a valid Date.");
  }
  practiceTimezoneSchema.parse(timezone);
  practiceDayStartMinutesSchema.parse(startMinutes);

  const localParts = getLocalDateTimeParts(now, timezone);
  const currentDate = localDateKey(localParts);
  const currentBoundary = getPracticeDayBoundary(currentDate, timezone, startMinutes);
  const localDate = now.getTime() >= currentBoundary.getTime()
    ? currentDate
    : shiftLocalDateKey(currentDate, -1);
  const start = localDate === currentDate
    ? currentBoundary
    : getPracticeDayBoundary(localDate, timezone, startMinutes);
  const end = getPracticeDayBoundary(shiftLocalDateKey(localDate, 1), timezone, startMinutes);

  return { start, end, localDate };
}

export function getPracticeLocalDate(
  now: Date,
  timezone: string,
  startMinutes = 0,
): string {
  return getPracticeDayBounds(now, timezone, startMinutes).localDate;
}

type IntroductionEvidence = {
  firstIntroducedAt: Date | null;
  lastReviewedAt: Date | null;
  repetitions: number;
};
export function wasSkillIntroduced(skill: IntroductionEvidence): boolean {
  return (
    skill.firstIntroducedAt !== null ||
    skill.lastReviewedAt !== null ||
    skill.repetitions > 0
  );
}

// Read models describe available work without reserving an introduction.
export function countAvailablePracticeSkills(
  skills: readonly IntroductionEvidence[],
  remaining: number | null,
): number {
  if (remaining === null) return skills.length;
  const introduced = skills.filter(wasSkillIntroduced).length;
  return introduced + Math.min(remaining, skills.length - introduced);
}
