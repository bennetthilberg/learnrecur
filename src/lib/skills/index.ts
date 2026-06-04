import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import {
  AnswerKind,
  ExerciseType,
  ExerciseVerificationStatus,
  GenerationJobKind,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
  type Skill,
} from "@/generated/prisma/client";
import { choicesSchema } from "@/lib/answer-checking";
import { formatEnvError, getGeminiEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";

export const MIN_ACTIVATION_EXERCISES = 3;
export const REQUESTED_ACTIVATION_EXERCISES = 5;
export const SKILL_MCQ_PROMPT_VERSION = "skill-mcq-v0";
export const GEMINI_PROVIDER = "google";

export type NormalizedSkillDraftInput = {
  title: string;
  objective: string;
  collectionName: string | null;
  rules: string[];
  examples: string[];
  exerciseConstraints: string | null;
  tags: string[];
};

export type SkillDraftInputResult =
  | {
      status: "ready";
      value: NormalizedSkillDraftInput;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    };

export type GeneratedChoiceExercise = {
  prompt: string;
  choices: Array<{
    id: string;
    label: string;
  }>;
  answerSpec: {
    kind: "choice";
    correctChoiceId: string;
  };
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

export type GeneratedChoiceExerciseValidationResult =
  | {
      status: "ready";
      exercises: GeneratedChoiceExercise[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "too-few-valid-exercises";
      message: string;
      exercises: GeneratedChoiceExercise[];
      validCount: number;
      rejectedCount: number;
    };

export type ChoiceExerciseGeneratorInput = {
  skill: {
    id: string;
    title: string;
    objective: string | null;
    rules: Prisma.JsonValue | null;
    examples: Prisma.JsonValue | null;
    exerciseConstraints: Prisma.JsonValue | null;
    tags: string[];
  };
  requestedCount: number;
};

export type ChoiceExerciseGenerator = (
  input: ChoiceExerciseGeneratorInput,
) => Promise<unknown>;

export type SkillDraftWriteResult =
  | {
      status: "created" | "updated";
      skill: Skill;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type CreateSkillDraftInput = {
  userId: string;
  input: unknown;
};

export type UpdateSkillDraftInput = CreateSkillDraftInput & {
  skillId: string;
};

export type ActivateSkillDraftInput = {
  userId: string;
  skillId: string;
  now: Date;
  generateChoiceExercises?: ChoiceExerciseGenerator;
  model?: string;
};

export type SkillActivationResult =
  | {
      status: "activated";
      skillId: string;
      generationJobId: string;
      exerciseCount: number;
    }
  | {
      status: "not-activated";
      reason:
        | "generation-failed"
        | "invalid-generation"
        | "missing-gemini-env"
        | "skill-not-draft";
      message: string;
      generationJobId?: string;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}, z.string().trim().optional());

const draftInputSchema = z.strictObject({
  title: z.string().trim().min(1, "Skill title is required.").max(120),
  objective: z
    .string()
    .trim()
    .min(12, "Describe the skill objective in at least 12 characters.")
    .max(1200),
  collectionName: optionalTrimmedStringSchema,
  rules: optionalTrimmedStringSchema,
  examples: optionalTrimmedStringSchema,
  exerciseConstraints: optionalTrimmedStringSchema,
  tags: z.union([z.string(), z.array(z.string())]).optional(),
});

const generatedChoiceExerciseSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1200),
  choices: choicesSchema.min(2).max(6),
  correctChoiceId: z.string().trim().min(1),
  explanation: z.string().trim().min(1).max(1200).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  expectedSeconds: z.number().int().min(5).max(180).optional(),
});

const generatedChoiceEnvelopeSchema = z.strictObject({
  exercises: z.array(z.unknown()).min(1),
});

const geminiResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["exercises"],
  properties: {
    exercises: {
      type: "array",
      minItems: MIN_ACTIVATION_EXERCISES,
      maxItems: REQUESTED_ACTIVATION_EXERCISES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "choices", "correctChoiceId", "explanation"],
        properties: {
          prompt: { type: "string" },
          choices: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
              },
            },
          },
          correctChoiceId: { type: "string" },
          explanation: { type: "string" },
          difficulty: { type: "integer", minimum: 1, maximum: 5 },
          expectedSeconds: { type: "integer", minimum: 5, maximum: 180 },
        },
      },
    },
  },
};

export function normalizeSkillDraftInput(input: unknown): SkillDraftInputResult {
  const result = draftInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Skill draft needs a little more detail.",
      fieldErrors: z.flattenError(result.error).fieldErrors,
    };
  }

  const value = result.data;

  return {
    status: "ready",
    value: {
      title: value.title,
      objective: value.objective,
      collectionName: value.collectionName ?? null,
      rules: splitNotes(value.rules),
      examples: splitNotes(value.examples),
      exerciseConstraints: value.exerciseConstraints ?? null,
      tags: normalizeTags(value.tags),
    },
  };
}

export async function createSkillDraft(input: CreateSkillDraftInput): Promise<SkillDraftWriteResult> {
  const normalized = normalizeSkillDraftInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const collectionId = await resolveCollectionId(tx, input.userId, normalized.value.collectionName);

    const skill = await tx.skill.create({
      data: {
        userId: input.userId,
        collectionId,
        title: normalized.value.title,
        objective: normalized.value.objective,
        rules: toNotesJson(normalized.value.rules),
        examples: toNotesJson(normalized.value.examples),
        exerciseConstraints: toConstraintsJson(normalized.value.exerciseConstraints),
        tags: normalized.value.tags,
        status: SkillStatus.DRAFT,
      },
    });

    return {
      status: "created",
      skill,
    };
  });
}

export async function updateSkillDraft(input: UpdateSkillDraftInput): Promise<SkillDraftWriteResult> {
  const normalized = normalizeSkillDraftInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const existingSkill = await tx.skill.findFirst({
      where: {
        id: input.skillId,
        userId: input.userId,
        status: SkillStatus.DRAFT,
      },
      select: {
        id: true,
      },
    });

    if (!existingSkill) {
      return skillNotFound();
    }

    const collectionId = await resolveCollectionId(tx, input.userId, normalized.value.collectionName);

    const skill = await tx.skill.update({
      where: { id: existingSkill.id },
      data: {
        collectionId,
        title: normalized.value.title,
        objective: normalized.value.objective,
        rules: toNotesJson(normalized.value.rules),
        examples: toNotesJson(normalized.value.examples),
        exerciseConstraints: toConstraintsJson(normalized.value.exerciseConstraints),
        tags: normalized.value.tags,
      },
    });

    return {
      status: "updated",
      skill,
    };
  });
}

export async function activateSkillDraft(
  input: ActivateSkillDraftInput,
): Promise<SkillActivationResult> {
  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      userId: true,
      title: true,
      objective: true,
      rules: true,
      examples: true,
      exerciseConstraints: true,
      tags: true,
      status: true,
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.DRAFT) {
    return {
      status: "not-activated",
      reason: "skill-not-draft",
      message: "Only draft skills can be activated.",
    };
  }

  const setup = resolveActivationSetup(input);
  const generationJob = await prisma.generationJob.create({
    data: {
      userId: input.userId,
      skillId: skill.id,
      kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
      status: setup.status === "ready" ? GenerationJobStatus.RUNNING : GenerationJobStatus.FAILED,
      provider: GEMINI_PROVIDER,
      model: setup.model,
      promptVersion: SKILL_MCQ_PROMPT_VERSION,
      requestedCount: REQUESTED_ACTIVATION_EXERCISES,
      errorMessage: setup.status === "ready" ? null : setup.message,
      startedAt: input.now,
      completedAt: setup.status === "ready" ? null : input.now,
    },
  });

  if (setup.status === "missing-env") {
    return {
      status: "not-activated",
      reason: "missing-gemini-env",
      message: setup.message,
      generationJobId: generationJob.id,
    };
  }

  let rawGeneration: unknown;

  try {
    rawGeneration = await setup.generateChoiceExercises({
      skill,
      requestedCount: REQUESTED_ACTIVATION_EXERCISES,
    });
  } catch (error) {
    const message = `Gemini exercise generation failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-activated",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
    };
  }

  const validation = validateGeneratedChoiceExercises(rawGeneration);

  if (validation.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: validation.message,
      acceptedCount: validation.validCount,
      rejectedCount: validation.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-activated",
      reason: "invalid-generation",
      message: validation.message,
      generationJobId: generationJob.id,
    };
  }

  return prisma.$transaction(async (tx) => {
    const draft = await tx.skill.findFirst({
      where: {
        id: skill.id,
        userId: input.userId,
        status: SkillStatus.DRAFT,
      },
      select: { id: true },
    });

    if (!draft) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill is no longer a draft.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-activated",
        reason: "skill-not-draft",
        message: "Skill is no longer a draft.",
        generationJobId: generationJob.id,
      };
    }

    await tx.exercise.createMany({
      data: validation.exercises.map((exercise) => ({
        userId: input.userId,
        skillId: skill.id,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: exercise.prompt,
        choices: exercise.choices,
        answerSpec: exercise.answerSpec,
        correctAnswerDisplay: exercise.correctAnswerDisplay,
        explanation: exercise.explanation,
        difficulty: exercise.difficulty,
        expectedSeconds: exercise.expectedSeconds,
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      })),
    });

    await tx.skill.update({
      where: { id: skill.id },
      data: {
        ...createInitialSkillSchedule(input.now),
        status: SkillStatus.ACTIVE,
      },
    });

    await tx.generationJob.update({
      where: { id: generationJob.id },
      data: {
        status: GenerationJobStatus.SUCCEEDED,
        acceptedCount: validation.exercises.length,
        rejectedCount: validation.rejectedCount,
        completedAt: input.now,
      },
    });

    return {
      status: "activated",
      skillId: skill.id,
      generationJobId: generationJob.id,
      exerciseCount: validation.exercises.length,
    };
  });
}

export function validateGeneratedChoiceExercises(
  input: unknown,
): GeneratedChoiceExerciseValidationResult {
  const envelopeResult = generatedChoiceEnvelopeSchema.safeParse(input);

  if (!envelopeResult.success) {
    return invalidGeneratedExercises("invalid-response", [], 0, "Gemini returned an invalid shape.");
  }

  const exercises: GeneratedChoiceExercise[] = [];
  let rejectedCount = 0;

  for (const candidate of envelopeResult.data.exercises) {
    const parsed = parseGeneratedChoiceExercise(candidate);

    if (parsed) {
      exercises.push(parsed);
    } else {
      rejectedCount += 1;
    }
  }

  if (exercises.length < MIN_ACTIVATION_EXERCISES) {
    return invalidGeneratedExercises(
      "too-few-valid-exercises",
      exercises,
      rejectedCount,
      `Gemini returned ${exercises.length} valid exercises; at least ${MIN_ACTIVATION_EXERCISES} are required.`,
    );
  }

  return {
    status: "ready",
    exercises,
    rejectedCount,
  };
}

function resolveActivationSetup(
  input: ActivateSkillDraftInput,
):
  | {
      status: "ready";
      model: string;
      generateChoiceExercises: ChoiceExerciseGenerator;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    } {
  if (input.generateChoiceExercises) {
    return {
      status: "ready",
      model: input.model ?? "test-generator",
      generateChoiceExercises: input.generateChoiceExercises,
    };
  }

  try {
    const env = getGeminiEnv();

    return {
      status: "ready",
      model: env.GEMINI_MODEL,
      generateChoiceExercises: createGeminiChoiceExerciseGenerator({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
      }),
    };
  } catch (error) {
    return {
      status: "missing-env",
      model: input.model ?? (process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
      message: formatEnvError(error),
    };
  }
}

function createGeminiChoiceExerciseGenerator({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): ChoiceExerciseGenerator {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildChoiceExercisePrompt(input),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiResponseJsonSchema,
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function buildChoiceExercisePrompt(input: ChoiceExerciseGeneratorInput): string {
  return [
    "Generate starter multiple-choice practice exercises for LearnRecur.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, or answer keys outside the JSON.",
    `Create exactly ${input.requestedCount} exercises.`,
    "Each exercise must test the skill directly, have one unambiguous correct choice, and avoid trick wording.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
    "",
    "Use stable lowercase choice IDs such as a, b, c, d.",
    "Keep choices short, parallel, and plausible.",
  ].join("\n");
}

async function resolveCollectionId(
  tx: SkillWriteClient,
  userId: string,
  collectionName: string | null,
): Promise<string | null> {
  if (!collectionName) {
    return null;
  }

  const existingCollection = await tx.collection.findFirst({
    where: {
      userId,
      name: collectionName,
    },
    select: { id: true },
  });

  if (existingCollection) {
    return existingCollection.id;
  }

  const collection = await tx.collection.create({
    data: {
      userId,
      name: collectionName,
    },
    select: { id: true },
  });

  return collection.id;
}

async function markGenerationJobFailed(
  prisma: Pick<Prisma.TransactionClient, "generationJob">,
  generationJobId: string,
  input: {
    message: string;
    acceptedCount: number;
    rejectedCount: number;
    now: Date;
  },
) {
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      status: GenerationJobStatus.FAILED,
      acceptedCount: input.acceptedCount,
      rejectedCount: input.rejectedCount,
      errorMessage: input.message,
      completedAt: input.now,
    },
  });
}

function parseGeneratedChoiceExercise(candidate: unknown): GeneratedChoiceExercise | null {
  const result = generatedChoiceExerciseSchema.safeParse(candidate);

  if (!result.success) {
    return null;
  }

  const exercise = result.data;
  const choiceIds = new Set<string>();

  const normalizedChoices = exercise.choices.map((choice) => ({
    id: choice.id,
    label: choice.label.trim(),
  }));

  for (const choice of normalizedChoices) {
    if (choice.label.length === 0) {
      return null;
    }

    if (choiceIds.has(choice.id)) {
      return null;
    }

    choiceIds.add(choice.id);
  }

  if (!choiceIds.has(exercise.correctChoiceId)) {
    return null;
  }

  const correctChoice = normalizedChoices.find((choice) => choice.id === exercise.correctChoiceId);

  if (!correctChoice) {
    return null;
  }

  return {
    prompt: exercise.prompt,
    choices: normalizedChoices,
    answerSpec: {
      kind: "choice",
      correctChoiceId: exercise.correctChoiceId,
    },
    correctAnswerDisplay: correctChoice.label,
    explanation: exercise.explanation ?? null,
    difficulty: exercise.difficulty ?? null,
    expectedSeconds: exercise.expectedSeconds ?? null,
  };
}

function invalidGeneratedExercises(
  reason: "invalid-response" | "too-few-valid-exercises",
  exercises: GeneratedChoiceExercise[],
  rejectedCount: number,
  message: string,
): Extract<GeneratedChoiceExerciseValidationResult, { status: "invalid" }> {
  return {
    status: "invalid",
    reason,
    message,
    exercises,
    validCount: exercises.length,
    rejectedCount,
  };
}

function toNotesJson(notes: string[]): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (notes.length === 0) {
    return Prisma.JsonNull;
  }

  return {
    items: notes,
  };
}

function toConstraintsJson(
  constraints: string | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!constraints) {
    return Prisma.JsonNull;
  }

  return {
    notes: constraints,
    answerKind: "choice",
    requestedCount: REQUESTED_ACTIVATION_EXERCISES,
  };
}

function summarizeJsonNotes(value: Prisma.JsonValue | null): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "none";
  }

  if ("items" in value && Array.isArray(value.items)) {
    return value.items.filter((item) => typeof item === "string").join("; ") || "none";
  }

  if ("notes" in value && typeof value.notes === "string") {
    return value.notes;
  }

  return "none";
}

function skillNotFound(): Extract<SkillDraftWriteResult, { status: "not-found" }> &
  Extract<SkillActivationResult, { status: "not-found" }> {
  return {
    status: "not-found",
    reason: "skill-not-found",
    message: "No draft skill was found for this user.",
  };
}

function splitNotes(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeTags(value?: string | string[]): string[] {
  const rawTags = Array.isArray(value) ? value : value?.split(/[,\n]+/) ?? [];
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const rawTag of rawTags) {
    const tag = rawTag.trim().toLowerCase();

    if (tag.length === 0 || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    tags.push(tag);
  }

  return tags.slice(0, 12);
}

type SkillWriteClient = Pick<Prisma.TransactionClient, "collection" | "skill">;
