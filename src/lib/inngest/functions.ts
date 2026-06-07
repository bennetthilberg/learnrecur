import "server-only";

import {
  parseExerciseRefillEventPayload,
  parseSourceUploadDraftEventPayload,
} from "@/lib/inngest/events";
import { processDueReminderBatch } from "@/lib/reminders";
import {
  runChoiceExerciseRefillJob,
  runExactInputExerciseRefillJob,
  runMathExerciseRefillJob,
} from "@/lib/skills/refill-jobs";
import { runQueuedSourceUploadDraftJob } from "@/lib/skills/uploads";

import {
  CHOICE_REFILL_REQUESTED_EVENT,
  EXACT_INPUT_REFILL_REQUESTED_EVENT,
  MATH_REFILL_REQUESTED_EVENT,
  SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT,
} from "./events";
import { inngest } from "./client";

export const choiceExerciseRefillFunction = inngest.createFunction(
  {
    id: "choice-exercise-refill",
    triggers: [{ event: CHOICE_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill choice exercises", () =>
      runChoiceExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const exactInputExerciseRefillFunction = inngest.createFunction(
  {
    id: "exact-input-exercise-refill",
    triggers: [{ event: EXACT_INPUT_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill exact-input exercises", () =>
      runExactInputExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const mathExerciseRefillFunction = inngest.createFunction(
  {
    id: "math-exercise-refill",
    triggers: [{ event: MATH_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill math exercises", () =>
      runMathExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const sourceUploadDraftFunction = inngest.createFunction(
  {
    id: "source-upload-draft",
    triggers: [{ event: SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseSourceUploadDraftEventPayload(event.data);

    return step.run("create source-backed drafts", () =>
      runQueuedSourceUploadDraftJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const duePracticeReminderFunction = inngest.createFunction(
  {
    id: "due-practice-reminders",
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("send due practice reminders", () =>
      processDueReminderBatch({
        now: new Date(),
      }),
    ),
);

export const learnRecurInngestFunctions = [
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
  mathExerciseRefillFunction,
  sourceUploadDraftFunction,
  duePracticeReminderFunction,
];
