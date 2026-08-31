import { describe, expect, it } from "vitest";

import {
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
  mathExerciseRefillFunction,
} from "@/lib/inngest/functions";

describe("Inngest exercise refill functions", () => {
  it.each([
    ["choice", choiceExerciseRefillFunction],
    ["exact input", exactInputExerciseRefillFunction],
    ["math", mathExerciseRefillFunction],
  ])("uses bounded retries and per-skill concurrency for %s refills", (_name, fn) => {
    expect(fn.opts).toMatchObject({
      retries: 2,
      concurrency: {
        limit: 1,
        key: "event.data.skillId",
      },
    });
  });
});
