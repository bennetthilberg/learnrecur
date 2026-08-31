import { describe, expect, it } from "vitest";

import {
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
  mathExerciseRefillFunction,
} from "@/lib/inngest/functions";
import { REFILL_JOB_RETRY_LIMIT } from "@/lib/skills/refill-policy";

describe("Inngest exercise refill functions", () => {
  it.each([
    ["choice", choiceExerciseRefillFunction],
    ["exact input", exactInputExerciseRefillFunction],
    ["math", mathExerciseRefillFunction],
  ])("uses bounded retries and per-skill concurrency for %s refills", (_name, fn) => {
    expect(fn.opts).toMatchObject({
      retries: REFILL_JOB_RETRY_LIMIT,
      concurrency: {
        limit: 1,
        key: "event.data.skillId",
      },
    });
  });
});
