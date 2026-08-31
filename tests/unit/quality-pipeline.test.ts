import { describe, expect, it } from "vitest";

import { SkillFsrsState } from "@/generated/prisma/client";
import {
  buildGenerationQualityContext,
  toPersistedChoiceQuality,
} from "@/lib/skills/quality-pipeline";
import { contextManifestSchema, exerciseBlueprintSchema } from "@/lib/skills/generation-quality";

const skill = {
  id: "skill-statistics",
  title: "Interpret confidence intervals",
  objective: "Choose conclusions supported by a sample proportion and confidence interval.",
  rules: { items: ["The point estimate should lie within its confidence interval."] },
  examples: null,
  exerciseConstraints: null,
  tags: ["statistics"],
  fsrsState: SkillFsrsState.REVIEW,
  dueAt: new Date("2026-08-31T12:00:00.000Z"),
  repetitions: 4,
  lapses: 1,
  stability: 8,
};

describe("buildGenerationQualityContext", () => {
  it("builds deterministic validated specs, manifests, and mastery-aware blueprints", () => {
    const input = {
      skill,
      sourceContext: "Page 4: the sample estimate is 0.70 and the 95% interval is (0.65, 0.75).",
      requestedCount: 3,
      now: new Date("2026-08-31T12:00:00.000Z"),
    };
    const first = buildGenerationQualityContext(input);
    const second = buildGenerationQualityContext(input);

    expect(first).toEqual(second);
    expect(exerciseBlueprintSchema.safeParse(first.blueprint).success).toBe(true);
    expect(contextManifestSchema.safeParse(first.contextManifest).success).toBe(true);
    expect(first.blueprint.slots).toHaveLength(3);
    expect(first.skillSpec.sourceRequirements.required).toBe(true);
    expect(first.skillSpec.materialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first.contextManifest)).not.toContain("sample estimate");
  });

  it("records source truncation instead of silently treating a clipped excerpt as complete", () => {
    const context = buildGenerationQualityContext({
      skill,
      sourceContext: "Evidence excerpt.\n\n[truncated]",
      requestedCount: 1,
      now: new Date("2026-08-31T12:00:00.000Z"),
    });

    expect(context.contextManifest.truncationNotices).toEqual([
      expect.objectContaining({ sourceId: "source-context", reason: "provider-limit" }),
    ]);
  });
});

describe("toPersistedChoiceQuality", () => {
  it("persists inspectable acceptance metadata without raw source text", () => {
    const context = buildGenerationQualityContext({
      skill,
      sourceContext: "Private source evidence that must not be copied into audit metadata.",
      requestedCount: 1,
      now: new Date("2026-08-31T12:00:00.000Z"),
    });
    const result = toPersistedChoiceQuality({
      context,
      candidateId: "candidate-1",
      slotIndex: 0,
      exercise: {
        prompt: "A sample estimate is 70% with a 95% confidence interval of (0.65, 0.75). Which statement is supported?",
        choices: [
          { id: "a", label: "The estimate is inside the interval." },
          { id: "b", label: "The estimate is outside the interval." },
        ],
        answerSpec: { kind: "choice", correctChoiceId: "a" },
        correctAnswerDisplay: "The estimate is inside the interval.",
        explanation: "0.70 is between 0.65 and 0.75.",
        difficulty: 3,
        expectedSeconds: 40,
      },
    });

    expect(result.acceptanceDecision).toBe("PUBLISHED");
    expect(result.acceptanceMetadata).toMatchObject({ accepted: true });
    expect(JSON.stringify(result)).not.toContain("Private source evidence");
  });
});
