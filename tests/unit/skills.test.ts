import { describe, expect, it } from "vitest";

import {
  MAX_GENERATED_EXERCISES,
  MIN_ACTIVATION_EXERCISES,
  normalizeSkillDraftInput,
  validateGeneratedChoiceExercises,
} from "@/lib/skills";

const validExercise = (id: number) => ({
  prompt: `What does sample ${id} mean?`,
  choices: [
    { id: "a", label: `Correct ${id}` },
    { id: "b", label: `Wrong ${id}` },
    { id: "c", label: `Distractor ${id}` },
  ],
  correctChoiceId: "a",
  explanation: `Sample ${id} uses the target idea.`,
  difficulty: 2,
  expectedSeconds: 25,
});

describe("normalizeSkillDraftInput", () => {
  it("trims draft fields, splits multiline notes, and deduplicates tags", () => {
    const result = normalizeSkillDraftInput({
      title: "  Ser vs estar basics  ",
      objective: "  Choose between ser and estar in common identity/location cases.  ",
      collectionName: "  Spanish grammar  ",
      rules: "Use ser for identity.\n\nUse estar for location.",
      examples: "Soy estudiante.\nEstoy en casa.",
      exerciseConstraints: "Keep choices short and avoid trick questions.",
      tags: " Spanish, grammar, spanish , verbs ",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        title: "Ser vs estar basics",
        objective: "Choose between ser and estar in common identity/location cases.",
        collectionName: "Spanish grammar",
        rules: ["Use ser for identity.", "Use estar for location."],
        examples: ["Soy estudiante.", "Estoy en casa."],
        exerciseConstraints: "Keep choices short and avoid trick questions.",
        tags: ["spanish", "grammar", "verbs"],
      },
    });
  });

  it("rejects underspecified skill drafts with stable field errors", () => {
    const result = normalizeSkillDraftInput({
      title: "  ",
      objective: "too short",
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.title).toEqual(["Skill title is required."]);
      expect(result.fieldErrors.objective).toEqual([
        "Describe the skill objective in at least 12 characters.",
      ]);
    }
  });
});

describe("validateGeneratedChoiceExercises", () => {
  it("accepts valid generated multiple-choice exercises and normalizes answer specs", () => {
    const result = validateGeneratedChoiceExercises({
      exercises: [validExercise(1), validExercise(2), validExercise(3)],
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.exercises).toHaveLength(MIN_ACTIVATION_EXERCISES);
      expect(result.rejectedCount).toBe(0);
      expect(result.exercises[0]).toMatchObject({
        prompt: "What does sample 1 mean?",
        answerSpec: {
          kind: "choice",
          correctChoiceId: "a",
        },
        correctAnswerDisplay: "Correct 1",
        expectedSeconds: 25,
      });
    }
  });

  it("rejects duplicate choice IDs, missing correct choices, empty labels, and empty choice arrays", () => {
    const result = validateGeneratedChoiceExercises({
      exercises: [
        {
          ...validExercise(1),
          choices: [
            { id: "same", label: "First" },
            { id: "same", label: "Second" },
          ],
          correctChoiceId: "same",
        },
        {
          ...validExercise(2),
          correctChoiceId: "missing",
        },
        {
          ...validExercise(3),
          choices: [
            { id: "a", label: "   " },
            { id: "b", label: "Wrong" },
          ],
          correctChoiceId: "a",
        },
        {
          ...validExercise(4),
          choices: [],
          correctChoiceId: "a",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-valid-exercises",
      validCount: 0,
      rejectedCount: 4,
    });
  });

  it("requires at least three valid generated exercises", () => {
    const result = validateGeneratedChoiceExercises({
      exercises: [validExercise(1), validExercise(2)],
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-valid-exercises",
      validCount: 2,
      rejectedCount: 0,
    });
  });

  it("fails closed for malformed response envelopes", () => {
    const result = validateGeneratedChoiceExercises({
      items: [validExercise(1), validExercise(2), validExercise(3)],
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
      validCount: 0,
      rejectedCount: 0,
    });
  });

  it("rejects oversized generated exercise envelopes before parsing candidates", () => {
    const result = validateGeneratedChoiceExercises({
      exercises: Array.from({ length: MAX_GENERATED_EXERCISES + 1 }, (_, index) =>
        validExercise(index),
      ),
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
      validCount: 0,
      rejectedCount: 0,
    });
  });
});
