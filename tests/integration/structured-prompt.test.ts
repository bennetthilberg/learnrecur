import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import { activateSkillDraft, refillExactInputExercisesForSkill, refillMathExercisesForSkill } from "@/lib/skills";
import { getNextPracticeItem, previewPracticeItemBuffer } from "@/lib/practice";
import { createCustomPracticeSession, presentCustomPracticeSessionItem } from "@/lib/practice/custom-session";
import { createSkillFixture } from "./test-helpers";
import { composeStructuredPrompt } from "@/lib/practice/structured-prompt";
const database = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
database("structured prompt persistence", () => {
  const prisma = getPrisma();
  const userId = `prompt-${randomUUID()}`;
  const now = new Date("2026-09-14T12:00:00Z");
  beforeAll(async () => { await prisma.user.create({ data: { id: userId, dailyNewSkillLimit: null } }); });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: userId } }); });
  it("preserves verified parts through generation, storage, normal preload, and custom practice", async () => {
    const skill = await createSkillFixture(prisma, { userId, title: "French singular verbs", status: "DRAFT" });
    const layouts = ["Carlos", "Mateo", "Sofia"].map(name => ({ instruction: "Complétez la phrase.", content: `${name} ____ médecin.` }));
    const result = await activateSkillDraft({ userId, skillId: skill.id, now, model: "test-gemini",
      generateChoiceExercises: async () => ({ exercises: layouts.map(layout => ({ ...layout, choices: [{ id: "a", label: "est" }, { id: "b", label: "sont" }, { id: "c", label: "sommes" }], correctChoiceId: "a", explanation: "A singular subject takes est." })) }),
      verifyChoiceExercises: async ({ candidates }) => {
        for (const candidate of candidates) expect(layouts.map(composeStructuredPrompt)).toContain(candidate.prompt);
        return { verifications: candidates.map(candidate => ({ candidateId: candidate.candidateId, verdict: "verified" })) };
      },
    });
    expect(result.status).toBe("activated");
    const stored = await prisma.exercise.findMany({ where: { userId, skillId: skill.id } });
    expect(stored).toHaveLength(3);
    for (const exercise of stored) {
      const layout = layouts.find(layout => composeStructuredPrompt(layout) === exercise.prompt)!;
      expect(exercise.generationMetadata).toMatchObject({ promptLayout: layout, contextManifest: expect.any(Object) });
    }
    const next = await getNextPracticeItem({ userId, now });
    expect(next.status).toBe("ready");
    if (next.status !== "ready") throw new Error("Expected practice");
    expect(next.exercise.promptLayout).toEqual(layouts.find(layout => composeStructuredPrompt(layout) === next.exercise.prompt));
    const buffer = await previewPracticeItemBuffer({ userId, now, excludedSkillIds: [], limit: 10 });
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0].exercise.promptLayout).toBeTruthy();
    const session = await createCustomPracticeSession({ userId, now, mode: "PRACTICE_ONLY", targetCount: 1, scope: { collectionIds: [], tags: [], skillIds: [skill.id], recentlyMissed: false, mixedReview: true } });
    if (session.status !== "ready") throw new Error(JSON.stringify(session));
    const custom = await presentCustomPracticeSessionItem({ userId, now, sessionId: session.session.id });
    expect(custom.status).toBe("ready");
    if (custom.status === "ready") expect(custom.exercise.promptLayout).toEqual(layouts.find(layout => composeStructuredPrompt(layout) === custom.exercise.prompt));
    await prisma.exercise.updateMany({ where: { userId }, data: { generationMetadata: { promptLayout: { instruction: "Wrong instruction", content: "Different question" } } } });
    const invalid = await getNextPracticeItem({ userId, now });
    if (invalid.status !== "ready") throw new Error("Expected legacy fallback");
    expect(invalid.exercise.promptLayout).toBeNull();
    expect(layouts.map(composeStructuredPrompt)).toContain(invalid.exercise.prompt);
  });
  it("persists instruction parts for text and math refill candidates", async () => {
    const textSkill = await createSkillFixture(prisma, { userId, title: "French verb production", repetitions: 3 });
    const textLayout = { instruction: "Complétez la phrase.", content: "Carlos ____ médecin." };
    const textResult = await refillExactInputExercisesForSkill({ userId, skillId: textSkill.id, now, targetReadyCount: 1, model: "test-gemini",
      generateExactInputExercises: async () => ({ exercises: [{ ...textLayout, answerKind: "TEXT", answerSpec: { kind: "text", policyVersion: 2, accepted: ["est"], normalizeCase: true, normalizeWhitespace: true, normalizeDiacritics: false }, correctAnswerDisplay: "est", explanation: "A singular subject takes est." }] }),
      verifyExactInputExercises: async ({ candidates }) => ({ verifications: candidates.map(candidate => ({ candidateId: candidate.candidateId, verdict: "verified" })) }),
    });
    expect(textResult.status, JSON.stringify(textResult)).toBe("refilled");
    const mathSkill = await createSkillFixture(prisma, { userId, title: "Combine like terms", repetitions: 3 });
    const mathLayout = { instruction: "Réduisez cette expression.", content: "x + x" };
    const mathResult = await refillMathExercisesForSkill({ userId, skillId: mathSkill.id, now, targetReadyCount: 1, model: "test-gemini",
      generateMathExercises: async () => ({ exercises: [{ ...mathLayout, answerKind: "MATH", answerSpec: { kind: "math", acceptedExpressions: ["2x"], equivalence: "basic-symbolic" }, correctAnswerDisplay: "2x", explanation: "Combine the coefficients." }] }),
      verifyMathExercises: async ({ candidates }) => ({ verifications: candidates.map(candidate => ({ candidateId: candidate.candidateId, verdict: "verified" })) }),
    });
    expect(mathResult.status, JSON.stringify(mathResult)).toBe("refilled");
    for (const [skill, layout] of [[textSkill, textLayout], [mathSkill, mathLayout]] as const) {
      const stored = await prisma.exercise.findFirstOrThrow({ where: { skillId: skill.id, userId } });
      expect(stored.prompt).toBe(composeStructuredPrompt(layout));
      expect(stored.generationMetadata).toMatchObject({ promptLayout: layout, contextManifest: expect.any(Object) });
    }
  });

});
