import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { Resend } from "resend";
import { z } from "zod";

import {
  ReminderSendStatus,
  SkillStatus,
  type AnswerKind,
  type ExerciseVerificationStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { formatEnvError, getResendEnv, type ResendEnv } from "@/lib/env";
import { isPracticeReadModelExerciseReady } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

export const DEFAULT_REMINDER_HOUR = 9;
export const DEFAULT_REMINDER_MINIMUM_DUE_COUNT = 1;
export const DEFAULT_REMINDER_TIMEZONE = "America/New_York";
export const MAX_REMINDER_MINIMUM_DUE_COUNT = 99;
export const REMINDER_PROVIDER = "resend";
export const STALE_PENDING_REMINDER_MS = 5 * 60 * 1000;

export type NormalizedReminderPreferenceInput = {
  enabled: boolean;
  email: string;
  localHour: number;
  timezone: string;
  minimumDueCount: number;
};

export type ReminderPreferenceInputResult =
  | {
      status: "valid";
      input: NormalizedReminderPreferenceInput;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    };

export type ReminderSettingsResult =
  | {
      status: "ready";
      preference: NormalizedReminderPreferenceInput;
      persisted: boolean;
    }
  | {
      status: "not-found";
      message: string;
    };

export type SaveReminderPreferenceResult =
  | {
      status: "saved";
      preference: NormalizedReminderPreferenceInput;
      message: string;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    }
  | {
      status: "not-found";
      message: string;
    };

export type ReminderEmailPayload = {
  dueCount: number;
  email: string;
  idempotencyKey: string;
  practiceUrl: string;
  settingsUrl: string;
};

export type ReminderEmailSendResult = {
  providerMessageId: string | null;
};

export type ReminderEmailSender = {
  sendDueReminder(payload: ReminderEmailPayload): Promise<ReminderEmailSendResult>;
};

export type ReminderAccountEmailResolver = (userId: string) => Promise<string | null>;

export type ProcessDueReminderResult =
  | {
      status: "not-due-hour";
      userId: string;
      localDate: string;
    }
  | {
      status: "already-processed";
      userId: string;
      localDate: string;
      logStatus: ReminderSendStatus;
    }
  | {
      status: "skipped";
      userId: string;
      localDate: string;
      dueCount: number;
    }
  | {
      status: "invalid-recipient";
      userId: string;
      localDate: string;
      message: string;
    }
  | {
      status: "sent";
      userId: string;
      localDate: string;
      dueCount: number;
      providerMessageId: string | null;
    }
  | {
      status: "failed";
      userId: string;
      localDate: string;
      dueCount: number;
      message: string;
    };

export type ProcessDueReminderBatchResult = {
  checkedCount: number;
  processedCount: number;
  results: ProcessDueReminderResult[];
};

type ReminderPreferenceRecord = NormalizedReminderPreferenceInput & {
  accountEmail: string | null;
  userId: string;
};

type DuePracticeSkillRecord = {
  id: string;
  repetitions: number;
  exercises: Array<{
    answerKind: AnswerKind;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    choices: Prisma.JsonValue | null;
    answerSpec: Prisma.JsonValue;
  }>;
};

const reminderPreferenceInputSchema = z.strictObject({
  enabled: z.preprocess(parseBooleanish, z.boolean()),
  email: z.string().trim().max(254),
  localHour: z.coerce
    .number()
    .int("Choose a whole hour.")
    .min(0, "Choose an hour from 0 to 23.")
    .max(23, "Choose an hour from 0 to 23."),
  timezone: z
    .string()
    .trim()
    .min(1, "Choose a timezone.")
    .max(80, "Timezone is too long.")
    .refine(isValidTimeZone, "Choose a valid IANA timezone."),
  minimumDueCount: z.coerce
    .number()
    .int("Choose a whole number.")
    .min(1, "Minimum due count must be at least 1.")
    .max(
      MAX_REMINDER_MINIMUM_DUE_COUNT,
      `Minimum due count must be ${MAX_REMINDER_MINIMUM_DUE_COUNT} or less.`,
    ),
}).superRefine((value, context) => {
  if (!value.enabled && value.email === "") {
    return;
  }

  const emailResult = z.string().email().safeParse(value.email);

  if (!emailResult.success) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: "Enter a valid email address.",
    });
  }
});

export function normalizeReminderPreferenceInput(
  input: unknown,
): ReminderPreferenceInputResult {
  const result = reminderPreferenceInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Check the reminder settings and try again.",
      fieldErrors: toFieldErrors(result.error.flatten().fieldErrors),
    };
  }

  return {
    status: "valid",
    input: result.data,
  };
}

export function getDefaultReminderPreference(email: string | null): NormalizedReminderPreferenceInput {
  return {
    enabled: false,
    email: email ?? "",
    localHour: DEFAULT_REMINDER_HOUR,
    timezone: DEFAULT_REMINDER_TIMEZONE,
    minimumDueCount: DEFAULT_REMINDER_MINIMUM_DUE_COUNT,
  };
}

export async function getReminderSettings(input: {
  userId: string;
}): Promise<ReminderSettingsResult> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      email: true,
      reminderPreference: {
        select: {
          enabled: true,
          email: true,
          localHour: true,
          timezone: true,
          minimumDueCount: true,
        },
      },
    },
  });

  if (!user) {
    return {
      status: "not-found",
      message: "Sign in again before changing reminders.",
    };
  }

  return {
    status: "ready",
    preference: user.reminderPreference ?? getDefaultReminderPreference(user.email),
    persisted: Boolean(user.reminderPreference),
  };
}

export async function saveReminderPreference(input: {
  userId: string;
  input: unknown;
}): Promise<SaveReminderPreferenceResult> {
  const normalized = normalizeReminderPreferenceInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      email: true,
      reminderPreference: {
        select: {
          email: true,
        },
      },
    },
  });

  if (!user) {
    return {
      status: "not-found",
      message: "Sign in again before changing reminders.",
    };
  }

  if (!user.email && normalized.input.enabled) {
    return {
      status: "invalid",
      message: "Use the email address verified for your account.",
      fieldErrors: {
        email: ["Reminder emails can only be sent to your account email address."],
      },
    };
  }

  const preferenceInput = {
    ...normalized.input,
    email: user.email ?? normalized.input.email,
  };

  const preference = await prisma.reminderPreference.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      ...preferenceInput,
    },
    update: preferenceInput,
    select: {
      enabled: true,
      email: true,
      localHour: true,
      timezone: true,
      minimumDueCount: true,
    },
  });

  return {
    status: "saved",
    preference,
    message: preference.enabled ? "Reminder settings saved." : "Reminders are off.",
  };
}

export async function getDuePracticeSkillCount(input: {
  userId: string;
  now: Date;
}): Promise<number> {
  const prisma = getPrisma();
  const skills = await prisma.skill.findMany({
    where: {
      userId: input.userId,
      status: SkillStatus.ACTIVE,
      dueAt: {
        lte: input.now,
      },
      stability: {
        not: null,
      },
      difficulty: {
        not: null,
      },
    },
    select: {
      id: true,
      repetitions: true,
      exercises: {
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          answerSpec: true,
        },
      },
    },
  });

  return skills.filter(isDuePracticeSkillReady).length;
}

export async function processDueReminderBatch(input: {
  accountEmailResolver?: ReminderAccountEmailResolver;
  now: Date;
  appUrl?: string;
  sender?: ReminderEmailSender;
  userIds?: string[];
}): Promise<ProcessDueReminderBatchResult> {
  const prisma = getPrisma();
  const preferences = await prisma.reminderPreference.findMany({
    where: {
      enabled: true,
      ...(input.userIds
        ? {
            userId: {
              in: input.userIds,
            },
          }
        : {}),
    },
    select: {
      userId: true,
      enabled: true,
      email: true,
      localHour: true,
      timezone: true,
      minimumDueCount: true,
      user: {
        select: {
          email: true,
        },
      },
    },
    orderBy: [{ userId: "asc" }],
  });

  const results: ProcessDueReminderResult[] = [];
  const retryableErrors: unknown[] = [];

  for (const preference of preferences) {
    let result: ProcessDueReminderResult;

    try {
      result = await processDueReminderPreference({
        accountEmailResolver: input.accountEmailResolver,
        appUrl: input.appUrl,
        now: input.now,
        preference: {
          userId: preference.userId,
          enabled: preference.enabled,
          email: preference.email,
          accountEmail: preference.user.email,
          localHour: preference.localHour,
          timezone: preference.timezone,
          minimumDueCount: preference.minimumDueCount,
        },
        sender: input.sender,
      });
    } catch (error) {
      retryableErrors.push(error);
      continue;
    }

    if (result.status !== "not-due-hour") {
      results.push(result);
    }
  }

  if (retryableErrors.length > 0) {
    throw retryableErrors[0];
  }

  return {
    checkedCount: preferences.length,
    processedCount: results.length,
    results,
  };
}

export async function processDueReminderPreference(input: {
  accountEmailResolver?: ReminderAccountEmailResolver;
  appUrl?: string;
  now: Date;
  preference: ReminderPreferenceRecord;
  sender?: ReminderEmailSender;
}): Promise<ProcessDueReminderResult> {
  const localDate = getReminderLocalDate(input.now, input.preference.timezone);

  if (!isReminderLocalHourDue(input.now, input.preference)) {
    return {
      status: "not-due-hour",
      userId: input.preference.userId,
      localDate,
    };
  }

  const prisma = getPrisma();
  const existingLog = await prisma.reminderSendLog.findUnique({
    where: {
      userId_localDate: {
        userId: input.preference.userId,
        localDate,
      },
    },
    select: {
      status: true,
      updatedAt: true,
    },
  });

  const shouldRetryPendingLog =
    existingLog?.status === ReminderSendStatus.PENDING &&
    isStalePendingReminderLog(existingLog.updatedAt, input.now);

  if (shouldRetryPendingLog && existingLog) {
    const claimedLog = await claimStalePendingReminderLog({
      localDate,
      updatedAt: existingLog.updatedAt,
      userId: input.preference.userId,
    });

    if (!claimedLog) {
      return existingLogResult(input.preference.userId, localDate);
    }
  }

  if (existingLog && !shouldRetryPendingLog) {
    return {
      status: "already-processed",
      userId: input.preference.userId,
      localDate,
      logStatus: existingLog.status,
    };
  }

  const dueCount = await getDuePracticeSkillCount({
    userId: input.preference.userId,
    now: input.now,
  });

  if (dueCount < input.preference.minimumDueCount) {
    try {
      if (shouldRetryPendingLog) {
        await prisma.reminderSendLog.update({
          where: {
            userId_localDate: {
              userId: input.preference.userId,
              localDate,
            },
          },
          data: {
            status: ReminderSendStatus.SKIPPED,
            dueCount,
            email: input.preference.email,
            provider: null,
            providerMessageId: null,
            errorMessage: null,
          },
        });
      } else {
        await prisma.reminderSendLog.create({
          data: {
            userId: input.preference.userId,
            localDate,
            status: ReminderSendStatus.SKIPPED,
            dueCount,
            email: input.preference.email,
          },
        });
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return existingLogResult(input.preference.userId, localDate);
      }

      throw error;
    }

    return {
      status: "skipped",
      userId: input.preference.userId,
      localDate,
      dueCount,
    };
  }

  const accountEmail = await resolveReminderAccountEmail(input);

  if (input.preference.email !== accountEmail) {
    return {
      status: "invalid-recipient",
      userId: input.preference.userId,
      localDate,
      message: "Reminder emails can only be sent to the current account email address.",
    };
  }

  try {
    if (shouldRetryPendingLog) {
      await prisma.reminderSendLog.update({
        where: {
          userId_localDate: {
            userId: input.preference.userId,
            localDate,
          },
        },
        data: {
          status: ReminderSendStatus.PENDING,
          dueCount,
          email: input.preference.email,
          provider: REMINDER_PROVIDER,
          providerMessageId: null,
          errorMessage: null,
        },
      });
    } else {
      await prisma.reminderSendLog.create({
        data: {
          userId: input.preference.userId,
          localDate,
          status: ReminderSendStatus.PENDING,
          dueCount,
          email: input.preference.email,
          provider: REMINDER_PROVIDER,
        },
      });
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return existingLogResult(input.preference.userId, localDate);
    }

    throw error;
  }

  try {
    const sender = input.sender ?? createResendReminderEmailSender();
    const appUrl = input.appUrl ?? getResendEnv().NEXT_PUBLIC_APP_URL;
    const practiceUrl = buildPracticeUrl(appUrl);
    const settingsUrl = buildSettingsUrl(appUrl);
    const idempotencyKey = buildReminderIdempotencyKey(input.preference.userId, localDate);
    const sendResult = await sender.sendDueReminder({
      dueCount,
      email: input.preference.email,
      idempotencyKey,
      practiceUrl,
      settingsUrl,
    });

    await prisma.reminderSendLog.update({
      where: {
        userId_localDate: {
          userId: input.preference.userId,
          localDate,
        },
      },
      data: {
        status: ReminderSendStatus.SENT,
        providerMessageId: sendResult.providerMessageId,
        errorMessage: null,
      },
    });

    return {
      status: "sent",
      userId: input.preference.userId,
      localDate,
      dueCount,
      providerMessageId: sendResult.providerMessageId,
    };
  } catch (error) {
    const message = truncateError(formatEnvError(error));

    await prisma.reminderSendLog.update({
      where: {
        userId_localDate: {
          userId: input.preference.userId,
          localDate,
        },
      },
      data: {
        status: ReminderSendStatus.FAILED,
        errorMessage: message,
      },
    });

    return {
      status: "failed",
      userId: input.preference.userId,
      localDate,
      dueCount,
      message,
    };
  }
}

export async function resolveClerkReminderAccountEmail(userId: string): Promise<string | null> {
  const client = await clerkClient();
  let user: Awaited<ReturnType<typeof client.users.getUser>>;

  try {
    user = await client.users.getUser(userId);
  } catch (error) {
    if (isClerkUserNotFoundError(error)) {
      return null;
    }

    throw error;
  }

  return user.primaryEmailAddress?.emailAddress ?? null;
}

export function createResendReminderEmailSender(env: ResendEnv = getResendEnv()): ReminderEmailSender {
  const resend = new Resend(env.RESEND_API_KEY);

  return {
    async sendDueReminder(payload) {
      const email = renderDueReminderEmail({
        dueCount: payload.dueCount,
        practiceUrl: payload.practiceUrl,
        settingsUrl: payload.settingsUrl,
      });
      const response = await resend.emails.send(
        {
          from: env.RESEND_FROM_EMAIL,
          to: payload.email,
          subject: email.subject,
          text: email.text,
          html: email.html,
        },
        {
          idempotencyKey: payload.idempotencyKey,
        },
      );

      if (response.error) {
        throw new Error(response.error.message);
      }

      return {
        providerMessageId: response.data?.id ?? null,
      };
    },
  };
}

export function renderDueReminderEmail(input: {
  dueCount: number;
  practiceUrl: string;
  settingsUrl: string;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const countLabel = formatDueCount(input.dueCount);
  const escapedUrl = escapeHtml(input.practiceUrl);
  const escapedSettingsUrl = escapeHtml(input.settingsUrl);

  return {
    subject: `${countLabel} ready for practice`,
    text: `You have ${countLabel.toLowerCase()} ready in LearnRecur.\n\nPractice now: ${input.practiceUrl}\nManage reminders: ${input.settingsUrl}`,
    html: `<p>You have <strong>${escapeHtml(countLabel.toLowerCase())}</strong> ready in LearnRecur.</p><p><a href="${escapedUrl}">Practice now</a></p><p><a href="${escapedSettingsUrl}">Manage reminders</a></p>`,
  };
}

export function buildReminderIdempotencyKey(userId: string, localDate: string): string {
  return `learnrecur:due-reminder:${userId}:${localDate}`;
}

export function buildPracticeUrl(appUrl: string): string {
  return new URL("/practice", appUrl).toString();
}

export function buildSettingsUrl(appUrl: string): string {
  return new URL("/settings", appUrl).toString();
}

export function isReminderLocalHourDue(
  now: Date,
  preference: Pick<ReminderPreferenceRecord, "localHour" | "timezone">,
): boolean {
  return getReminderLocalHour(now, preference.timezone) === preference.localHour;
}

export function getReminderLocalDate(now: Date, timezone: string): string {
  const parts = getReminderDateTimeParts(now, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getReminderLocalHour(now: Date, timezone: string): number {
  return Number.parseInt(getReminderDateTimeParts(now, timezone).hour, 10);
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isDuePracticeSkillReady(skill: DuePracticeSkillRecord): boolean {
  return skill.exercises.some((exercise) => isPracticeReadModelExerciseReady(exercise, skill));
}

async function existingLogResult(
  userId: string,
  localDate: string,
): Promise<Extract<ProcessDueReminderResult, { status: "already-processed" }>> {
  const prisma = getPrisma();
  const existingLog = await prisma.reminderSendLog.findUniqueOrThrow({
    where: {
      userId_localDate: {
        userId,
        localDate,
      },
    },
    select: {
      status: true,
    },
  });

  return {
    status: "already-processed",
    userId,
    localDate,
    logStatus: existingLog.status,
  };
}

function parseBooleanish(value: unknown): unknown {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }

  return value;
}

async function resolveReminderAccountEmail(input: {
  accountEmailResolver?: ReminderAccountEmailResolver;
  preference: ReminderPreferenceRecord;
}): Promise<string | null> {
  if (!input.accountEmailResolver) {
    return input.preference.accountEmail;
  }

  return input.accountEmailResolver(input.preference.userId);
}

function isClerkUserNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = "status" in error ? error.status : undefined;

  if (status === 404) {
    return true;
  }

  const errors = "errors" in error ? error.errors : undefined;

  return (
    Array.isArray(errors) &&
    errors.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "code" in entry &&
        entry.code === "resource_not_found",
    )
  );
}

function isStalePendingReminderLog(lastTouchedAt: Date, now: Date): boolean {
  return now.getTime() - lastTouchedAt.getTime() >= STALE_PENDING_REMINDER_MS;
}

async function claimStalePendingReminderLog(input: {
  localDate: string;
  updatedAt: Date;
  userId: string;
}): Promise<boolean> {
  const prisma = getPrisma();
  const result = await prisma.reminderSendLog.updateMany({
    where: {
      localDate: input.localDate,
      status: ReminderSendStatus.PENDING,
      updatedAt: input.updatedAt,
      userId: input.userId,
    },
    data: {
      errorMessage: null,
      providerMessageId: null,
    },
  });

  return result.count === 1;
}

function getReminderDateTimeParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(now);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: requiredDatePart(valueByType, "year"),
    month: requiredDatePart(valueByType, "month"),
    day: requiredDatePart(valueByType, "day"),
    hour: requiredDatePart(valueByType, "hour"),
  };
}

function requiredDatePart(parts: Map<string, string>, key: string): string {
  const value = parts.get(key);

  if (!value) {
    throw new Error(`Could not resolve reminder ${key}.`);
  }

  return value;
}

function formatDueCount(count: number): string {
  return `${count} ${count === 1 ? "skill is" : "skills are"}`;
}

function truncateError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function toFieldErrors(
  fieldErrors: Record<string, string[] | undefined>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(fieldErrors).filter(
      (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0,
    ),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
