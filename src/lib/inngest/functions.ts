import "server-only";

import { parseExerciseRefillEventPayload } from "@/lib/inngest/events";
import {
  runChoiceExerciseRefillJob,
  runExactInputExerciseRefillJob,
} from "@/lib/skills/refill-jobs";

import {
  CHOICE_REFILL_REQUESTED_EVENT,
  EXACT_INPUT_REFILL_REQUESTED_EVENT,
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

export const learnRecurInngestFunctions = [
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
];
