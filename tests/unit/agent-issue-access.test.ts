import { describe, expect, it } from "vitest";

import { toPublicIssue } from "@/lib/agent-access/exercise-issues";

const issue = {
  exerciseId: "exercise-1",
  skillId: "skill-1",
  skillTitle: "Spanish past tense",
  collectionName: null,
  prompt: "Choose the correct form.",
  correctAnswerDisplay: "habló",
  answerKind: "TEXT",
  issueVersion: new Date("2026-09-18T03:00:00.000Z"),
  retiredAt: null,
  retirementReason: null,
  flags: [],
  attempts: [
    {
      id: "attempt-1",
      result: "INCORRECT",
      submittedAnswerDisplay: "private submitted answer",
      responseMs: 1200,
      completedAt: new Date("2026-09-18T02:00:00.000Z"),
      practiceOnly: false,
    },
  ],
} as never;

describe("exercise issue public projection", () => {
  it("keeps submitted answers behind the separate history scope", () => {
    const auditOnly = toPublicIssue(issue, false);
    expect(auditOnly).not.toHaveProperty("recent_attempts");
    expect(JSON.stringify(auditOnly)).not.toContain("private submitted answer");

    const withHistory = toPublicIssue(issue, true);
    expect(withHistory).toMatchObject({
      recent_attempts: [{ submitted_answer: "private submitted answer" }],
    });
  });
});
