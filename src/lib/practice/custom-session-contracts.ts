import { z } from "zod";

/**
 * A custom session is deliberately small and bounded. The persisted session
 * stores a snapshot of these values so a later reload cannot silently broaden
 * the learner's selection.
 */
export const MAX_CUSTOM_PRACTICE_SESSION_ITEMS = 100;
export const DEFAULT_CUSTOM_PRACTICE_SESSION_ITEMS = 10;
export const MAX_CUSTOM_PRACTICE_SCOPE_SKILLS = 500;
export const MAX_CUSTOM_PRACTICE_SCOPE_COLLECTIONS = 100;
export const MAX_CUSTOM_PRACTICE_SCOPE_TAGS = 50;
export const RECENTLY_MISSED_LOOKBACK_DAYS = 30;

export const customPracticeSessionModeSchema = z.enum([
  "PRACTICE_ONLY",
  "SCHEDULED",
]);
export type CustomPracticeSessionMode = z.infer<
  typeof customPracticeSessionModeSchema
>;

export const customPracticeSessionStatusSchema = z.enum([
  "ACTIVE",
  "STOPPED",
  "COMPLETED",
]);
export type CustomPracticeSessionStatus = z.infer<
  typeof customPracticeSessionStatusSchema
>;

export const customPracticeSessionItemStatusSchema = z.enum([
  "PENDING",
  "PRESENTED",
  "COMPLETED",
  "SKIPPED",
]);
export type CustomPracticeSessionItemStatus = z.infer<
  typeof customPracticeSessionItemStatusSchema
>;

const boundedIdSchema = z.string().trim().min(1).max(200);
const boundedTagSchema = z.string().trim().min(1).max(80);

/**
 * `recentlyMissed` is intentionally a boolean. Its fixed thirty-day window
 * is part of the contract, which keeps persisted sessions reproducible when
 * the setup page is loaded again later.
 */
export const customPracticeSessionScopeSchema = z
  .strictObject({
    collectionIds: z
      .array(boundedIdSchema)
      .max(MAX_CUSTOM_PRACTICE_SCOPE_COLLECTIONS),
    tags: z.array(boundedTagSchema).max(MAX_CUSTOM_PRACTICE_SCOPE_TAGS),
    skillIds: z.array(boundedIdSchema).max(MAX_CUSTOM_PRACTICE_SCOPE_SKILLS),
    recentlyMissed: z.boolean(),
    mixedReview: z.boolean(),
  });
export type CustomPracticeSessionScope = z.infer<
  typeof customPracticeSessionScopeSchema
>;

export const customPracticeSessionItemSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS - 1),
  itemKey: z.string().regex(/^item-[0-9]{1,3}$/),
  skillId: boundedIdSchema,
  exerciseId: boundedIdSchema,
  attemptId: z.string().regex(/^custom-[a-zA-Z0-9._:-]{8,220}$/),
  status: customPracticeSessionItemStatusSchema,
  presentedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});
export type CustomPracticeSessionItem = z.infer<
  typeof customPracticeSessionItemSchema
>;

export const customPracticeSessionPlanSchema = z
  .array(customPracticeSessionItemSchema)
  .max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS)
  .superRefine((items, context) => {
    const ordinals = new Set<number>();
    const itemKeys = new Set<string>();
    const attemptIds = new Set<string>();

    items.forEach((item, index) => {
      if (ordinals.has(item.ordinal)) {
        context.addIssue({
          code: "custom",
          path: [index, "ordinal"],
          message: "Session item ordinals must be unique.",
        });
      }
      if (itemKeys.has(item.itemKey)) {
        context.addIssue({
          code: "custom",
          path: [index, "itemKey"],
          message: "Session item keys must be unique.",
        });
      }
      if (attemptIds.has(item.attemptId)) {
        context.addIssue({
          code: "custom",
          path: [index, "attemptId"],
          message: "Session attempt IDs must be unique.",
        });
      }
      ordinals.add(item.ordinal);
      itemKeys.add(item.itemKey);
      attemptIds.add(item.attemptId);
    });

    const ordered = [...items].toSorted((left, right) => left.ordinal - right.ordinal);
    ordered.forEach((item, index) => {
      if (item.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: [items.indexOf(item), "ordinal"],
          message: "Session item ordinals must be contiguous.",
        });
      }
      if (item.itemKey !== `item-${index}`) {
        context.addIssue({
          code: "custom",
          path: [items.indexOf(item), "itemKey"],
          message: "Session item keys must follow their ordinal.",
        });
      }
    });
  });
export type CustomPracticeSessionPlan = z.infer<
  typeof customPracticeSessionPlanSchema
>;

export const customPracticeSessionCreateInputSchema = z.strictObject({
  mode: customPracticeSessionModeSchema.default("PRACTICE_ONLY"),
  targetCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS)
    .default(DEFAULT_CUSTOM_PRACTICE_SESSION_ITEMS),
  scope: customPracticeSessionScopeSchema,
});
export type CustomPracticeSessionCreateInput = z.infer<
  typeof customPracticeSessionCreateInputSchema
>;

export const customPracticeSessionRecordSchema = z.strictObject({
  id: boundedIdSchema,
  userId: boundedIdSchema,
  mode: customPracticeSessionModeSchema,
  status: customPracticeSessionStatusSchema,
  targetCount: z.number().int().min(1).max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS),
  completedCount: z.number().int().min(0).max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS),
  nextIndex: z.number().int().min(0).max(MAX_CUSTOM_PRACTICE_SESSION_ITEMS),
  version: z.number().int().min(0),
  scope: customPracticeSessionScopeSchema,
  plan: customPracticeSessionPlanSchema,
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CustomPracticeSessionRecord = z.infer<
  typeof customPracticeSessionRecordSchema
>;

export type CustomPracticeSessionSetupResult =
  | {
      status: "ready";
      session: CustomPracticeSessionRecord;
    }
  | {
      status: "preparing";
      session: CustomPracticeSessionRecord;
      message: string;
    }
  | {
      status: "unavailable";
      message: string;
    };

export type CustomPracticeSessionItemResult =
  | {
      status: "ready";
      session: CustomPracticeSessionRecord;
      item: CustomPracticeSessionItem;
    }
  | {
      status: "completed";
      session: CustomPracticeSessionRecord;
      message: string;
    }
  | {
      status: "stopped";
      session: CustomPracticeSessionRecord;
      message: string;
    }
  | {
      status: "daily-limit";
      session: CustomPracticeSessionRecord;
      message: string;
    }
  | {
      status: "preparing";
      session: CustomPracticeSessionRecord;
      message: string;
    }
  | {
      status: "unavailable";
      session?: CustomPracticeSessionRecord;
      message: string;
    };

export type CustomPracticeSessionCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      completedCount: number;
      targetCount: number;
      next: CustomPracticeSessionItemResult;
    }
  | {
      status:
        | "invalid-answer"
        | "not-found"
        | "conflict"
        | "not-presented"
        | "unavailable";
      message: string;
    };

export function normalizeCustomPracticeSessionScope(
  scope: CustomPracticeSessionScope,
): CustomPracticeSessionScope {
  return customPracticeSessionScopeSchema.parse({
    ...scope,
    collectionIds: uniqueSorted(scope.collectionIds),
    tags: uniqueSorted(scope.tags),
    skillIds: uniqueSorted(scope.skillIds),
  });
}

export function resolveCustomPracticeSkillPrefill(
  requestedSkillId: string | null | undefined,
  activeOwnedSkillIds: readonly string[],
): string | null {
  const normalized = requestedSkillId?.trim() ?? "";
  return normalized && activeOwnedSkillIds.includes(normalized) ? normalized : null;
}

export function createCustomPracticeSessionItemKey(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= MAX_CUSTOM_PRACTICE_SESSION_ITEMS) {
    throw new RangeError("Custom practice session item ordinal is out of bounds.");
  }

  return `item-${ordinal}`;
}

/**
 * IDs are deterministic for a session item. The service uses them as the
 * database id for ExerciseAttempt, so retries and multiple tabs converge on
 * the same attempt row instead of consuming the item twice.
 */
export function createCustomPracticeAttemptId(
  sessionId: string,
  ordinal: number,
): string {
  const normalizedSessionId = boundedIdSchema.parse(sessionId);
  const itemKey = createCustomPracticeSessionItemKey(ordinal);
  const value = `custom-${normalizedSessionId}-${itemKey}`;

  if (value.length > 220) {
    throw new RangeError("Custom practice session ID is too long.");
  }

  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted((a, b) =>
    a.localeCompare(b),
  );
}
