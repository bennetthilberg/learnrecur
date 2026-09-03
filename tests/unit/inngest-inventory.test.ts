import { describe, expect, it } from "vitest";

import { ACCOUNT_DELETION_REQUESTED_EVENT } from "@/lib/inngest/events";
import { learnRecurInngestFunctions } from "@/lib/inngest/functions";

const sourceFunctionIds = learnRecurInngestFunctions.map((fn) => String(fn.opts.id));

const expectedFunctionIds = [
  "choice-exercise-refill",
  "exact-input-exercise-refill",
  "math-exercise-refill",
  "source-upload-draft",
  "material-ingestion",
  "material-cleanup",
  "material-draft-item",
  "material-batch-activation",
  "agent-skill-operation",
  "agent-connection-revocation",
  "account-deletion",
  "account-deletion-recovery",
  "agent-access-maintenance",
  "due-practice-reminders",
];

describe("Inngest production inventory", () => {
  it("matches the 14 functions registered by the source registry", () => {
    expect(sourceFunctionIds).toEqual(expectedFunctionIds);
  });

  it("keeps account deletion and recovery in the executable inventory", () => {
    const deletion = learnRecurInngestFunctions.find(
      (fn) => String(fn.opts.id) === "account-deletion",
    );
    const recovery = learnRecurInngestFunctions.find(
      (fn) => String(fn.opts.id) === "account-deletion-recovery",
    );

    expect(deletion?.opts.triggers).toContainEqual({
      event: ACCOUNT_DELETION_REQUESTED_EVENT,
    });
    expect(recovery?.opts.triggers).toContainEqual({ cron: "*/15 * * * *" });
  });
});
