import { describe, expect, it } from "vitest";
import { checkAnswer } from "@/lib/answer-checking";
import {
  agentCandidateExerciseSchema,
  normalizeAgentCandidateExercise,
} from "@/lib/agent-access/contracts";
import { validateGeneratedExactInputExercises } from "@/lib/skills";
import {
  retentionTextFixtures,
  retentionGeneratedText,
  retentionMathFixtures,
} from "../fixtures/ai-generation/retention-fixtures";

describe("cross-subject retention generation contracts", () => {
  for (const fixture of retentionTextFixtures)
    it(`${fixture.id}: native and external generation preserve the approved distinctions`, () => {
      const exercise = retentionGeneratedText(fixture);
      const validation = validateGeneratedExactInputExercises(
        { exercises: [exercise] },
        {
          minValidExercises: 1,
          maxGeneratedExercises: 2,
          textPolicy: fixture.policy,
        },
      );
      expect(validation.status).toBe("ready");
      for (const [answer, isCorrect] of [
        [fixture.equivalent, true],
        [fixture.wrong, false],
      ] as const)
        expect(
          checkAnswer({
            answerSpec: exercise.answerSpec,
            submittedAnswer: answer,
          }),
        ).toMatchObject({ isCorrect });
      expect(
        validateGeneratedExactInputExercises(
          {
            exercises: [
              {
                ...exercise,
                answerSpec: {
                  ...exercise.answerSpec,
                  normalizeDiacritics: true,
                },
              },
            ],
          },
          {
            minValidExercises: 1,
            maxGeneratedExercises: 2,
            textPolicy: fixture.policy,
          },
        ).status,
      ).toBe("invalid");
      const agent = agentCandidateExerciseSchema.parse({
        kind: "text",
        prompt: fixture.prompt,
        acceptedAnswers: [fixture.answer],
        normalization: {
          case: fixture.policy.normalizeCase,
          whitespace: fixture.policy.normalizeWhitespace,
        },
      });
      expect(normalizeAgentCandidateExercise(agent, 0).answerSpec).toEqual(
        exercise.answerSpec,
      );
      expect(
        agentCandidateExerciseSchema.safeParse({
          ...agent,
          normalization: { ...agent.normalization, diacritics: true },
        }).success,
      ).toBe(false);
    });
  it("keeps fractions and symbolic equivalence independent of text policy", () => {
    for (const fixture of retentionMathFixtures) {
      expect(
        checkAnswer({
          answerSpec: fixture.answerSpec,
          submittedAnswer: fixture.answer,
        }),
      ).toMatchObject({ isCorrect: true });
      expect(
        checkAnswer({
          answerSpec: fixture.answerSpec,
          submittedAnswer: fixture.wrong,
        }),
      ).toMatchObject({ isCorrect: false });
    }
  });
});
