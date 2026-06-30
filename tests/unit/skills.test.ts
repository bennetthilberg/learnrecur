import { describe, expect, it } from "vitest";

import {
  AnswerKind,
} from "@/generated/prisma/client";
import {
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  DEFAULT_READY_MATH_TARGET,
  EXACT_INPUT_UNLOCK_REPETITIONS,
  EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT,
  SOURCE_CONTEXT_CHAR_LIMIT,
  MAX_GENERATED_EXERCISES,
  MIN_ACTIVATION_EXERCISES,
  buildExistingChoiceExerciseContext,
  buildExistingExactInputExerciseContext,
  buildExistingMathExerciseContext,
  buildSourceContextExcerpt,
  filterDuplicateChoiceExercises,
  filterDuplicateExactInputExercises,
  filterDuplicateMathExercises,
  isExactInputUnlocked,
  normalizeSourceSkillDraftInput,
  normalizeSkillPracticeGuidanceInput,
  normalizeSkillDraftInput,
  toGeneratedChoiceExerciseCandidates,
  toGeneratedExactInputExerciseCandidates,
  toGeneratedMathExerciseCandidates,
  validateChoiceExerciseVerification,
  validateExactInputExerciseVerification,
  validateMathExerciseVerification,
  validateGeneratedSkillDrafts,
  validateGeneratedChoiceExercises,
  validateGeneratedExactInputExercises,
  validateGeneratedMathExercises,
  createSkillDraftFromSource,
  type GeneratedExactInputExercise,
  type GeneratedMathExercise,
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

const validGeneratedExercise = (id: number) => ({
  prompt: `What does sample ${id} mean?`,
  choices: [
    { id: "a", label: `Correct ${id}` },
    { id: "b", label: `Wrong ${id}` },
    { id: "c", label: `Distractor ${id}` },
  ],
  answerSpec: {
    kind: "choice" as const,
    correctChoiceId: "a",
  },
  correctAnswerDisplay: `Correct ${id}`,
  explanation: `Sample ${id} uses the target idea.`,
  difficulty: 2,
  expectedSeconds: 25,
});

const validExactInputExercise = (id: number): GeneratedExactInputExercise => ({
  prompt: `Type the answer for item ${id}.`,
  answerKind: AnswerKind.TEXT,
  answerSpec: {
    kind: "text",
    accepted: [`answer ${id}`],
    normalizeCase: true,
    normalizeWhitespace: true,
    normalizeDiacritics: true,
  },
  correctAnswerDisplay: `answer ${id}`,
  explanation: `Item ${id} asks for direct recall.`,
  difficulty: 2,
  expectedSeconds: 35,
});

const validMathExercise = (id: number): GeneratedMathExercise => ({
  prompt: `Simplify the expression for item ${id}: x + ${id}x.`,
  answerKind: AnswerKind.MATH,
  answerSpec: {
    kind: "math",
    acceptedExpressions: [`${id + 1}x`],
    equivalence: "basic-symbolic",
  },
  correctAnswerDisplay: `${id + 1}x`,
  explanation: `Combine x and ${id}x to get ${id + 1}x.`,
  difficulty: 2,
  expectedSeconds: 35,
});

const validGeneratedSkillDraft = (id: number) => ({
  title: `Skill draft ${id}`,
  objective: `Practice source-backed skill ${id} with short objective exercises.`,
  rules: [`Rule ${id} comes from the pasted source.`],
  examples: [`Example ${id} from the pasted source.`],
  exerciseConstraints: `Use concise prompts for skill ${id}.`,
  tags: ["Spanish", "Grammar", `Topic ${id}`],
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

  it("rejects oversized optional draft fields before storage or activation", () => {
    const result = normalizeSkillDraftInput({
      title: "Ser vs estar basics",
      objective: "Choose between ser and estar in common identity/location cases.",
      collectionName: "x".repeat(121),
      rules: "x".repeat(1_001),
      examples: "x".repeat(1_001),
      exerciseConstraints: "x".repeat(1_001),
      tags: "x".repeat(41),
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.collectionName).toBeDefined();
      expect(result.fieldErrors.rules).toBeDefined();
      expect(result.fieldErrors.examples).toBeDefined();
      expect(result.fieldErrors.exerciseConstraints).toBeDefined();
      expect(result.fieldErrors.tags).toBeDefined();
    }
  });

  it("rejects extra draft note lines instead of truncating them", () => {
    const nineLines = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n");
    const result = normalizeSkillDraftInput({
      title: "Ser vs estar basics",
      objective: "Choose between ser and estar in common identity/location cases.",
      rules: nineLines,
      examples: nineLines,
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.rules).toBeDefined();
      expect(result.fieldErrors.examples).toBeDefined();
    }
  });

  it("accepts unchanged generated guidance at the rendered draft maximum", () => {
    const maxNotes = Array.from({ length: 8 }, () => "x".repeat(500)).join("\n");
    const result = normalizeSkillDraftInput({
      title: "Ser vs estar basics",
      objective: "Choose between ser and estar in common identity/location cases.",
      rules: maxNotes,
      examples: maxNotes,
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.value.rules).toHaveLength(8);
      expect(result.value.examples).toHaveLength(8);
      expect(result.value.rules[0]).toHaveLength(500);
    }
  });

  it("accepts the rendered maximum tag list", () => {
    const tags = Array.from(
      { length: 12 },
      (_, index) => `tag-${String(index).padStart(2, "0")}-${"x".repeat(33)}`,
    );
    const result = normalizeSkillDraftInput({
      title: "Ser vs estar basics",
      objective: "Choose between ser and estar in common identity/location cases.",
      tags: tags.join(", "),
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.value.tags).toEqual(tags);
    }
  });
});

describe("normalizeSkillPracticeGuidanceInput", () => {
  it("trims guidance fields and stores multiline rules and examples as lists", () => {
    const result = normalizeSkillPracticeGuidanceInput({
      rules: "  Use ser for identity.\n\nUse estar for location. ",
      examples: " Soy estudiante. \n Estoy en casa. ",
      exerciseConstraints: " Keep each prompt short. ",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        rules: ["Use ser for identity.", "Use estar for location."],
        examples: ["Soy estudiante.", "Estoy en casa."],
        exerciseConstraints: "Keep each prompt short.",
      },
    });
  });

  it("allows clearing optional guidance fields", () => {
    const result = normalizeSkillPracticeGuidanceInput({
      rules: " ",
      examples: "",
      exerciseConstraints: "\n",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        rules: [],
        examples: [],
        exerciseConstraints: null,
      },
    });
  });

  it("rejects malformed guidance field shapes with field errors", () => {
    const result = normalizeSkillPracticeGuidanceInput({
      rules: { text: "Use ser for identity." },
      examples: ["Soy estudiante."],
      exerciseConstraints: 42,
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors).toMatchObject({
        examples: [expect.any(String)],
        exerciseConstraints: [expect.any(String)],
        rules: [expect.any(String)],
      });
    }
  });

  it("rejects extra guidance note lines instead of truncating them", () => {
    const nineLines = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n");
    const result = normalizeSkillPracticeGuidanceInput({
      rules: nineLines,
      examples: nineLines,
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.rules).toBeDefined();
      expect(result.fieldErrors.examples).toBeDefined();
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

  it("allows refill validation to accept one valid generated exercise", () => {
    const result = validateGeneratedChoiceExercises(
      {
        exercises: [validExercise(1)],
      },
      {
        minValidExercises: 1,
        maxGeneratedExercises: 1,
      },
    );

    expect(result).toMatchObject({
      status: "ready",
      rejectedCount: 0,
    });
  });

  it("still requires activation validation to use the default minimum", () => {
    const result = validateGeneratedChoiceExercises({
      exercises: [validExercise(1)],
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-valid-exercises",
      validCount: 1,
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

  it("rejects refill envelopes that exceed the requested batch size", () => {
    const result = validateGeneratedChoiceExercises(
      {
        exercises: [validExercise(1), validExercise(2)],
      },
      {
        minValidExercises: 1,
        maxGeneratedExercises: 1,
      },
    );

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
      validCount: 0,
      rejectedCount: 0,
    });
  });
});

describe("validateGeneratedExactInputExercises", () => {
  it("accepts valid text and numeric exact-input exercises", () => {
    const result = validateGeneratedExactInputExercises({
      exercises: [
        validExactInputExercise(1),
        {
          prompt: "Enter the decimal equivalent of three fourths.",
          answerKind: AnswerKind.NUMERIC,
          answerSpec: {
            kind: "numeric",
            accepted: ["3/4", 0.75],
            tolerance: 0,
          },
          correctAnswerDisplay: "0.75",
          explanation: "Three fourths is 0.75.",
          difficulty: 2,
          expectedSeconds: 30,
        },
      ],
    });

    expect(result).toMatchObject({
      status: "ready",
      rejectedCount: 0,
    });

    if (result.status === "ready") {
      expect(result.exercises).toHaveLength(DEFAULT_READY_EXACT_INPUT_TARGET);
      expect(result.exercises[0].answerSpec).toMatchObject({
        kind: "text",
        accepted: ["answer 1"],
      });
      expect(result.exercises[1].answerSpec).toMatchObject({
        kind: "numeric",
        tolerance: 0,
      });
    }
  });

  it("rejects math, malformed answer specs, empty accepted answers, and mismatched answer kinds", () => {
    const result = validateGeneratedExactInputExercises({
      exercises: [
        {
          ...validExactInputExercise(1),
          answerKind: AnswerKind.TEXT,
          answerSpec: {
            kind: "math",
            acceptedExpressions: ["2x"],
          },
        },
        {
          ...validExactInputExercise(2),
          answerSpec: {
            kind: "text",
            accepted: [],
          },
        },
        {
          ...validExactInputExercise(3),
          answerKind: AnswerKind.NUMERIC,
          answerSpec: {
            kind: "text",
            accepted: ["3"],
          },
        },
        {
          ...validExactInputExercise(4),
          answerKind: AnswerKind.NUMERIC,
          answerSpec: {
            kind: "numeric",
            accepted: [{ type: "fraction", numerator: 1, denominator: 0 }],
          },
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

  it("requires at least one verified exact-input exercise for refill", () => {
    const candidates = toGeneratedExactInputExerciseCandidates([validExactInputExercise(1)]);
    const result = validateExactInputExerciseVerification(
      {
        candidates,
        rawVerification: {
          verifications: [
            {
              candidateId: candidates[0].candidateId,
              verdict: "rejected",
              reason: "ambiguous",
            },
          ],
        },
      },
      { minVerifiedExercises: 1 },
    );

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-verified-exercises",
      verifiedCount: 0,
      rejectedCount: 1,
    });
  });

  it("filters exact duplicate candidates against existing exercises and within the batch", () => {
    const duplicate = validExactInputExercise(1);
    const unique = validExactInputExercise(2);
    const result = filterDuplicateExactInputExercises(
      [duplicate, { ...duplicate }, unique],
      [
        {
          prompt: duplicate.prompt,
          answerKind: duplicate.answerKind,
          answerSpec: duplicate.answerSpec,
          correctAnswerDisplay: duplicate.correctAnswerDisplay,
        },
      ],
    );

    expect(result.duplicateCount).toBe(2);
    expect(result.exercises).toEqual([unique]);
  });

  it("caps existing exact-input context and omits non-exact exercises", () => {
    const result = buildExistingExactInputExerciseContext([
      {
        prompt: `Exact prompt ${"x".repeat(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT)}`,
        answerKind: AnswerKind.TEXT,
        answerSpec: validExactInputExercise(1).answerSpec,
        correctAnswerDisplay: "answer 1",
      },
      {
        prompt: "Choice prompt",
        answerKind: AnswerKind.CHOICE,
        answerSpec: {
          kind: "choice",
          correctChoiceId: "a",
        },
        correctAnswerDisplay: "Choice",
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT);
    expect(result).not.toContain("Choice prompt");
  });
});

describe("validateGeneratedMathExercises", () => {
  it("accepts valid generated math exercises", () => {
    const result = validateGeneratedMathExercises({
      exercises: [validMathExercise(1), validMathExercise(2)],
    });

    expect(result).toMatchObject({
      status: "ready",
      rejectedCount: 0,
    });

    if (result.status === "ready") {
      expect(result.exercises).toHaveLength(DEFAULT_READY_MATH_TARGET);
      expect(result.exercises[0]).toMatchObject({
        answerKind: AnswerKind.MATH,
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["2x"],
          equivalence: "basic-symbolic",
        },
      });
    }
  });

  it("rejects non-math, malformed specs, unsupported equivalence, and oversized expressions", () => {
    const result = validateGeneratedMathExercises({
      exercises: [
        {
          ...validMathExercise(1),
          answerKind: AnswerKind.TEXT,
        },
        {
          ...validMathExercise(2),
          answerSpec: {
            kind: "math",
            acceptedExpressions: [],
            equivalence: "basic-symbolic",
          },
        },
        {
          ...validMathExercise(3),
          answerSpec: {
            kind: "math",
            acceptedExpressions: ["4x"],
            equivalence: "numeric-only",
          },
        },
        {
          ...validMathExercise(4),
          answerSpec: {
            kind: "math",
            acceptedExpressions: ["x".repeat(501)],
            equivalence: "basic-symbolic",
          },
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

  it("rejects math exercises whose display answer does not match the answer spec", () => {
    const result = validateGeneratedMathExercises({
      exercises: [
        {
          ...validMathExercise(1),
          correctAnswerDisplay: "3x",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-valid-exercises",
      validCount: 0,
      rejectedCount: 1,
    });
  });

  it("requires at least one verified math exercise for refill", () => {
    const candidates = toGeneratedMathExerciseCandidates([validMathExercise(1)]);
    const result = validateMathExerciseVerification(
      {
        candidates,
        rawVerification: {
          verifications: [
            {
              candidateId: candidates[0].candidateId,
              verdict: "rejected",
              reason: "answer_mismatch",
            },
          ],
        },
      },
      { minVerifiedExercises: 1 },
    );

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-verified-exercises",
      verifiedCount: 0,
      rejectedCount: 1,
    });
  });

  it("filters exact duplicate math candidates against existing exercises and within the batch", () => {
    const duplicate = validMathExercise(1);
    const unique = validMathExercise(2);
    const result = filterDuplicateMathExercises(
      [duplicate, { ...duplicate }, unique],
      [
        {
          prompt: duplicate.prompt,
          answerKind: duplicate.answerKind,
          answerSpec: duplicate.answerSpec,
          correctAnswerDisplay: duplicate.correctAnswerDisplay,
        },
      ],
    );

    expect(result.duplicateCount).toBe(2);
    expect(result.exercises).toEqual([unique]);
  });

  it("caps existing math context and omits non-math exercises", () => {
    const result = buildExistingMathExerciseContext([
      {
        prompt: `Math prompt ${"x".repeat(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT)}`,
        answerKind: AnswerKind.MATH,
        answerSpec: validMathExercise(1).answerSpec,
        correctAnswerDisplay: "2x",
      },
      {
        prompt: "Text prompt",
        answerKind: AnswerKind.TEXT,
        answerSpec: validExactInputExercise(1).answerSpec,
        correctAnswerDisplay: "answer 1",
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT);
    expect(result).not.toContain("Text prompt");
  });
});

describe("isExactInputUnlocked", () => {
  it("unlocks exact-input practice after the configured review threshold", () => {
    expect(isExactInputUnlocked(EXACT_INPUT_UNLOCK_REPETITIONS - 1)).toBe(false);
    expect(isExactInputUnlocked(EXACT_INPUT_UNLOCK_REPETITIONS)).toBe(true);
  });
});

describe("validateChoiceExerciseVerification", () => {
  function candidates(count = 3) {
    const validation = validateGeneratedChoiceExercises({
      exercises: Array.from({ length: count }, (_, index) => validExercise(index + 1)),
    });

    if (validation.status !== "ready") {
      throw new Error("Expected generated exercises to be valid.");
    }

    return toGeneratedChoiceExerciseCandidates(validation.exercises);
  }

  it("accepts one complete verifier decision per candidate", () => {
    const exerciseCandidates = candidates();
    const result = validateChoiceExerciseVerification({
      candidates: exerciseCandidates,
      rawVerification: {
        verifications: exerciseCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "verified",
        })),
      },
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.exercises).toHaveLength(MIN_ACTIVATION_EXERCISES);
      expect(result.rejectedCount).toBe(0);
      expect(result.decisions).toEqual(
        exerciseCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "verified",
          reason: null,
          note: null,
        })),
      );
    }
  });

  it("filters rejected candidates while preserving verified exercise order", () => {
    const exerciseCandidates = candidates(5);
    const result = validateChoiceExerciseVerification({
      candidates: exerciseCandidates,
      rawVerification: {
        verifications: [
          { candidateId: "candidate-1", verdict: "verified" },
          {
            candidateId: "candidate-2",
            verdict: "rejected",
            reason: "ambiguous",
            note: "Two choices could be defended.",
          },
          { candidateId: "candidate-3", verdict: "verified" },
          {
            candidateId: "candidate-4",
            verdict: "rejected",
            reason: "weak_distractors",
          },
          { candidateId: "candidate-5", verdict: "verified" },
        ],
      },
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.exercises.map((exercise) => exercise.prompt)).toEqual([
        "What does sample 1 mean?",
        "What does sample 3 mean?",
        "What does sample 5 mean?",
      ]);
      expect(result.exercises.every((exercise) => !("candidateId" in exercise))).toBe(true);
      expect(result.rejectedCount).toBe(2);
      expect(result.decisions[1]).toMatchObject({
        candidateId: "candidate-2",
        verdict: "rejected",
        reason: "ambiguous",
        note: "Two choices could be defended.",
      });
    }
  });

  it("fails closed when verifier output references unknown candidates", () => {
    const result = validateChoiceExerciseVerification({
      candidates: candidates(),
      rawVerification: {
        verifications: [
          { candidateId: "candidate-1", verdict: "verified" },
          { candidateId: "candidate-2", verdict: "verified" },
          { candidateId: "candidate-999", verdict: "verified" },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "candidate-mismatch",
      verifiedCount: 0,
      rejectedCount: 3,
    });
  });

  it("fails closed when verifier output omits or duplicates candidate decisions", () => {
    const missing = validateChoiceExerciseVerification({
      candidates: candidates(),
      rawVerification: {
        verifications: [
          { candidateId: "candidate-1", verdict: "verified" },
          { candidateId: "candidate-2", verdict: "verified" },
        ],
      },
    });

    const duplicate = validateChoiceExerciseVerification({
      candidates: candidates(),
      rawVerification: {
        verifications: [
          { candidateId: "candidate-1", verdict: "verified" },
          { candidateId: "candidate-1", verdict: "verified" },
          { candidateId: "candidate-2", verdict: "verified" },
        ],
      },
    });

    expect(missing).toMatchObject({
      status: "invalid",
      reason: "candidate-mismatch",
    });
    expect(duplicate).toMatchObject({
      status: "invalid",
      reason: "candidate-mismatch",
    });
  });

  it("rejects malformed verdicts, missing rejection reasons, and oversized notes", () => {
    const exerciseCandidates = candidates();

    for (const rawVerification of [
      {
        verifications: exerciseCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: candidate.candidateId === "candidate-1" ? "maybe" : "verified",
        })),
      },
      {
        verifications: exerciseCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: candidate.candidateId === "candidate-1" ? "rejected" : "verified",
        })),
      },
      {
        verifications: exerciseCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: candidate.candidateId === "candidate-1" ? "rejected" : "verified",
          reason: candidate.candidateId === "candidate-1" ? "other" : undefined,
          note: candidate.candidateId === "candidate-1" ? "x".repeat(301) : undefined,
        })),
      },
    ]) {
      expect(
        validateChoiceExerciseVerification({
          candidates: exerciseCandidates,
          rawVerification,
        }),
      ).toMatchObject({
        status: "invalid",
        reason: "invalid-response",
      });
    }
  });

  it("requires at least three verified exercises after verifier filtering", () => {
    const exerciseCandidates = candidates();
    const result = validateChoiceExerciseVerification({
      candidates: exerciseCandidates,
      rawVerification: {
        verifications: [
          { candidateId: "candidate-1", verdict: "verified" },
          { candidateId: "candidate-2", verdict: "rejected", reason: "too_easy" },
          { candidateId: "candidate-3", verdict: "rejected", reason: "source_mismatch" },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "too-few-verified-exercises",
      verifiedCount: 1,
      rejectedCount: 2,
    });
  });

  it("allows refill verification to accept one verified exercise", () => {
    const exerciseCandidates = toGeneratedChoiceExerciseCandidates([validGeneratedExercise(1)]);
    const result = validateChoiceExerciseVerification(
      {
        candidates: exerciseCandidates,
        rawVerification: {
          verifications: [{ candidateId: "candidate-1", verdict: "verified" }],
        },
      },
      {
        minVerifiedExercises: 1,
      },
    );

    expect(result).toMatchObject({
      status: "ready",
      rejectedCount: 0,
    });
  });
});

describe("filterDuplicateChoiceExercises", () => {
  it("filters exact prompt and correct-answer repeats against existing and batch exercises", () => {
    const result = filterDuplicateChoiceExercises(
      [
        validGeneratedExercise(1),
        {
          ...validGeneratedExercise(2),
          prompt: "  what does sample 1 mean?  ",
          correctAnswerDisplay: "Correct 1",
        },
        validGeneratedExercise(2),
        {
          ...validGeneratedExercise(3),
          prompt: "What does sample 2 mean?",
          correctAnswerDisplay: "Correct 2",
        },
      ],
      [
        {
          prompt: "What does sample 1 mean?",
          correctAnswerDisplay: "Correct 1",
        },
      ],
    );

    expect(result.duplicateCount).toBe(3);
    expect(result.exercises.map((exercise) => exercise.prompt)).toEqual([
      "What does sample 2 mean?",
    ]);
  });
});

describe("normalizeSourceSkillDraftInput", () => {
  it("trims source input, preserves optional context, and deduplicates tags", () => {
    const result = normalizeSourceSkillDraftInput({
      sourceText:
        "  Use ser for identity and long-term traits. Use estar for location and temporary states. Practice short classroom-style sentences with one clear verb choice.  ",
      sourceLabel: "  Spanish notes  ",
      focusNote: "  Focus on beginner examples.  ",
      collectionName: "  Spanish grammar  ",
      tags: "Spanish, grammar, spanish",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        sourceText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states. Practice short classroom-style sentences with one clear verb choice.",
        sourceLabel: "Spanish notes",
        focusNote: "Focus on beginner examples.",
        collectionName: "Spanish grammar",
        tags: ["spanish", "grammar"],
      },
    });
  });

  it("accepts a short manual skill description as learning input", () => {
    const result = normalizeSourceSkillDraftInput({
      sourceText: "  ser vs estar  ",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        sourceText: "ser vs estar",
        sourceLabel: null,
        focusNote: null,
        collectionName: null,
        tags: [],
      },
    });
  });

  it("rejects underspecified pasted source with stable field errors", () => {
    const result = normalizeSourceSkillDraftInput({
      sourceText: "too short",
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.sourceText).toEqual([
        "Enter at least 12 characters of learning material or a skill description.",
      ]);
    }
  });

  it("rejects oversized string tags before source-draft normalization", () => {
    const result = normalizeSourceSkillDraftInput({
      sourceText:
        "Use ser for identity and long-term traits. Use estar for location and temporary states.",
      tags: "x".repeat(41),
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.tags).toBeDefined();
    }
  });
});

describe("validateGeneratedSkillDrafts", () => {
  it("accepts one valid generated skill draft and normalizes tag casing", () => {
    const result = validateGeneratedSkillDrafts({
      drafts: [
        {
          title: "Ser vs. estar in short sentences",
          objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
          rules: ["Use ser for identity.", "Use estar for location."],
          examples: ["Soy estudiante.", "Estoy en casa."],
          exerciseConstraints: "Use short multiple-choice prompts with one clear answer.",
          tags: ["Spanish", "grammar", "spanish"],
        },
      ],
    });

    expect(result).toEqual({
      status: "ready",
      drafts: [
        {
          title: "Ser vs. estar in short sentences",
          objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
          rules: ["Use ser for identity.", "Use estar for location."],
          examples: ["Soy estudiante.", "Estoy en casa."],
          exerciseConstraints: "Use short multiple-choice prompts with one clear answer.",
          tags: ["spanish", "grammar"],
        },
      ],
    });
  });

  it("accepts three generated skill drafts", () => {
    const result = validateGeneratedSkillDrafts({
      drafts: [validGeneratedSkillDraft(1), validGeneratedSkillDraft(2), validGeneratedSkillDraft(3)],
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.drafts).toHaveLength(3);
      expect(result.drafts.map((draft) => draft.title)).toEqual([
        "Skill draft 1",
        "Skill draft 2",
        "Skill draft 3",
      ]);
    }
  });

  it.each([
    { label: "zero drafts", value: { drafts: [] } },
    {
      label: "too many drafts",
      value: {
        drafts: [
          validGeneratedSkillDraft(1),
          validGeneratedSkillDraft(2),
          validGeneratedSkillDraft(3),
          validGeneratedSkillDraft(4),
        ],
      },
    },
    {
      label: "unknown keys",
      value: {
        drafts: [
          {
            ...validGeneratedSkillDraft(1),
            typo: "reject unknown keys",
          },
        ],
      },
    },
    {
      label: "invalid tags",
      value: {
        drafts: [
          {
            ...validGeneratedSkillDraft(1),
            tags: ["spanish", ""],
          },
        ],
      },
    },
  ])("fails closed for $label in generated skill drafts", ({ value }) => {
    const result = validateGeneratedSkillDrafts(value);

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
      message: "Gemini returned invalid skill drafts.",
    });
  });
});

describe("buildSourceContextExcerpt", () => {
  it("caps source context and marks truncation", () => {
    const oversized = `A${"b".repeat(SOURCE_CONTEXT_CHAR_LIMIT + 200)}`;
    const result = buildSourceContextExcerpt([oversized]);

    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(SOURCE_CONTEXT_CHAR_LIMIT);
    expect(result?.endsWith("[truncated]")).toBe(true);
  });

  it("returns null when there is no usable source text", () => {
    expect(buildSourceContextExcerpt([null, "   "])).toBeNull();
  });
});

describe("buildExistingChoiceExerciseContext", () => {
  it("caps existing exercise context and marks truncation", () => {
    const result = buildExistingChoiceExerciseContext(
      Array.from({ length: DEFAULT_READY_EXERCISE_TARGET + 4 }, (_, index) => ({
        prompt: `Prompt ${index} ${"x".repeat(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT)}`,
        correctAnswerDisplay: `Answer ${index}`,
      })),
    );

    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT);
    expect(result?.endsWith("[truncated]")).toBe(true);
  });

  it("returns null when there are no existing choice exercises", () => {
    expect(buildExistingChoiceExerciseContext([])).toBeNull();
  });
});

describe("createSkillDraftFromSource", () => {
  it("returns a typed setup error before any database work when Gemini env is missing", async () => {
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    const originalGeminiModel = process.env.GEMINI_MODEL;

    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_MODEL;

      await expect(
        createSkillDraftFromSource({
          userId: "unit_missing_env",
          now: new Date("2026-06-04T16:00:00.000Z"),
          input: {
            sourceText:
              "Use ser for identity and long-term traits. Use estar for location and temporary states. Practice short classroom-style sentences.",
          },
        }),
      ).resolves.toMatchObject({
        status: "not-created",
        reason: "missing-gemini-env",
      });
    } finally {
      if (originalGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = originalGeminiApiKey;
      }

      if (originalGeminiModel === undefined) {
        delete process.env.GEMINI_MODEL;
      } else {
        process.env.GEMINI_MODEL = originalGeminiModel;
      }
    }
  });

  it("rejects invalid generated drafts before opening a transaction", async () => {
    await expect(
      createSkillDraftFromSource({
        userId: "unit_invalid_generation",
        now: new Date("2026-06-04T16:00:00.000Z"),
        model: "test-gemini",
        generateSkillDraft: async () => ({
          drafts: [
            {
              title: "Bad draft",
              objective: "too short",
              rules: [],
              examples: [],
              exerciseConstraints: "",
              tags: [],
            },
          ],
        }),
        input: {
          sourceText:
            "Use ser for identity and long-term traits. Use estar for location and temporary states. Practice short classroom-style sentences.",
        },
        skipUsageLimitCheck: true,
      }),
    ).resolves.toMatchObject({
      status: "not-created",
      reason: "invalid-generation",
    });
  });
});
