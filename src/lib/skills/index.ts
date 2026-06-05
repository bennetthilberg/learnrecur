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
  SourceFileKind,
  SourceFileStatus,
  type Skill,
} from "@/generated/prisma/client";
import { choicesSchema } from "@/lib/answer-checking";
import { formatEnvError, getGeminiEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";

export const MIN_ACTIVATION_EXERCISES = 3;
export const REQUESTED_ACTIVATION_EXERCISES = 5;
export const MAX_GENERATED_EXERCISES = 10;
export const SOURCE_CONTEXT_CHAR_LIMIT = 4_000;
export const SOURCE_SKILL_DRAFT_PROMPT_VERSION = "source-skill-draft-v0";
const GENERATION_TIMEOUT_MS = 45_000;
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

export type GeneratedChoiceExerciseCandidate = GeneratedChoiceExercise & {
  candidateId: string;
};

const choiceVerificationReasonValues = [
  "irrelevant",
  "ambiguous",
  "answer_mismatch",
  "source_mismatch",
  "weak_distractors",
  "unclear_prompt",
  "too_easy",
  "too_hard",
  "duplicate",
  "other",
] as const;

export type ChoiceExerciseVerificationReason =
  (typeof choiceVerificationReasonValues)[number];

export type ChoiceExerciseVerificationDecision = {
  candidateId: string;
  verdict: "verified" | "rejected";
  reason: ChoiceExerciseVerificationReason | null;
  note: string | null;
};

export type ChoiceExerciseVerificationResult =
  | {
      status: "ready";
      exercises: GeneratedChoiceExercise[];
      decisions: ChoiceExerciseVerificationDecision[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises";
      message: string;
      exercises: GeneratedChoiceExercise[];
      decisions: ChoiceExerciseVerificationDecision[];
      verifiedCount: number;
      rejectedCount: number;
    };

export type GeneratedSkillDraft = {
  title: string;
  objective: string;
  rules: string[];
  examples: string[];
  exerciseConstraints: string;
  tags: string[];
};

export type GeneratedSkillDraftValidationResult =
  | {
      status: "ready";
      draft: GeneratedSkillDraft;
    }
  | {
      status: "invalid";
      reason: "invalid-response";
      message: string;
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
  sourceContext: string | null;
  requestedCount: number;
};

export type ChoiceExerciseGenerator = (
  input: ChoiceExerciseGeneratorInput,
) => Promise<unknown>;

export type ChoiceExerciseVerifierInput = {
  skill: ChoiceExerciseGeneratorInput["skill"];
  sourceContext: string | null;
  candidates: GeneratedChoiceExerciseCandidate[];
};

export type ChoiceExerciseVerifier = (
  input: ChoiceExerciseVerifierInput,
) => Promise<unknown>;

export type NormalizedSourceSkillDraftInput = {
  sourceText: string;
  sourceLabel: string | null;
  focusNote: string | null;
  collectionName: string | null;
  tags: string[];
};

export type SourceSkillDraftInputResult =
  | {
      status: "ready";
      value: NormalizedSourceSkillDraftInput;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    };

export type SkillDraftGeneratorInput = NormalizedSourceSkillDraftInput & {
  sourceContext: string;
};

export type SkillDraftGenerator = (input: SkillDraftGeneratorInput) => Promise<unknown>;

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
  verifyChoiceExercises?: ChoiceExerciseVerifier;
  model?: string;
};

export type CreateSkillDraftFromSourceInput = {
  userId: string;
  input: unknown;
  now: Date;
  generateSkillDraft?: SkillDraftGenerator;
  model?: string;
};

export type SourceSkillDraftWriteResult =
  | {
      status: "created";
      skill: Skill;
      sourceFileId: string;
      skillSourceRefId: string;
    }
  | Extract<SourceSkillDraftInputResult, { status: "invalid" }>
  | {
      status: "not-created";
      reason: "generation-failed" | "invalid-generation" | "missing-gemini-env";
      message: string;
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
        | "verification-failed"
        | "invalid-verification"
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

const sourceSkillDraftInputSchema = z.strictObject({
  sourceText: z
    .string()
    .trim()
    .min(40, "Paste at least 40 characters of source material.")
    .max(12_000, "Paste at most 12,000 characters for this first source flow."),
  sourceLabel: optionalTrimmedStringSchema.pipe(z.string().max(160).optional()),
  focusNote: optionalTrimmedStringSchema.pipe(z.string().max(800).optional()),
  collectionName: optionalTrimmedStringSchema,
  tags: z.union([z.string(), z.array(z.string())]).optional(),
});

const generatedSkillDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(12).max(1200),
  rules: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  examples: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  exerciseConstraints: z.string().trim().min(1).max(1000),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
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
  exercises: z.array(z.unknown()).min(1).max(MAX_GENERATED_EXERCISES),
});

const choiceVerificationDecisionSchema = z
  .strictObject({
    candidateId: z.string().trim().min(1).max(80),
    verdict: z.enum(["verified", "rejected"]),
    reason: z.enum(choiceVerificationReasonValues).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((decision, context) => {
    if (decision.verdict === "rejected" && !decision.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Rejected candidates require a reason.",
      });
    }
  });

const choiceVerificationEnvelopeSchema = z.strictObject({
  verifications: z.array(choiceVerificationDecisionSchema).min(1).max(MAX_GENERATED_EXERCISES),
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

const geminiChoiceVerificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verifications"],
  properties: {
    verifications: {
      type: "array",
      minItems: MIN_ACTIVATION_EXERCISES,
      maxItems: REQUESTED_ACTIVATION_EXERCISES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "verdict"],
        properties: {
          candidateId: { type: "string" },
          verdict: {
            type: "string",
            enum: ["verified", "rejected"],
          },
          reason: {
            type: "string",
            enum: choiceVerificationReasonValues,
          },
          note: {
            type: "string",
            maxLength: 300,
          },
        },
      },
    },
  },
};

const geminiSkillDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "rules", "examples", "exerciseConstraints", "tags"],
  properties: {
    title: { type: "string" },
    objective: { type: "string" },
    rules: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    examples: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    exerciseConstraints: { type: "string" },
    tags: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
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

export function normalizeSourceSkillDraftInput(input: unknown): SourceSkillDraftInputResult {
  const result = sourceSkillDraftInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Source material needs a little more detail.",
      fieldErrors: z.flattenError(result.error).fieldErrors,
    };
  }

  const value = result.data;

  return {
    status: "ready",
    value: {
      sourceText: value.sourceText,
      sourceLabel: value.sourceLabel ?? null,
      focusNote: value.focusNote ?? null,
      collectionName: value.collectionName ?? null,
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

export async function createSkillDraftFromSource(
  input: CreateSkillDraftFromSourceInput,
): Promise<SourceSkillDraftWriteResult> {
  const normalized = normalizeSourceSkillDraftInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const setup = resolveSourceDraftSetup(input);

  if (setup.status === "missing-env") {
    return {
      status: "not-created",
      reason: "missing-gemini-env",
      message: setup.message,
    };
  }

  const sourceContext = buildSourceContextExcerpt([normalized.value.sourceText]) ?? normalized.value.sourceText;
  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateSkillDraft({
        ...normalized.value,
        sourceContext,
      }),
      GENERATION_TIMEOUT_MS,
      "generateSkillDraft timed out",
    );
  } catch (error) {
    return {
      status: "not-created",
      reason: "generation-failed",
      message: `Gemini skill draft generation failed: ${formatEnvError(error)}`,
    };
  }

  const validation = validateGeneratedSkillDraft(rawGeneration);

  if (validation.status === "invalid") {
    return {
      status: "not-created",
      reason: "invalid-generation",
      message: validation.message,
    };
  }

  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const collectionId = await resolveCollectionId(
      tx,
      input.userId,
      normalized.value.collectionName,
    );
    const skill = await tx.skill.create({
      data: {
        userId: input.userId,
        collectionId,
        title: validation.draft.title,
        objective: validation.draft.objective,
        rules: toNotesJson(validation.draft.rules),
        examples: toNotesJson(validation.draft.examples),
        exerciseConstraints: toConstraintsJson(validation.draft.exerciseConstraints),
        tags: normalizeTags([...normalized.value.tags, ...validation.draft.tags]),
        status: SkillStatus.DRAFT,
      },
    });
    const sourceFile = await tx.sourceFile.create({
      data: {
        userId: input.userId,
        collectionId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: normalized.value.sourceLabel ?? "Pasted source",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(normalized.value.sourceText, "utf8"),
        extractedText: normalized.value.sourceText,
        metadata: {
          createdBy: SOURCE_SKILL_DRAFT_PROMPT_VERSION,
          focusNote: normalized.value.focusNote,
          model: setup.model,
          generatedAt: input.now.toISOString(),
        },
      },
    });
    const sourceRef = await tx.skillSourceRef.create({
      data: {
        userId: input.userId,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
        note: normalized.value.focusNote,
      },
    });

    return {
      status: "created",
      skill,
      sourceFileId: sourceFile.id,
      skillSourceRefId: sourceRef.id,
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
      sourceRefs: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          sourceFile: {
            select: {
              extractedText: true,
            },
          },
        },
      },
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

  const sourceContext = buildSourceContextExcerpt(
    skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile.extractedText),
  );
  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateChoiceExercises({
        skill,
        sourceContext,
        requestedCount: REQUESTED_ACTIVATION_EXERCISES,
      }),
      GENERATION_TIMEOUT_MS,
      "generateChoiceExercises timed out",
    );
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

  const candidates = toGeneratedChoiceExerciseCandidates(validation.exercises);
  let rawVerification: unknown;

  try {
    rawVerification = await withTimeout(
      setup.verifyChoiceExercises({
        skill,
        sourceContext,
        candidates,
      }),
      GENERATION_TIMEOUT_MS,
      "verifyChoiceExercises timed out",
    );
  } catch (error) {
    const message = `Gemini exercise verification failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: validation.rejectedCount + validation.exercises.length,
      now: input.now,
    });

    return {
      status: "not-activated",
      reason: "verification-failed",
      message,
      generationJobId: generationJob.id,
    };
  }

  const verification = validateChoiceExerciseVerification({
    candidates,
    rawVerification,
  });

  if (verification.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: verification.message,
      acceptedCount: verification.verifiedCount,
      rejectedCount: validation.rejectedCount + verification.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-activated",
      reason: "invalid-verification",
      message: verification.message,
      generationJobId: generationJob.id,
    };
  }

  return prisma.$transaction(async (tx) => {
    const schedule = createInitialSkillSchedule(input.now);
    const skillUpdate = await tx.skill.updateMany({
      where: {
        id: skill.id,
        userId: input.userId,
        status: SkillStatus.DRAFT,
      },
      data: {
        ...schedule,
        status: SkillStatus.ACTIVE,
      },
    });

    if (skillUpdate.count !== 1) {
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
      data: verification.exercises.map((exercise) => ({
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

    await tx.generationJob.update({
      where: { id: generationJob.id },
      data: {
        status: GenerationJobStatus.SUCCEEDED,
        acceptedCount: verification.exercises.length,
        rejectedCount: validation.rejectedCount + verification.rejectedCount,
        completedAt: input.now,
      },
    });

    return {
      status: "activated",
      skillId: skill.id,
      generationJobId: generationJob.id,
      exerciseCount: verification.exercises.length,
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

export function toGeneratedChoiceExerciseCandidates(
  exercises: GeneratedChoiceExercise[],
): GeneratedChoiceExerciseCandidate[] {
  return exercises.map((exercise, index) => ({
    ...exercise,
    candidateId: `candidate-${index + 1}`,
  }));
}

export function validateChoiceExerciseVerification(input: {
  candidates: GeneratedChoiceExerciseCandidate[];
  rawVerification: unknown;
}): ChoiceExerciseVerificationResult {
  const envelopeResult = choiceVerificationEnvelopeSchema.safeParse(input.rawVerification);

  if (!envelopeResult.success) {
    return invalidChoiceExerciseVerification(
      "invalid-response",
      [],
      [],
      input.candidates.length,
      "Gemini returned an invalid verification shape.",
    );
  }

  const expectedCandidateIds = new Set(input.candidates.map((candidate) => candidate.candidateId));
  const seenCandidateIds = new Set<string>();
  const decisions: ChoiceExerciseVerificationDecision[] = [];

  for (const verification of envelopeResult.data.verifications) {
    if (!expectedCandidateIds.has(verification.candidateId)) {
      return invalidChoiceExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini verification referenced an unknown exercise candidate.",
      );
    }

    if (seenCandidateIds.has(verification.candidateId)) {
      return invalidChoiceExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini verification returned a duplicate exercise decision.",
      );
    }

    seenCandidateIds.add(verification.candidateId);
    decisions.push({
      candidateId: verification.candidateId,
      verdict: verification.verdict,
      reason: verification.verdict === "rejected" ? verification.reason ?? "other" : null,
      note: verification.verdict === "rejected" ? verification.note?.trim() || null : null,
    });
  }

  if (seenCandidateIds.size !== expectedCandidateIds.size) {
    return invalidChoiceExerciseVerification(
      "candidate-mismatch",
      [],
      decisions,
      input.candidates.length,
      "Gemini verification did not decide every exercise candidate.",
    );
  }

  const decisionsByCandidateId = new Map(
    decisions.map((decision) => [decision.candidateId, decision]),
  );
  const verifiedExercises = input.candidates
    .filter((candidate) => decisionsByCandidateId.get(candidate.candidateId)?.verdict === "verified")
    .map(stripGeneratedChoiceExerciseCandidate);
  const rejectedCount = input.candidates.length - verifiedExercises.length;

  if (verifiedExercises.length < MIN_ACTIVATION_EXERCISES) {
    return invalidChoiceExerciseVerification(
      "too-few-verified-exercises",
      verifiedExercises,
      decisions,
      rejectedCount,
      `Gemini verified ${verifiedExercises.length} exercises; at least ${MIN_ACTIVATION_EXERCISES} are required.`,
    );
  }

  return {
    status: "ready",
    exercises: verifiedExercises,
    decisions,
    rejectedCount,
  };
}

export function validateGeneratedSkillDraft(
  input: unknown,
): GeneratedSkillDraftValidationResult {
  const result = generatedSkillDraftSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      reason: "invalid-response",
      message: "Gemini returned an invalid skill draft.",
    };
  }

  const draft = result.data;

  return {
    status: "ready",
    draft: {
      title: draft.title,
      objective: draft.objective,
      rules: draft.rules,
      examples: draft.examples,
      exerciseConstraints: draft.exerciseConstraints,
      tags: normalizeTags(draft.tags),
    },
  };
}

function resolveActivationSetup(
  input: ActivateSkillDraftInput,
):
  | {
      status: "ready";
      model: string;
      generateChoiceExercises: ChoiceExerciseGenerator;
      verifyChoiceExercises: ChoiceExerciseVerifier;
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
      verifyChoiceExercises: input.verifyChoiceExercises ?? createTrustingChoiceExerciseVerifier(),
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
      verifyChoiceExercises:
        input.verifyChoiceExercises ??
        createGeminiChoiceExerciseVerifier({
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

function resolveSourceDraftSetup(
  input: CreateSkillDraftFromSourceInput,
):
  | {
      status: "ready";
      model: string;
      generateSkillDraft: SkillDraftGenerator;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    } {
  if (input.generateSkillDraft) {
    return {
      status: "ready",
      model: input.model ?? "test-generator",
      generateSkillDraft: input.generateSkillDraft,
    };
  }

  try {
    const env = getGeminiEnv();

    return {
      status: "ready",
      model: env.GEMINI_MODEL,
      generateSkillDraft: createGeminiSkillDraftGenerator({
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

function createGeminiSkillDraftGenerator({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): SkillDraftGenerator {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildSourceSkillDraftPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiSkillDraftJsonSchema,
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
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

function createGeminiChoiceExerciseVerifier({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): ChoiceExerciseVerifier {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildChoiceExerciseVerificationPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiChoiceVerificationJsonSchema,
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function createTrustingChoiceExerciseVerifier(): ChoiceExerciseVerifier {
  return async (input) => ({
    verifications: input.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      verdict: "verified",
    })),
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildChoiceExercisePrompt(input: ChoiceExerciseGeneratorInput): string {
  const prompt = [
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
  ];

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this to match the source style and scope, but do not quote long passages.",
      input.sourceContext,
    );
  }

  prompt.push(
    "",
    "Use stable lowercase choice IDs such as a, b, c, d.",
    "Keep choices short, parallel, and plausible.",
  );

  return prompt.join("\n");
}

function buildChoiceExerciseVerificationPrompt(input: ChoiceExerciseVerifierInput): string {
  const candidates = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    prompt: candidate.prompt,
    choices: candidate.choices,
    correctChoiceId: candidate.answerSpec.correctChoiceId,
    explanation: candidate.explanation,
    difficulty: candidate.difficulty,
    expectedSeconds: candidate.expectedSeconds,
  }));

  const prompt = [
    "Verify generated LearnRecur multiple-choice exercise candidates.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, rewritten exercises, or answer keys outside the JSON.",
    "Be conservative: reject any candidate you are not confident is clear, fair, source-aligned, and objectively answerable.",
    "Return exactly one verification decision for every candidateId, and never invent candidate IDs.",
    "Use verdict verified only when the stated correct choice is unambiguously best.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
  ];

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this as the scope boundary for source-backed exercises.",
      input.sourceContext,
    );
  }

  prompt.push(
    "",
    "Reject reasons must use one of: irrelevant, ambiguous, answer_mismatch, source_mismatch, weak_distractors, unclear_prompt, too_easy, too_hard, duplicate, other.",
    "Candidates:",
    JSON.stringify(candidates, null, 2),
  );

  return prompt.join("\n");
}

function buildSourceSkillDraftPrompt(input: SkillDraftGeneratorInput): string {
  return [
    "Create one editable LearnRecur skill draft from pasted learning material.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, exercises, or answer keys.",
    "The skill must be narrow enough to practice with short objective exercises.",
    "If the source is broad, choose the most coherent single skill, especially if the focus note points to one.",
    "",
    `Source label: ${input.sourceLabel ?? "Pasted source"}`,
    `Focus note: ${input.focusNote ?? "No extra focus note."}`,
    `Collection hint: ${input.collectionName ?? "none"}`,
    `User tags: ${input.tags.join(", ") || "none"}`,
    "",
    "Pasted source:",
    input.sourceContext,
    "",
    "Draft requirements:",
    "- title: short and specific.",
    "- objective: one sentence describing exactly what the learner should practice.",
    "- rules: concise source-backed rules or reminders.",
    "- examples: source-style examples, not exercise questions.",
    "- exerciseConstraints: guidance for future multiple-choice exercise generation.",
    "- tags: lowercase topic tags when possible.",
  ].join("\n");
}

export function buildSourceContextExcerpt(sourceTexts: Array<string | null | undefined>): string | null {
  const joined = sourceTexts
    .map((sourceText) => (sourceText ?? "").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (!joined) {
    return null;
  }

  if (joined.length <= SOURCE_CONTEXT_CHAR_LIMIT) {
    return joined;
  }

  const marker = "\n\n[truncated]";
  return `${joined.slice(0, SOURCE_CONTEXT_CHAR_LIMIT - marker.length).trimEnd()}${marker}`;
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

function invalidChoiceExerciseVerification(
  reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises",
  exercises: GeneratedChoiceExercise[],
  decisions: ChoiceExerciseVerificationDecision[],
  rejectedCount: number,
  message: string,
): Extract<ChoiceExerciseVerificationResult, { status: "invalid" }> {
  return {
    status: "invalid",
    reason,
    message,
    exercises,
    decisions,
    verifiedCount: exercises.length,
    rejectedCount,
  };
}

function stripGeneratedChoiceExerciseCandidate(
  candidate: GeneratedChoiceExerciseCandidate,
): GeneratedChoiceExercise {
  return {
    prompt: candidate.prompt,
    choices: candidate.choices,
    answerSpec: candidate.answerSpec,
    correctAnswerDisplay: candidate.correctAnswerDisplay,
    explanation: candidate.explanation,
    difficulty: candidate.difficulty,
    expectedSeconds: candidate.expectedSeconds,
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
