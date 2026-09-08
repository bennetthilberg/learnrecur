import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCustomPracticeSession: vi.fn(),
  findSession: vi.fn(),
  getPrisma: vi.fn(),
  withAgentMutation: vi.fn(),
}));

vi.mock("@/lib/agent-access/access", () => ({
  authorizeAgentRead: vi.fn(),
  withAgentMutation: mocks.withAgentMutation,
}));

vi.mock("@/lib/practice/custom-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/practice/custom-session")>()),
  createCustomPracticeSession: mocks.createCustomPracticeSession,
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: mocks.getPrisma,
}));

import type { AgentAuthContext } from "@/lib/agent-access/auth";
import { createAgentCustomSession } from "@/lib/agent-access/custom-sessions";
import { previewCustomPracticeAnswer } from "@/lib/practice/custom-session";

const auth = { userId: "user-1" } as AgentAuthContext;
const sessionDates = {
  startedAt: new Date("2026-09-08T12:00:00.000Z"),
  stoppedAt: null,
  completedAt: null,
  createdAt: new Date("2026-09-08T12:00:00.000Z"),
  updatedAt: new Date("2026-09-08T12:00:00.000Z"),
};

function session(status: "ACTIVE" | "STOPPED" | "COMPLETED") {
  return {
    id: "session/one",
    userId: "user-1",
    mode: "PRACTICE_ONLY" as const,
    status,
    targetCount: 1,
    completedCount: status === "COMPLETED" ? 1 : 0,
    nextIndex: status === "COMPLETED" ? 1 : 0,
    version: 1,
    scope: {
      collectionIds: [],
      tags: [],
      skillIds: ["skill-1"],
      recentlyMissed: false,
      mixedReview: false,
    },
    plan: [
      {
        ordinal: 0,
        itemKey: "item-0",
        skillId: "skill-1",
        exerciseId: "exercise-1",
        attemptId: "custom-session-1-item-0",
        status: status === "COMPLETED" ? ("COMPLETED" as const) : ("PRESENTED" as const),
        presentedAt: sessionDates.startedAt,
        completedAt: status === "COMPLETED" ? sessionDates.updatedAt : null,
      },
    ],
    ...sessionDates,
  };
}

describe("custom practice session service boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAgentMutation.mockImplementation(
      async (_auth: AgentAuthContext, _scope: string, work: (tx: unknown) => Promise<unknown>) =>
        work({}),
    );
    mocks.getPrisma.mockReturnValue({
      practiceSession: { findFirst: mocks.findSession },
      exercise: { findFirst: vi.fn() },
    });
  });

  it("returns the route's sessionId query parameter for an agent-created session", async () => {
    mocks.createCustomPracticeSession.mockResolvedValue({
      status: "ready",
      session: session("ACTIVE"),
    });

    const result = await createAgentCustomSession(auth, {
      target_count: 1,
      scope: {},
    });

    expect(result.session.practice_url).toBe("/practice?sessionId=session%2Fone");
  });

  it.each(["STOPPED", "COMPLETED"] as const)(
    "rejects preview for a %s session before reading the exercise",
    async (status) => {
      mocks.findSession.mockResolvedValue(session(status));

      await expect(
        previewCustomPracticeAnswer({
          userId: "user-1",
          sessionId: "session/one",
          itemKey: "item-0",
          exerciseId: "exercise-1",
          submittedAnswer: "answer",
        }),
      ).resolves.toEqual({
        status: "unavailable",
        message:
          status === "STOPPED"
            ? "This practice session is stopped. Resume it to continue."
            : "This practice session is complete.",
      });

      expect(mocks.getPrisma().exercise.findFirst).not.toHaveBeenCalled();
    },
  );
});
