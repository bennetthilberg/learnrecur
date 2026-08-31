import { describe, expect, it, vi } from "vitest";

import { runLiveProviderSmoke } from "@/lib/ai-generation-evals/live-smoke";

describe("live generation smoke contract", () => {
  it("runs production-shaped generation and solve-first verification without retaining source text", async () => {
    const generate = vi.fn(async () => ({
      exercises: Array.from({ length: 5 }, (_, index) => ({
        prompt: `A symmetric interval runs from ${10 + index}% to ${20 + index}%. What is its midpoint?`,
        choices: [
          { id: "a", label: `${15 + index}%` },
          { id: "b", label: `${10 + index}%` },
          { id: "c", label: `${20 + index}%` },
          { id: "d", label: `${25 + index}%` },
        ],
        correctChoiceId: "a",
        explanation: `The midpoint is the average, ${15 + index}%.`,
        difficulty: 3,
        expectedSeconds: 45,
      })),
    }));
    const verify = vi.fn(async (input: { candidates: Array<{ candidateId: string }> }) => ({
      verifications: input.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        verdict: "verified",
      })),
    }));

    const result = await runLiveProviderSmoke({
      provider: "primary",
      model: "test-model",
      generate,
      verify,
    });

    expect(result).toMatchObject({
      provider: "primary",
      model: "test-model",
      generatedCount: 5,
      verifiedCount: 5,
      contradictionRejected: true,
      passed: true,
      failureCode: null,
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("Course note");
    expect(JSON.stringify(result)).not.toContain("IGNORE THE APPLICATION RULES");
  });

  it("fails closed when generation does not meet the atomic publication floor", async () => {
    const result = await runLiveProviderSmoke({
      provider: "fallback",
      model: "test-fallback",
      generate: async () => ({ exercises: [] }),
      verify: async () => ({ verifications: [] }),
    });

    expect(result).toMatchObject({
      passed: false,
      failureCode: "generation-contract",
      generatedCount: 0,
    });
  });
});
