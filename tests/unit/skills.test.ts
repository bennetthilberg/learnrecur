import { describe, expect, it } from "vitest";

import {
  SOURCE_CONTEXT_CHAR_LIMIT,
  MAX_GENERATED_EXERCISES,
  MIN_ACTIVATION_EXERCISES,
  buildSourceContextExcerpt,
  normalizeSourceSkillDraftInput,
  normalizeSkillDraftInput,
  validateGeneratedSkillDraft,
  validateGeneratedChoiceExercises,
  createSkillDraftFromSource,
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

  it("rejects underspecified pasted source with stable field errors", () => {
    const result = normalizeSourceSkillDraftInput({
      sourceText: "too short",
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.sourceText).toEqual([
        "Paste at least 40 characters of source material.",
      ]);
    }
  });
});

describe("validateGeneratedSkillDraft", () => {
  it("accepts a valid generated skill draft and normalizes tag casing", () => {
    const result = validateGeneratedSkillDraft({
      title: "Ser vs. estar in short sentences",
      objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
      rules: ["Use ser for identity.", "Use estar for location."],
      examples: ["Soy estudiante.", "Estoy en casa."],
      exerciseConstraints: "Use short multiple-choice prompts with one clear answer.",
      tags: ["Spanish", "grammar", "spanish"],
    });

    expect(result).toEqual({
      status: "ready",
      draft: {
        title: "Ser vs. estar in short sentences",
        objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
        rules: ["Use ser for identity.", "Use estar for location."],
        examples: ["Soy estudiante.", "Estoy en casa."],
        exerciseConstraints: "Use short multiple-choice prompts with one clear answer.",
        tags: ["spanish", "grammar"],
      },
    });
  });

  it("fails closed for malformed generated skill drafts", () => {
    const result = validateGeneratedSkillDraft({
      title: "Ser",
      objective: "too short",
      rules: [],
      examples: [],
      exerciseConstraints: "",
      tags: ["spanish"],
      typo: "reject unknown keys",
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
      message: "Gemini returned an invalid skill draft.",
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
          title: "Bad draft",
          objective: "too short",
          rules: [],
          examples: [],
          exerciseConstraints: "",
          tags: [],
        }),
        input: {
          sourceText:
            "Use ser for identity and long-term traits. Use estar for location and temporary states. Practice short classroom-style sentences.",
        },
      }),
    ).resolves.toMatchObject({
      status: "not-created",
      reason: "invalid-generation",
    });
  });
});
