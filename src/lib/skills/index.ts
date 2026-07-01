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
import {
  answerSpecSchema,
  checkAnswer,
  choicesSchema,
  isUsableMathAnswerSpec,
  mathAnswerSpecSchema,
  type MathAnswerSpec,
  type NumericAnswerSpec,
  type TextAnswerSpec,
} from "@/lib/answer-checking";
import { formatEnvError, getGeminiEnv } from "@/lib/env";
import {
  getGeminiErrorLogDetails,
  getPublicGeminiFailureMessage,
  runWithGeminiProviderFallback,
} from "@/lib/gemini";
import { getPrisma } from "@/lib/prisma";
import {
  buildQwenImageDataUrl,
  runQwenJsonChatCompletion,
  type QwenChatMessage,
  type QwenFallbackConfig,
} from "@/lib/qwen";
import { resolveOptionalQwenFallbackConfig } from "@/lib/qwen-fallback";
import { createInitialSkillSchedule } from "@/lib/scheduling";
import {
  MAX_SOURCE_UPLOAD_BYTES,
  isSourceUploadMimeType,
  type SourceUploadMimeType,
} from "@/lib/skills/source-upload-policy";
import {
  resolveS3SourceObjectStorage,
  type SourceObjectStorage,
} from "@/lib/storage/s3";
import {
  checkPastedSourceDraftUsageLimit,
  checkSkillActivationUsageLimit,
} from "@/lib/usage-limits";

export const MIN_ACTIVATION_EXERCISES = 3;
export const REQUESTED_ACTIVATION_EXERCISES = 5;
export const MAX_GENERATED_EXERCISES = 10;
export const DEFAULT_READY_EXERCISE_TARGET = 5;
export const DEFAULT_READY_EXACT_INPUT_TARGET = 2;
export const DEFAULT_READY_MATH_TARGET = 2;
export const EXACT_INPUT_UNLOCK_REPETITIONS = 3;
export const SOURCE_CONTEXT_CHAR_LIMIT = 4_000;
export const EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT = 3_000;
const MAX_TOTAL_SOURCE_MEDIA_BYTES = 12 * 1024 * 1024;
export const MAX_GENERATED_SKILL_DRAFTS = 1;
export const MAX_COLLECTION_NAME_LENGTH = 120;
const MAX_DRAFT_NOTE_LINE_LENGTH = 500;
const MAX_DRAFT_NOTE_ITEMS = 8;
const MAX_DRAFT_NOTE_LENGTH =
  MAX_DRAFT_NOTE_ITEMS * MAX_DRAFT_NOTE_LINE_LENGTH + (MAX_DRAFT_NOTE_ITEMS - 1);
const MAX_EXERCISE_CONSTRAINTS_LENGTH = 1_000;
export const MAX_TAG_LENGTH = 40;
const MAX_TAGS = 12;
export const MAX_TAGS_FIELD_LENGTH = MAX_TAGS * MAX_TAG_LENGTH + (MAX_TAGS - 1) * 2;
const MAX_TAG_INPUT_LENGTH = MAX_TAGS_FIELD_LENGTH;
const PROMPT_NOTE_CHAR_LIMIT = 2_000;
export const SOURCE_SKILL_DRAFT_PROMPT_VERSION = "source-skill-draft-v1";
const GENERATION_TIMEOUT_MS = 45_000;
const ACTIVATION_GENERATION_COMPLETION_SLACK_MS = 15_000;
const ACTIVATION_GENERATION_TIMEOUT_MS =
  GENERATION_TIMEOUT_MS * 2 + ACTIVATION_GENERATION_COMPLETION_SLACK_MS;
const ACTIVE_GENERATION_JOB_STATUSES: GenerationJobStatus[] = [
  GenerationJobStatus.PENDING,
  GenerationJobStatus.RUNNING,
];
export const SKILL_MCQ_PROMPT_VERSION = "skill-mcq-v0";
export const SKILL_EXACT_INPUT_PROMPT_VERSION = "skill-exact-input-v0";
export const SKILL_MATH_PROMPT_VERSION = "skill-math-v0";
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

export type NormalizedSkillPracticeGuidanceInput = {
  rules: string[];
  examples: string[];
  exerciseConstraints: string | null;
};

export type SkillPracticeGuidanceInputResult =
  | {
      status: "ready";
      value: NormalizedSkillPracticeGuidanceInput;
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

export type GeneratedExactInputExercise = {
  prompt: string;
  answerKind: typeof AnswerKind.TEXT | typeof AnswerKind.NUMERIC;
  answerSpec: TextAnswerSpec | NumericAnswerSpec;
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

export type GeneratedExactInputExerciseCandidate = GeneratedExactInputExercise & {
  candidateId: string;
};

export type GeneratedMathExercise = {
  prompt: string;
  answerKind: typeof AnswerKind.MATH;
  answerSpec: MathAnswerSpec;
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

export type GeneratedMathExerciseCandidate = GeneratedMathExercise & {
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

export type ExactInputExerciseVerificationDecision = ChoiceExerciseVerificationDecision;

export type ExactInputExerciseVerificationResult =
  | {
      status: "ready";
      exercises: GeneratedExactInputExercise[];
      decisions: ExactInputExerciseVerificationDecision[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises";
      message: string;
      exercises: GeneratedExactInputExercise[];
      decisions: ExactInputExerciseVerificationDecision[];
      verifiedCount: number;
      rejectedCount: number;
    };

export type MathExerciseVerificationDecision = ChoiceExerciseVerificationDecision;

export type MathExerciseVerificationResult =
  | {
      status: "ready";
      exercises: GeneratedMathExercise[];
      decisions: MathExerciseVerificationDecision[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises";
      message: string;
      exercises: GeneratedMathExercise[];
      decisions: MathExerciseVerificationDecision[];
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
      drafts: GeneratedSkillDraft[];
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

export type GeneratedChoiceExerciseValidationOptions = {
  minValidExercises?: number;
  maxGeneratedExercises?: number;
};

export type GeneratedExactInputExerciseValidationResult =
  | {
      status: "ready";
      exercises: GeneratedExactInputExercise[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "too-few-valid-exercises";
      message: string;
      exercises: GeneratedExactInputExercise[];
      validCount: number;
      rejectedCount: number;
    };

export type GeneratedExactInputExerciseValidationOptions = {
  minValidExercises?: number;
  maxGeneratedExercises?: number;
};

export type GeneratedMathExerciseValidationResult =
  | {
      status: "ready";
      exercises: GeneratedMathExercise[];
      rejectedCount: number;
    }
  | {
      status: "invalid";
      reason: "invalid-response" | "too-few-valid-exercises";
      message: string;
      exercises: GeneratedMathExercise[];
      validCount: number;
      rejectedCount: number;
    };

export type GeneratedMathExerciseValidationOptions = {
  minValidExercises?: number;
  maxGeneratedExercises?: number;
};

export type ChoiceExerciseVerificationOptions = {
  minVerifiedExercises?: number;
};

export type ExactInputExerciseVerificationOptions = {
  minVerifiedExercises?: number;
};

export type MathExerciseVerificationOptions = {
  minVerifiedExercises?: number;
};

export type SourceMediaContext = {
  sourceFileId: string | null;
  label: string;
  mimeType: SourceUploadMimeType;
  bytes: Buffer;
};

export type SourceMediaContextSourceFile = {
  id: string;
  kind: SourceFileKind;
  status: SourceFileStatus;
  originalName: string;
  mimeType: string | null;
  storageBucket: string | null;
  storageKey: string | null;
};

export type SourceMediaContextLoader = (input: {
  sourceFiles: SourceMediaContextSourceFile[];
}) => Promise<SourceMediaContext[]>;

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
  sourceMedia?: SourceMediaContext[];
  existingExerciseContext?: string | null;
  requestedCount: number;
};

export type ChoiceExerciseGenerator = (
  input: ChoiceExerciseGeneratorInput,
) => Promise<unknown>;

export type ChoiceExerciseVerifierInput = {
  skill: ChoiceExerciseGeneratorInput["skill"];
  sourceContext: string | null;
  sourceMedia?: SourceMediaContext[];
  existingExerciseContext?: string | null;
  candidates: GeneratedChoiceExerciseCandidate[];
};

export type ChoiceExerciseVerifier = (
  input: ChoiceExerciseVerifierInput,
) => Promise<unknown>;

export type ExactInputExerciseGeneratorInput = ChoiceExerciseGeneratorInput;

export type ExactInputExerciseGenerator = (
  input: ExactInputExerciseGeneratorInput,
) => Promise<unknown>;

export type ExactInputExerciseVerifierInput = {
  skill: ExactInputExerciseGeneratorInput["skill"];
  sourceContext: string | null;
  sourceMedia?: SourceMediaContext[];
  existingExerciseContext?: string | null;
  candidates: GeneratedExactInputExerciseCandidate[];
};

export type ExactInputExerciseVerifier = (
  input: ExactInputExerciseVerifierInput,
) => Promise<unknown>;

export type MathExerciseGeneratorInput = ChoiceExerciseGeneratorInput;

export type MathExerciseGenerator = (
  input: MathExerciseGeneratorInput,
) => Promise<unknown>;

export type MathExerciseVerifierInput = {
  skill: MathExerciseGeneratorInput["skill"];
  sourceContext: string | null;
  sourceMedia?: SourceMediaContext[];
  existingExerciseContext?: string | null;
  candidates: GeneratedMathExerciseCandidate[];
};

export type MathExerciseVerifier = (
  input: MathExerciseVerifierInput,
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
  sourceMedia?: SourceMediaContext[];
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
  sourceMediaLoader?: SourceMediaContextLoader;
  model?: string;
  skipUsageLimitCheck?: boolean;
};

export type RefillChoiceExercisesInput = {
  userId: string;
  skillId: string;
  now: Date;
  generationJobId?: string;
  targetReadyCount?: number;
  generateChoiceExercises?: ChoiceExerciseGenerator;
  verifyChoiceExercises?: ChoiceExerciseVerifier;
  sourceMediaLoader?: SourceMediaContextLoader;
  model?: string;
};

export type RefillExactInputExercisesInput = {
  userId: string;
  skillId: string;
  now: Date;
  generationJobId?: string;
  targetReadyCount?: number;
  generateExactInputExercises?: ExactInputExerciseGenerator;
  verifyExactInputExercises?: ExactInputExerciseVerifier;
  sourceMediaLoader?: SourceMediaContextLoader;
  model?: string;
};

export type RefillMathExercisesInput = {
  userId: string;
  skillId: string;
  now: Date;
  generationJobId?: string;
  targetReadyCount?: number;
  generateMathExercises?: MathExerciseGenerator;
  verifyMathExercises?: MathExerciseVerifier;
  sourceMediaLoader?: SourceMediaContextLoader;
  model?: string;
};

export type CreateSkillDraftFromSourceInput = {
  userId: string;
  input: unknown;
  now: Date;
  generateSkillDraft?: SkillDraftGenerator;
  model?: string;
  recoveredSourceFileId?: string | null;
  skipUsageLimitCheck?: boolean;
  persistFailedSource?: boolean;
};

export type CreateGeneratedSkillDraftsForSourceFileInput = {
  userId: string;
  sourceFileId: string;
  sourceFileGuard?: Prisma.SourceFileWhereInput;
  collectionName: string | null;
  focusNote: string | null;
  tags: string[];
  drafts: GeneratedSkillDraft[];
  sourceFileUpdate?: Pick<
    Prisma.SourceFileUncheckedUpdateInput,
    "status" | "byteSize" | "extractedText" | "metadata"
  >;
};

export type SourceSkillDraftWriteResult =
  | {
      status: "created";
      skills: Skill[];
      sourceFileId: string;
      skillSourceRefIds: string[];
    }
  | Extract<SourceSkillDraftInputResult, { status: "invalid" }>
  | {
      status: "not-created";
      reason:
        | "generation-failed"
        | "invalid-generation"
        | "missing-gemini-env"
        | "quota-exceeded"
        | "save-failed"
        | "source-not-found";
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
        | "activation-in-progress"
        | "missing-gemini-env"
        | "quota-exceeded"
        | "skill-not-draft";
      message: string;
      generationJobId?: string;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type SkillExerciseRefillResult =
  | {
      status: "refilled";
      skillId: string;
      generationJobId: string;
      exerciseCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
    }
  | {
      status: "not-refilled";
      reason:
        | "already-at-target"
        | "generation-failed"
        | "invalid-generation"
        | "verification-failed"
        | "invalid-verification"
        | "job-not-pending"
        | "missing-gemini-env"
        | "no-new-exercises"
        | "skill-not-active";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type ExactInputExerciseRefillResult =
  | {
      status: "refilled";
      skillId: string;
      generationJobId: string;
      exerciseCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
    }
  | {
      status: "not-refilled";
      reason:
        | "already-at-target"
        | "exact-input-locked"
        | "generation-failed"
        | "invalid-generation"
        | "verification-failed"
        | "invalid-verification"
        | "job-not-pending"
        | "missing-gemini-env"
        | "no-new-exercises"
        | "skill-not-active";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type MathExerciseRefillResult =
  | {
      status: "refilled";
      skillId: string;
      generationJobId: string;
      exerciseCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
    }
  | {
      status: "not-refilled";
      reason:
        | "already-at-target"
        | "exact-input-locked"
        | "generation-failed"
        | "invalid-generation"
        | "verification-failed"
        | "invalid-verification"
        | "job-not-pending"
        | "missing-gemini-env"
        | "no-new-exercises"
        | "skill-not-active";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type ChoiceExerciseInventoryRecord = {
  answerKind: AnswerKind;
  verificationStatus: ExerciseVerificationStatus;
  retiredAt: Date | null;
  choices: Prisma.JsonValue | null;
};

export type ChoiceExerciseInventoryCounts = {
  verifiedExerciseCount: number;
  retiredExerciseCount: number;
  readyExerciseCount: number;
};

export type ExactInputExerciseInventoryRecord = {
  answerKind: AnswerKind;
  verificationStatus: ExerciseVerificationStatus;
  retiredAt: Date | null;
  answerSpec: Prisma.JsonValue;
};

export type ExactInputExerciseInventoryCounts = {
  verifiedExerciseCount: number;
  retiredExerciseCount: number;
  readyExerciseCount: number;
};

export type MathExerciseInventoryRecord = {
  answerKind: AnswerKind;
  verificationStatus: ExerciseVerificationStatus;
  retiredAt: Date | null;
  answerSpec: Prisma.JsonValue;
};

export type MathExerciseInventoryCounts = {
  verifiedExerciseCount: number;
  retiredExerciseCount: number;
  readyExerciseCount: number;
};

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}, z.string().trim().optional());

const noteListStringSchema = optionalTrimmedStringSchema.pipe(
  z
    .string()
    .superRefine((value, ctx) => {
      if (value.length > MAX_DRAFT_NOTE_LENGTH) {
        ctx.addIssue({
          code: "too_big",
          maximum: MAX_DRAFT_NOTE_LENGTH,
          origin: "string",
          inclusive: true,
          message: `Use ${MAX_DRAFT_NOTE_LENGTH} characters or fewer.`,
        });
        return;
      }

      const budget = checkNoteLineBudget(value);

      if (budget.reason === "too-many-lines") {
        ctx.addIssue({
          code: "custom",
          message: `Use at most ${MAX_DRAFT_NOTE_ITEMS} non-empty lines.`,
        });
      }

      if (budget.reason === "line-too-long") {
        ctx.addIssue({
          code: "custom",
          message: `Each line must be ${MAX_DRAFT_NOTE_LINE_LENGTH} characters or fewer.`,
        });
      }
    })
    .optional(),
);
const exerciseConstraintsStringSchema = optionalTrimmedStringSchema.pipe(
  z.string().max(MAX_EXERCISE_CONSTRAINTS_LENGTH).optional(),
);
const tagStringSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (value.length > MAX_TAG_INPUT_LENGTH) {
      ctx.addIssue({
        code: "too_big",
        maximum: MAX_TAG_INPUT_LENGTH,
        origin: "string",
        inclusive: true,
        message: `Use ${MAX_TAG_INPUT_LENGTH} characters or fewer.`,
      });
      return;
    }

    const tags = splitTagParts(value);

    if (tags.length > MAX_TAGS) {
      ctx.addIssue({
        code: "custom",
        message: `Use at most ${MAX_TAGS} tags.`,
      });
    }

    if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      ctx.addIssue({
        code: "custom",
        message: `Tags must be at most ${MAX_TAG_LENGTH} characters.`,
      });
    }
  });
const tagsInputSchema = z
  .union([tagStringSchema, z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS)])
  .optional();
const draftInputSchema = z.strictObject({
  title: z.string().trim().min(1, "Skill title is required.").max(120),
  objective: z
    .string()
    .trim()
    .min(12, "Describe the skill objective in at least 12 characters.")
    .max(1200),
  collectionName: optionalTrimmedStringSchema.pipe(
    z.string().max(MAX_COLLECTION_NAME_LENGTH).optional(),
  ),
  rules: noteListStringSchema,
  examples: noteListStringSchema,
  exerciseConstraints: exerciseConstraintsStringSchema,
  tags: tagsInputSchema,
});

const skillPracticeGuidanceInputSchema = z.strictObject({
  rules: noteListStringSchema,
  examples: noteListStringSchema,
  exerciseConstraints: exerciseConstraintsStringSchema,
});

const sourceSkillDraftInputSchema = z.strictObject({
  sourceText: z
    .string()
    .trim()
    .min(12, "Enter at least 12 characters of learning material or a skill description.")
    .max(12_000, "Paste at most 12,000 characters for this first source flow."),
  sourceLabel: optionalTrimmedStringSchema.pipe(z.string().max(160).optional()),
  focusNote: optionalTrimmedStringSchema.pipe(z.string().max(800).optional()),
  collectionName: optionalTrimmedStringSchema.pipe(
    z.string().max(MAX_COLLECTION_NAME_LENGTH).optional(),
  ),
  tags: tagsInputSchema,
});

const generatedSkillDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(12).max(1200),
  rules: z.array(z.string().trim().min(1).max(MAX_DRAFT_NOTE_LINE_LENGTH)).min(1).max(8),
  examples: z.array(z.string().trim().min(1).max(MAX_DRAFT_NOTE_LINE_LENGTH)).min(1).max(8),
  exerciseConstraints: z.string().trim().min(1).max(1000),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
});

const generatedSkillDraftEnvelopeSchema = z.strictObject({
  drafts: z.array(generatedSkillDraftSchema).length(MAX_GENERATED_SKILL_DRAFTS),
});

const generatedChoiceExerciseSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1200),
  choices: choicesSchema.min(2).max(6),
  correctChoiceId: z.string().trim().min(1),
  explanation: z.string().trim().min(1).max(1200).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  expectedSeconds: z.number().int().min(5).max(180).optional(),
});

const generatedExactInputExerciseSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1200),
  answerKind: z.enum([AnswerKind.TEXT, AnswerKind.NUMERIC]),
  answerSpec: z.unknown(),
  correctAnswerDisplay: z.string().trim().min(1).max(500),
  explanation: z.string().trim().min(1).max(1200).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  expectedSeconds: z.number().int().min(5).max(180).optional(),
});

const generatedMathExerciseSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1200),
  answerKind: z.literal(AnswerKind.MATH),
  answerSpec: z.unknown(),
  correctAnswerDisplay: z.string().trim().min(1).max(500),
  explanation: z.string().trim().min(1).max(1200).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  expectedSeconds: z.number().int().min(5).max(180).optional(),
});

function generatedChoiceEnvelopeSchema(maxGeneratedExercises: number) {
  return z.strictObject({
    exercises: z.array(z.unknown()).min(1).max(maxGeneratedExercises),
  });
}

function generatedExactInputEnvelopeSchema(maxGeneratedExercises: number) {
  return z.strictObject({
    exercises: z.array(z.unknown()).min(1).max(maxGeneratedExercises),
  });
}

function generatedMathEnvelopeSchema(maxGeneratedExercises: number) {
  return z.strictObject({
    exercises: z.array(z.unknown()).min(1).max(maxGeneratedExercises),
  });
}

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

function choiceVerificationEnvelopeSchema(maxVerifications: number) {
  return z.strictObject({
    verifications: z.array(choiceVerificationDecisionSchema).min(1).max(maxVerifications),
  });
}

function buildGeminiResponseJsonSchema(requestedCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["exercises"],
    properties: {
      exercises: {
        type: "array",
        minItems: Math.max(1, Math.min(requestedCount, REQUESTED_ACTIVATION_EXERCISES)),
        maxItems: Math.max(1, Math.min(requestedCount, MAX_GENERATED_EXERCISES)),
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
}

function buildGeminiChoiceVerificationJsonSchema(candidateCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verifications"],
    properties: {
      verifications: {
        type: "array",
        minItems: candidateCount,
        maxItems: candidateCount,
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
}

function buildGeminiExactInputResponseJsonSchema(requestedCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["exercises"],
    properties: {
      exercises: {
        type: "array",
        minItems: Math.max(1, Math.min(requestedCount, DEFAULT_READY_EXACT_INPUT_TARGET)),
        maxItems: Math.max(1, Math.min(requestedCount, MAX_GENERATED_EXERCISES)),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "answerKind", "answerSpec", "correctAnswerDisplay", "explanation"],
          properties: {
            prompt: { type: "string" },
            answerKind: {
              type: "string",
              enum: [AnswerKind.TEXT, AnswerKind.NUMERIC],
            },
            answerSpec: {
              type: "object",
            },
            correctAnswerDisplay: { type: "string" },
            explanation: { type: "string" },
            difficulty: { type: "integer", minimum: 1, maximum: 5 },
            expectedSeconds: { type: "integer", minimum: 5, maximum: 180 },
          },
        },
      },
    },
  };
}

function buildGeminiExactInputVerificationJsonSchema(candidateCount: number) {
  return buildGeminiChoiceVerificationJsonSchema(candidateCount);
}

function buildGeminiMathResponseJsonSchema(requestedCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["exercises"],
    properties: {
      exercises: {
        type: "array",
        minItems: Math.max(1, Math.min(requestedCount, DEFAULT_READY_MATH_TARGET)),
        maxItems: Math.max(1, Math.min(requestedCount, MAX_GENERATED_EXERCISES)),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "answerKind", "answerSpec", "correctAnswerDisplay", "explanation"],
          properties: {
            prompt: { type: "string" },
            answerKind: {
              type: "string",
              enum: [AnswerKind.MATH],
            },
            answerSpec: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "acceptedExpressions", "equivalence"],
              properties: {
                kind: { type: "string", enum: ["math"] },
                acceptedExpressions: {
                  type: "array",
                  minItems: 1,
                  maxItems: 4,
                  items: { type: "string" },
                },
                equivalence: { type: "string", enum: ["basic-symbolic"] },
              },
            },
            correctAnswerDisplay: { type: "string" },
            explanation: { type: "string" },
            difficulty: { type: "integer", minimum: 1, maximum: 5 },
            expectedSeconds: { type: "integer", minimum: 5, maximum: 180 },
          },
        },
      },
    },
  };
}

function buildGeminiMathVerificationJsonSchema(candidateCount: number) {
  return buildGeminiChoiceVerificationJsonSchema(candidateCount);
}

const geminiSkillDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["drafts"],
  properties: {
    drafts: {
      type: "array",
      minItems: MAX_GENERATED_SKILL_DRAFTS,
      maxItems: MAX_GENERATED_SKILL_DRAFTS,
      items: {
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

export function normalizeSkillPracticeGuidanceInput(
  input: unknown,
): SkillPracticeGuidanceInputResult {
  const result = skillPracticeGuidanceInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Practice guidance could not be saved.",
      fieldErrors: z.flattenError(result.error).fieldErrors,
    };
  }

  const value = result.data;

  return {
    status: "ready",
    value: {
      rules: splitNotes(value.rules),
      examples: splitNotes(value.examples),
      exerciseConstraints: value.exerciseConstraints ?? null,
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

export async function updateSkillPracticeGuidance(input: {
  userId: string;
  skillId: string;
  input: unknown;
}): Promise<
  | {
      status: "updated";
      skillId: string;
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
    }
> {
  const normalized = normalizeSkillPracticeGuidanceInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const updateResult = await getPrisma().skill.updateMany({
    where: {
      id: input.skillId,
      userId: input.userId,
      status: SkillStatus.ACTIVE,
    },
    data: {
      rules: toNotesJson(normalized.value.rules),
      examples: toNotesJson(normalized.value.examples),
      exerciseConstraints: toConstraintsJson(normalized.value.exerciseConstraints),
    },
  });

  if (updateResult.count === 0) {
    return {
      status: "not-found",
      reason: "skill-not-found",
      message: "No active skill was found for this user.",
    };
  }

  return {
    status: "updated",
    skillId: input.skillId,
  };
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

  let prisma = input.skipUsageLimitCheck ? null : getPrisma();

  if (!input.skipUsageLimitCheck) {
    const quota = await checkPastedSourceDraftUsageLimit({
      userId: input.userId,
      now: input.now,
      prisma: prisma ?? undefined,
    });

    if (quota.status === "limited") {
      return {
        status: "not-created",
        reason: "quota-exceeded",
        message: quota.message,
      };
    }
  }

  const sourceContext = buildSourceContextExcerpt([normalized.value.sourceText]) ?? normalized.value.sourceText;
  let persistedSourceFileId: string | null = null;
  const recoveredSourceFileId = input.recoveredSourceFileId?.trim() || null;

  if (recoveredSourceFileId) {
    prisma ??= getPrisma();
    const claimed = await prisma.$transaction((tx) =>
      claimRecoveredPastedSource({
        prisma: tx,
        userId: input.userId,
        sourceFileId: recoveredSourceFileId,
        now: input.now,
        normalized: normalized.value,
        model: setup.model,
      }),
    );

    if (!claimed) {
      return {
        status: "not-created",
        reason: "source-not-found",
        message: "That saved text could not be recovered. Paste it again to create the skill.",
      };
    }

    persistedSourceFileId = claimed;
  }

  if (input.persistFailedSource && !persistedSourceFileId) {
    prisma ??= getPrisma();
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId: input.userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.PROCESSING,
        originalName: normalized.value.sourceLabel ?? "Pasted source",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(normalized.value.sourceText, "utf8"),
        extractedText: normalized.value.sourceText,
        metadata: buildPastedSourceMetadata({
          normalized: normalized.value,
          model: setup.model,
          now: input.now,
        }),
      },
      select: {
        id: true,
      },
    });
    persistedSourceFileId = sourceFile.id;
  }

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
    console.error("[ai] skill draft generation failed", getGeminiErrorLogDetails(error));
    const message = getPublicGeminiFailureMessage(error);

    if (persistedSourceFileId && prisma) {
      await markPastedSourceFailed({
        prisma,
        userId: input.userId,
        sourceFileId: persistedSourceFileId,
        now: input.now,
        reason: "generation-failed",
        message,
        normalized: normalized.value,
        model: setup.model,
        recoveredFromSourceFileId: recoveredSourceFileId,
      });
    }

    return {
      status: "not-created",
      reason: "generation-failed",
      message,
    };
  }

  const validation = validateGeneratedSkillDrafts(rawGeneration);

  if (validation.status === "invalid") {
    if (persistedSourceFileId && prisma) {
      await markPastedSourceFailed({
        prisma,
        userId: input.userId,
        sourceFileId: persistedSourceFileId,
        now: input.now,
        reason: "invalid-generation",
        message: validation.message,
        normalized: normalized.value,
        model: setup.model,
        recoveredFromSourceFileId: recoveredSourceFileId,
      });
    }

    return {
      status: "not-created",
      reason: "invalid-generation",
      message: validation.message,
    };
  }

  prisma ??= getPrisma();

  try {
    return await prisma.$transaction(async (tx) => {
      const sourceFile = persistedSourceFileId
        ? { id: persistedSourceFileId }
        : await tx.sourceFile.create({
            data: {
              userId: input.userId,
              kind: SourceFileKind.TEXT,
              status: SourceFileStatus.READY,
              originalName: normalized.value.sourceLabel ?? "Pasted source",
              mimeType: "text/plain",
              byteSize: Buffer.byteLength(normalized.value.sourceText, "utf8"),
              extractedText: normalized.value.sourceText,
              metadata: buildPastedSourceMetadata({
                normalized: normalized.value,
                model: setup.model,
                now: input.now,
                generated: true,
              }),
            },
            select: {
              id: true,
            },
          });
      const createdDrafts = await createGeneratedSkillDraftsForSourceFileInTransaction(tx, {
        userId: input.userId,
        sourceFileId: sourceFile.id,
        collectionName: normalized.value.collectionName,
        focusNote: normalized.value.focusNote,
        tags: normalized.value.tags,
        drafts: validation.drafts,
        sourceFileUpdate: persistedSourceFileId
          ? {
              status: SourceFileStatus.READY,
              byteSize: Buffer.byteLength(normalized.value.sourceText, "utf8"),
              extractedText: normalized.value.sourceText,
              metadata: buildPastedSourceMetadata({
                normalized: normalized.value,
                model: setup.model,
                now: input.now,
                generated: true,
                recoveredFromSourceFileId: recoveredSourceFileId,
              }),
            }
          : undefined,
      });

      if (createdDrafts.status === "not-found") {
        throw new Error("Source file was not found.");
      }

      return {
        status: "created",
        skills: createdDrafts.skills,
        sourceFileId: sourceFile.id,
        skillSourceRefIds: createdDrafts.skillSourceRefIds,
      };
    });
  } catch (error) {
    if (!persistedSourceFileId) {
      throw error;
    }

    const message = "Skill preparation failed before LearnRecur could save the generated skill. Try again.";
    await markPastedSourceFailed({
      prisma,
      userId: input.userId,
      sourceFileId: persistedSourceFileId,
      now: input.now,
      reason: "save-failed",
      message,
      normalized: normalized.value,
      model: setup.model,
      recoveredFromSourceFileId: recoveredSourceFileId,
    });

    return {
      status: "not-created",
      reason: "save-failed",
      message,
    };
  }
}

export async function createGeneratedSkillDraftsForSourceFile(
  input: CreateGeneratedSkillDraftsForSourceFileInput,
): Promise<
  | {
      status: "created";
      skills: Skill[];
      sourceFileId: string;
      skillSourceRefIds: string[];
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    }
> {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const result = await createGeneratedSkillDraftsForSourceFileInTransaction(tx, input);

    if (result.status === "not-found") {
      return {
        status: "not-found",
        reason: "source-not-found",
        message: "Uploaded source material was not found.",
      };
    }

    return {
      status: "created",
      sourceFileId: input.sourceFileId,
      skills: result.skills,
      skillSourceRefIds: result.skillSourceRefIds,
    };
  });
}

function buildPastedSourceMetadata({
  generated = false,
  model,
  normalized,
  now,
  recoveredFromSourceFileId,
}: {
  generated?: boolean;
  model: string;
  normalized: NormalizedSourceSkillDraftInput;
  now: Date;
  recoveredFromSourceFileId?: string | null;
}): Prisma.InputJsonObject {
  return {
    createdBy: SOURCE_SKILL_DRAFT_PROMPT_VERSION,
    focusNote: normalized.focusNote,
    model,
    submittedAt: now.toISOString(),
    ...(generated ? { generatedAt: now.toISOString() } : {}),
    ...(recoveredFromSourceFileId ? { recoveredFromSourceFileId } : {}),
  };
}

async function claimRecoveredPastedSource({
  model,
  normalized,
  now,
  prisma,
  sourceFileId,
  userId,
}: {
  model: string;
  normalized: NormalizedSourceSkillDraftInput;
  now: Date;
  prisma: Pick<Prisma.TransactionClient, "sourceFile">;
  sourceFileId: string;
  userId: string;
}) {
  const result = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFileId,
      userId,
      kind: SourceFileKind.TEXT,
      status: SourceFileStatus.FAILED,
      skillRefs: {
        none: {},
      },
    },
    data: {
      status: SourceFileStatus.READY,
      publicUrl: null,
      metadata: {
        recoveredAt: now.toISOString(),
      },
    },
  });

  if (result.count === 0) {
    return null;
  }

  const retrySource = await prisma.sourceFile.create({
    data: {
      userId,
      kind: SourceFileKind.TEXT,
      status: SourceFileStatus.PROCESSING,
      originalName: normalized.sourceLabel ?? "Recovered pasted source",
      mimeType: "text/plain",
      byteSize: Buffer.byteLength(normalized.sourceText, "utf8"),
      extractedText: normalized.sourceText,
      metadata: {
        ...buildPastedSourceMetadata({
          normalized,
          model,
          now,
          recoveredFromSourceFileId: sourceFileId,
        }),
      },
    },
    select: {
      id: true,
    },
  });

  await prisma.sourceFile.update({
    where: {
      id_userId: {
        id: sourceFileId,
        userId,
      },
    },
    data: {
      metadata: {
        recoveredAt: now.toISOString(),
        recoveredIntoSourceFileId: retrySource.id,
      },
    },
  });

  return retrySource.id;
}

async function markPastedSourceFailed({
  message,
  model,
  normalized,
  now,
  prisma,
  reason,
  recoveredFromSourceFileId,
  sourceFileId,
  userId,
}: {
  message: string;
  model: string;
  normalized: NormalizedSourceSkillDraftInput;
  now: Date;
  prisma: Pick<Prisma.TransactionClient, "sourceFile">;
  recoveredFromSourceFileId?: string | null;
  reason: string;
  sourceFileId: string;
  userId: string;
}) {
  await prisma.sourceFile.updateMany({
    where: {
      id: sourceFileId,
      userId,
    },
    data: {
      status: SourceFileStatus.FAILED,
      publicUrl: null,
      metadata: {
        ...buildPastedSourceMetadata({
          normalized,
          model,
          now,
          recoveredFromSourceFileId,
        }),
        failedAt: now.toISOString(),
        failureReason: reason,
        errorMessage: message.slice(0, 500),
      },
    },
  });
}

export async function loadSourceMediaContextForSourceFiles({
  sourceFiles,
  storage,
}: {
  sourceFiles: SourceMediaContextSourceFile[];
  storage?: SourceObjectStorage;
}): Promise<SourceMediaContext[]> {
  const uploadBackedSources = sourceFiles.filter(shouldAttachOriginalSourceMedia);

  if (uploadBackedSources.length === 0) {
    return [];
  }

  const storageSetup = storage
    ? { status: "ready" as const, storage }
    : resolveS3SourceObjectStorage();

  if (storageSetup.status === "missing-env") {
    throw new Error(storageSetup.message);
  }

  const media: SourceMediaContext[] = [];
  let totalBytes = 0;

  for (const sourceFile of uploadBackedSources) {
    if (!sourceFile.mimeType || !isSourceUploadMimeType(sourceFile.mimeType)) {
      throw new Error("Uploaded source media MIME type is not supported.");
    }

    if (!sourceFile.storageBucket || !sourceFile.storageKey) {
      throw new Error("Uploaded source media metadata is incomplete.");
    }

    if (sourceFile.storageBucket !== storageSetup.storage.bucketName) {
      throw new Error("Uploaded source media bucket does not match configured storage.");
    }

    const bytes = await storageSetup.storage.getObjectBytes({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
      maxBytes: MAX_SOURCE_UPLOAD_BYTES,
    });

    if (bytes.length === 0 || bytes.length > MAX_SOURCE_UPLOAD_BYTES) {
      throw new Error("Uploaded source media is missing or larger than 10 MB.");
    }

    totalBytes += bytes.length;

    if (totalBytes > MAX_TOTAL_SOURCE_MEDIA_BYTES) {
      throw new Error("Uploaded source media exceeds the total attachment limit.");
    }

    media.push({
      sourceFileId: sourceFile.id,
      label: sourceFile.originalName,
      mimeType: sourceFile.mimeType,
      bytes,
    });
  }

  return media;
}

async function resolveSourceMediaContext({
  sourceFiles,
  sourceMediaLoader,
}: {
  sourceFiles: SourceMediaContextSourceFile[];
  sourceMediaLoader?: SourceMediaContextLoader;
}): Promise<SourceMediaContext[]> {
  const attachableSourceFiles = sourceFiles.filter(shouldAttachOriginalSourceMedia);

  if (sourceMediaLoader) {
    return sourceMediaLoader({ sourceFiles: attachableSourceFiles });
  }

  return loadSourceMediaContextForSourceFiles({ sourceFiles: attachableSourceFiles });
}

function shouldAttachOriginalSourceMedia(sourceFile: SourceMediaContextSourceFile) {
  return (
    sourceFile.status === SourceFileStatus.READY &&
    (sourceFile.kind === SourceFileKind.IMAGE || sourceFile.kind === SourceFileKind.PDF)
  );
}

function buildSourceMediaLoadFailureMessage(error: unknown) {
  return `Uploaded source media could not be loaded: ${formatEnvError(error)}`;
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
              id: true,
              kind: true,
              status: true,
              originalName: true,
              mimeType: true,
              storageBucket: true,
              storageKey: true,
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

  if (!input.skipUsageLimitCheck) {
    const quota = await checkSkillActivationUsageLimit({
      userId: input.userId,
      now: input.now,
      prisma,
    });

    if (quota.status === "limited") {
      return {
        status: "not-activated",
        reason: "quota-exceeded",
        message: quota.message,
      };
    }
  }

  const setup = resolveActivationSetup(input);

  const generationJobResult = await createOrClaimActivationGenerationJob({
    prisma,
    userId: input.userId,
    skillId: skill.id,
    setup,
    now: input.now,
  });

  if (generationJobResult.status === "not-ready") {
    return {
      status: "not-activated",
      reason: "activation-in-progress",
      message: generationJobResult.message,
      generationJobId: generationJobResult.generationJobId,
    };
  }

  const { generationJob } = generationJobResult;

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
  let sourceMedia: SourceMediaContext[];

  try {
    sourceMedia = await resolveSourceMediaContext({
      sourceFiles: skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile),
      sourceMediaLoader: input.sourceMediaLoader,
    });
  } catch (error) {
    const message = buildSourceMediaLoadFailureMessage(error);
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

  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateChoiceExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext: null,
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

  const validation = validateGeneratedChoiceExercises(rawGeneration, {
    maxGeneratedExercises: REQUESTED_ACTIVATION_EXERCISES,
  });

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
        sourceMedia,
        existingExerciseContext: null,
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

export async function refillChoiceExercisesForSkill(
  input: RefillChoiceExercisesInput,
): Promise<SkillExerciseRefillResult> {
  const prisma = getPrisma();
  const targetReadyCount = normalizeReadyExerciseTarget(input.targetReadyCount);
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
              id: true,
              kind: true,
              status: true,
              originalName: true,
              mimeType: true,
              storageBucket: true,
              storageKey: true,
              extractedText: true,
            },
          },
        },
      },
      exercises: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          prompt: true,
          correctAnswerDisplay: true,
        },
      },
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.ACTIVE) {
    return {
      status: "not-refilled",
      reason: "skill-not-active",
      message: "Only active skills can generate more practice exercises.",
    };
  }

  const inventory = countChoiceExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    if (input.generationJobId) {
      const generationJobResult = await failPendingRefillGenerationJob({
        prisma,
        generationJobId: input.generationJobId,
        userId: input.userId,
        skillId: skill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        message: "Skill already reached the ready exercise target.",
        now: input.now,
      });

      if (generationJobResult.status === "not-ready") {
        return {
          status: "not-refilled",
          reason: "job-not-pending",
          message: generationJobResult.message,
          generationJobId: input.generationJobId,
          readyExerciseCount: inventory.readyExerciseCount,
          targetReadyCount,
        };
      }
    }

    return {
      status: "not-refilled",
      reason: "already-at-target",
      message: "This skill already has enough ready practice exercises.",
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const requestedCount = targetReadyCount - inventory.readyExerciseCount;
  const setup = resolveActivationSetup(input);
  const generationJobResult = await createOrClaimRefillGenerationJob({
    prisma,
    generationJobId: input.generationJobId,
    userId: input.userId,
    skillId: skill.id,
    kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
    promptVersion: SKILL_MCQ_PROMPT_VERSION,
    setup,
    requestedCount,
    now: input.now,
  });

  if (generationJobResult.status === "not-ready") {
    return {
      status: "not-refilled",
      reason: "job-not-pending",
      message: generationJobResult.message,
      generationJobId: input.generationJobId,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const generationJob = generationJobResult.generationJob;

  if (setup.status === "missing-env") {
    return {
      status: "not-refilled",
      reason: "missing-gemini-env",
      message: setup.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const sourceContext = buildSourceContextExcerpt(
    skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile.extractedText),
  );
  const existingExerciseContext = buildExistingChoiceExerciseContext(skill.exercises);
  let sourceMedia: SourceMediaContext[];

  try {
    sourceMedia = await resolveSourceMediaContext({
      sourceFiles: skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile),
      sourceMediaLoader: input.sourceMediaLoader,
    });
  } catch (error) {
    const message = buildSourceMediaLoadFailureMessage(error);
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateChoiceExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
        requestedCount,
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
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const validation = validateGeneratedChoiceExercises(rawGeneration, {
    minValidExercises: 1,
    maxGeneratedExercises: requestedCount,
  });

  if (validation.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: validation.message,
      acceptedCount: validation.validCount,
      rejectedCount: validation.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-generation",
      message: validation.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const deduplicated = filterDuplicateChoiceExercises(validation.exercises, skill.exercises);

  if (deduplicated.exercises.length === 0) {
    const message = "Gemini returned only duplicate exercises for this skill.";
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: validation.rejectedCount + deduplicated.duplicateCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "no-new-exercises",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const candidates = toGeneratedChoiceExerciseCandidates(deduplicated.exercises);
  let rawVerification: unknown;

  try {
    rawVerification = await withTimeout(
      setup.verifyChoiceExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
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
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + deduplicated.exercises.length,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "verification-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const verification = validateChoiceExerciseVerification(
    {
      candidates,
      rawVerification,
    },
    {
      minVerifiedExercises: 1,
    },
  );

  if (verification.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: verification.message,
      acceptedCount: verification.verifiedCount,
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-verification",
      message: verification.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  return prisma.$transaction(async (tx) => {
    const currentSkill = await tx.skill.findFirst({
      where: {
        id: skill.id,
        userId: input.userId,
        status: SkillStatus.ACTIVE,
      },
      select: {
        id: true,
        exercises: {
          select: {
            answerKind: true,
            verificationStatus: true,
            retiredAt: true,
            choices: true,
          },
        },
      },
    });

    if (!currentSkill) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill is no longer active.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: "skill-not-active",
        message: "Skill is no longer active.",
        generationJobId: generationJob.id,
      };
    }

    const currentInventory = countChoiceExerciseInventory(currentSkill.exercises);

    if (currentInventory.readyExerciseCount >= targetReadyCount) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill already reached the ready exercise target.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: "already-at-target",
        message: "This skill already has enough ready practice exercises.",
        generationJobId: generationJob.id,
        readyExerciseCount: currentInventory.readyExerciseCount,
        targetReadyCount,
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
        rejectedCount:
          validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
        completedAt: input.now,
      },
    });

    return {
      status: "refilled",
      skillId: skill.id,
      generationJobId: generationJob.id,
      exerciseCount: verification.exercises.length,
      readyExerciseCount: currentInventory.readyExerciseCount + verification.exercises.length,
      targetReadyCount,
    };
  });
}

export async function refillExactInputExercisesForSkill(
  input: RefillExactInputExercisesInput,
): Promise<ExactInputExerciseRefillResult> {
  const prisma = getPrisma();
  const targetReadyCount = normalizeReadyExerciseTarget(
    input.targetReadyCount,
    DEFAULT_READY_EXACT_INPUT_TARGET,
  );
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
      repetitions: true,
      sourceRefs: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          sourceFile: {
            select: {
              id: true,
              kind: true,
              status: true,
              originalName: true,
              mimeType: true,
              storageBucket: true,
              storageKey: true,
              extractedText: true,
            },
          },
        },
      },
      exercises: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          answerKind: true,
          answerSpec: true,
          verificationStatus: true,
          retiredAt: true,
          prompt: true,
          correctAnswerDisplay: true,
        },
      },
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.ACTIVE) {
    return {
      status: "not-refilled",
      reason: "skill-not-active",
      message: "Only active skills can generate exact-input practice.",
    };
  }

  if (!isExactInputUnlocked(skill.repetitions)) {
    return {
      status: "not-refilled",
      reason: "exact-input-locked",
      message: `Practice multiple-choice reviews first. Exact input starts after ${EXACT_INPUT_UNLOCK_REPETITIONS} completed reviews.`,
    };
  }

  const inventory = countExactInputExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    if (input.generationJobId) {
      const generationJobResult = await failPendingRefillGenerationJob({
        prisma,
        generationJobId: input.generationJobId,
        userId: input.userId,
        skillId: skill.id,
        kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
        message: "Skill already reached the ready exact-input target.",
        now: input.now,
      });

      if (generationJobResult.status === "not-ready") {
        return {
          status: "not-refilled",
          reason: "job-not-pending",
          message: generationJobResult.message,
          generationJobId: input.generationJobId,
          readyExerciseCount: inventory.readyExerciseCount,
          targetReadyCount,
        };
      }
    }

    return {
      status: "not-refilled",
      reason: "already-at-target",
      message: "This skill already has enough ready exact-input exercises.",
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const requestedCount = targetReadyCount - inventory.readyExerciseCount;
  const setup = resolveExactInputRefillSetup(input);
  const generationJobResult = await createOrClaimRefillGenerationJob({
    prisma,
    generationJobId: input.generationJobId,
    userId: input.userId,
    skillId: skill.id,
    kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
    promptVersion: SKILL_EXACT_INPUT_PROMPT_VERSION,
    setup,
    requestedCount,
    now: input.now,
  });

  if (generationJobResult.status === "not-ready") {
    return {
      status: "not-refilled",
      reason: "job-not-pending",
      message: generationJobResult.message,
      generationJobId: input.generationJobId,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const generationJob = generationJobResult.generationJob;

  if (setup.status === "missing-env") {
    return {
      status: "not-refilled",
      reason: "missing-gemini-env",
      message: setup.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const sourceContext = buildSourceContextExcerpt(
    skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile.extractedText),
  );
  const existingExerciseContext = buildExistingExactInputExerciseContext(skill.exercises);
  let sourceMedia: SourceMediaContext[];

  try {
    sourceMedia = await resolveSourceMediaContext({
      sourceFiles: skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile),
      sourceMediaLoader: input.sourceMediaLoader,
    });
  } catch (error) {
    const message = buildSourceMediaLoadFailureMessage(error);
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateExactInputExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
        requestedCount,
      }),
      GENERATION_TIMEOUT_MS,
      "generateExactInputExercises timed out",
    );
  } catch (error) {
    const message = `Gemini exact-input exercise generation failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const validation = validateGeneratedExactInputExercises(rawGeneration, {
    minValidExercises: 1,
    maxGeneratedExercises: requestedCount,
  });

  if (validation.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: validation.message,
      acceptedCount: validation.validCount,
      rejectedCount: validation.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-generation",
      message: validation.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const deduplicated = filterDuplicateExactInputExercises(validation.exercises, skill.exercises);

  if (deduplicated.exercises.length === 0) {
    const message = "Gemini returned only duplicate exact-input exercises for this skill.";
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: validation.rejectedCount + deduplicated.duplicateCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "no-new-exercises",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const candidates = toGeneratedExactInputExerciseCandidates(deduplicated.exercises);
  let rawVerification: unknown;

  try {
    rawVerification = await withTimeout(
      setup.verifyExactInputExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
        candidates,
      }),
      GENERATION_TIMEOUT_MS,
      "verifyExactInputExercises timed out",
    );
  } catch (error) {
    const message = `Gemini exact-input exercise verification failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + deduplicated.exercises.length,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "verification-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const verification = validateExactInputExerciseVerification(
    {
      candidates,
      rawVerification,
    },
    {
      minVerifiedExercises: 1,
    },
  );

  if (verification.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: verification.message,
      acceptedCount: verification.verifiedCount,
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-verification",
      message: verification.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  return prisma.$transaction(async (tx) => {
    const currentSkill = await tx.skill.findFirst({
      where: {
        id: skill.id,
        userId: input.userId,
        status: SkillStatus.ACTIVE,
      },
      select: {
        id: true,
        repetitions: true,
        exercises: {
          select: {
            answerKind: true,
            verificationStatus: true,
            retiredAt: true,
            answerSpec: true,
          },
        },
      },
    });

    if (!currentSkill || !isExactInputUnlocked(currentSkill.repetitions)) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill is not ready for exact-input practice.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: currentSkill ? "exact-input-locked" : "skill-not-active",
        message: "Skill is not ready for exact-input practice.",
        generationJobId: generationJob.id,
      };
    }

    const currentInventory = countExactInputExerciseInventory(currentSkill.exercises);

    if (currentInventory.readyExerciseCount >= targetReadyCount) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill already reached the ready exact-input target.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: "already-at-target",
        message: "This skill already has enough ready exact-input exercises.",
        generationJobId: generationJob.id,
        readyExerciseCount: currentInventory.readyExerciseCount,
        targetReadyCount,
      };
    }

    await tx.exercise.createMany({
      data: verification.exercises.map((exercise) => ({
        userId: input.userId,
        skillId: skill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: exercise.answerKind,
        prompt: exercise.prompt,
        choices: Prisma.JsonNull,
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
        rejectedCount:
          validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
        completedAt: input.now,
      },
    });

    return {
      status: "refilled",
      skillId: skill.id,
      generationJobId: generationJob.id,
      exerciseCount: verification.exercises.length,
      readyExerciseCount: currentInventory.readyExerciseCount + verification.exercises.length,
      targetReadyCount,
    };
  });
}

export async function refillMathExercisesForSkill(
  input: RefillMathExercisesInput,
): Promise<MathExerciseRefillResult> {
  const prisma = getPrisma();
  const targetReadyCount = normalizeReadyExerciseTarget(
    input.targetReadyCount,
    DEFAULT_READY_MATH_TARGET,
  );
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
      repetitions: true,
      sourceRefs: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          sourceFile: {
            select: {
              id: true,
              kind: true,
              status: true,
              originalName: true,
              mimeType: true,
              storageBucket: true,
              storageKey: true,
              extractedText: true,
            },
          },
        },
      },
      exercises: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          answerKind: true,
          answerSpec: true,
          verificationStatus: true,
          retiredAt: true,
          prompt: true,
          correctAnswerDisplay: true,
        },
      },
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.ACTIVE) {
    return {
      status: "not-refilled",
      reason: "skill-not-active",
      message: "Only active skills can generate math practice.",
    };
  }

  if (!isExactInputUnlocked(skill.repetitions)) {
    return {
      status: "not-refilled",
      reason: "exact-input-locked",
      message: `Practice multiple-choice reviews first. Math input starts after ${EXACT_INPUT_UNLOCK_REPETITIONS} completed reviews.`,
    };
  }

  const inventory = countMathExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    if (input.generationJobId) {
      const generationJobResult = await failPendingRefillGenerationJob({
        prisma,
        generationJobId: input.generationJobId,
        userId: input.userId,
        skillId: skill.id,
        kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
        message: "Skill already reached the ready math target.",
        now: input.now,
      });

      if (generationJobResult.status === "not-ready") {
        return {
          status: "not-refilled",
          reason: "job-not-pending",
          message: generationJobResult.message,
          generationJobId: input.generationJobId,
          readyExerciseCount: inventory.readyExerciseCount,
          targetReadyCount,
        };
      }
    }

    return {
      status: "not-refilled",
      reason: "already-at-target",
      message: "This skill already has enough ready math exercises.",
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const requestedCount = targetReadyCount - inventory.readyExerciseCount;
  const setup = resolveMathRefillSetup(input);
  const generationJobResult = await createOrClaimRefillGenerationJob({
    prisma,
    generationJobId: input.generationJobId,
    userId: input.userId,
    skillId: skill.id,
    kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
    promptVersion: SKILL_MATH_PROMPT_VERSION,
    setup,
    requestedCount,
    now: input.now,
  });

  if (generationJobResult.status === "not-ready") {
    return {
      status: "not-refilled",
      reason: "job-not-pending",
      message: generationJobResult.message,
      generationJobId: input.generationJobId,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const generationJob = generationJobResult.generationJob;

  if (setup.status === "missing-env") {
    return {
      status: "not-refilled",
      reason: "missing-gemini-env",
      message: setup.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const sourceContext = buildSourceContextExcerpt(
    skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile.extractedText),
  );
  const existingExerciseContext = buildExistingMathExerciseContext(skill.exercises);
  let sourceMedia: SourceMediaContext[];

  try {
    sourceMedia = await resolveSourceMediaContext({
      sourceFiles: skill.sourceRefs.map((sourceRef) => sourceRef.sourceFile),
      sourceMediaLoader: input.sourceMediaLoader,
    });
  } catch (error) {
    const message = buildSourceMediaLoadFailureMessage(error);
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  let rawGeneration: unknown;

  try {
    rawGeneration = await withTimeout(
      setup.generateMathExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
        requestedCount,
      }),
      GENERATION_TIMEOUT_MS,
      "generateMathExercises timed out",
    );
  } catch (error) {
    const message = `Gemini math exercise generation failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: 0,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "generation-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const validation = validateGeneratedMathExercises(rawGeneration, {
    minValidExercises: 1,
    maxGeneratedExercises: requestedCount,
  });

  if (validation.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: validation.message,
      acceptedCount: validation.validCount,
      rejectedCount: validation.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-generation",
      message: validation.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const deduplicated = filterDuplicateMathExercises(validation.exercises, skill.exercises);

  if (deduplicated.exercises.length === 0) {
    const message = "Gemini returned only duplicate math exercises for this skill.";
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount: validation.rejectedCount + deduplicated.duplicateCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "no-new-exercises",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const candidates = toGeneratedMathExerciseCandidates(deduplicated.exercises);
  let rawVerification: unknown;

  try {
    rawVerification = await withTimeout(
      setup.verifyMathExercises({
        skill,
        sourceContext,
        sourceMedia,
        existingExerciseContext,
        candidates,
      }),
      GENERATION_TIMEOUT_MS,
      "verifyMathExercises timed out",
    );
  } catch (error) {
    const message = `Gemini math exercise verification failed: ${formatEnvError(error)}`;
    await markGenerationJobFailed(prisma, generationJob.id, {
      message,
      acceptedCount: 0,
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + deduplicated.exercises.length,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "verification-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  const verification = validateMathExerciseVerification(
    {
      candidates,
      rawVerification,
    },
    {
      minVerifiedExercises: 1,
    },
  );

  if (verification.status === "invalid") {
    await markGenerationJobFailed(prisma, generationJob.id, {
      message: verification.message,
      acceptedCount: verification.verifiedCount,
      rejectedCount:
        validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
      now: input.now,
    });

    return {
      status: "not-refilled",
      reason: "invalid-verification",
      message: verification.message,
      generationJobId: generationJob.id,
      readyExerciseCount: inventory.readyExerciseCount,
      targetReadyCount,
    };
  }

  return prisma.$transaction(async (tx) => {
    const currentSkill = await tx.skill.findFirst({
      where: {
        id: skill.id,
        userId: input.userId,
        status: SkillStatus.ACTIVE,
      },
      select: {
        id: true,
        repetitions: true,
        exercises: {
          select: {
            answerKind: true,
            verificationStatus: true,
            retiredAt: true,
            answerSpec: true,
          },
        },
      },
    });

    if (!currentSkill || !isExactInputUnlocked(currentSkill.repetitions)) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill is not ready for math practice.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: currentSkill ? "exact-input-locked" : "skill-not-active",
        message: "Skill is not ready for math practice.",
        generationJobId: generationJob.id,
      };
    }

    const currentInventory = countMathExerciseInventory(currentSkill.exercises);

    if (currentInventory.readyExerciseCount >= targetReadyCount) {
      await tx.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Skill already reached the ready math target.",
          completedAt: input.now,
        },
      });

      return {
        status: "not-refilled",
        reason: "already-at-target",
        message: "This skill already has enough ready math exercises.",
        generationJobId: generationJob.id,
        readyExerciseCount: currentInventory.readyExerciseCount,
        targetReadyCount,
      };
    }

    await tx.exercise.createMany({
      data: verification.exercises.map((exercise) => ({
        userId: input.userId,
        skillId: skill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.MATH,
        prompt: exercise.prompt,
        choices: Prisma.JsonNull,
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
        rejectedCount:
          validation.rejectedCount + deduplicated.duplicateCount + verification.rejectedCount,
        completedAt: input.now,
      },
    });

    return {
      status: "refilled",
      skillId: skill.id,
      generationJobId: generationJob.id,
      exerciseCount: verification.exercises.length,
      readyExerciseCount: currentInventory.readyExerciseCount + verification.exercises.length,
      targetReadyCount,
    };
  });
}

export function validateGeneratedChoiceExercises(
  input: unknown,
  options: GeneratedChoiceExerciseValidationOptions = {},
): GeneratedChoiceExerciseValidationResult {
  const minValidExercises = options.minValidExercises ?? MIN_ACTIVATION_EXERCISES;
  const maxGeneratedExercises = options.maxGeneratedExercises ?? MAX_GENERATED_EXERCISES;
  const envelopeResult = generatedChoiceEnvelopeSchema(maxGeneratedExercises).safeParse(input);

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

  if (exercises.length < minValidExercises) {
    return invalidGeneratedExercises(
      "too-few-valid-exercises",
      exercises,
      rejectedCount,
      `Gemini returned ${exercises.length} valid exercises; at least ${minValidExercises} are required.`,
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
}, options: ChoiceExerciseVerificationOptions = {}): ChoiceExerciseVerificationResult {
  const minVerifiedExercises = options.minVerifiedExercises ?? MIN_ACTIVATION_EXERCISES;
  const envelopeResult = choiceVerificationEnvelopeSchema(input.candidates.length).safeParse(
    input.rawVerification,
  );

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

  if (verifiedExercises.length < minVerifiedExercises) {
    return invalidChoiceExerciseVerification(
      "too-few-verified-exercises",
      verifiedExercises,
      decisions,
      rejectedCount,
      `Gemini verified ${verifiedExercises.length} exercises; at least ${minVerifiedExercises} are required.`,
    );
  }

  return {
    status: "ready",
    exercises: verifiedExercises,
    decisions,
    rejectedCount,
  };
}

export function validateGeneratedExactInputExercises(
  input: unknown,
  options: GeneratedExactInputExerciseValidationOptions = {},
): GeneratedExactInputExerciseValidationResult {
  const minValidExercises = options.minValidExercises ?? 1;
  const maxGeneratedExercises = options.maxGeneratedExercises ?? MAX_GENERATED_EXERCISES;
  const envelopeResult = generatedExactInputEnvelopeSchema(maxGeneratedExercises).safeParse(input);

  if (!envelopeResult.success) {
    return invalidGeneratedExactInputExercises(
      "invalid-response",
      [],
      0,
      "Gemini returned an invalid exact-input shape.",
    );
  }

  const exercises: GeneratedExactInputExercise[] = [];
  let rejectedCount = 0;

  for (const candidate of envelopeResult.data.exercises) {
    const parsed = parseGeneratedExactInputExercise(candidate);

    if (parsed) {
      exercises.push(parsed);
    } else {
      rejectedCount += 1;
    }
  }

  if (exercises.length < minValidExercises) {
    return invalidGeneratedExactInputExercises(
      "too-few-valid-exercises",
      exercises,
      rejectedCount,
      `Gemini returned ${exercises.length} valid exact-input exercises; at least ${minValidExercises} are required.`,
    );
  }

  return {
    status: "ready",
    exercises,
    rejectedCount,
  };
}

export function validateGeneratedMathExercises(
  input: unknown,
  options: GeneratedMathExerciseValidationOptions = {},
): GeneratedMathExerciseValidationResult {
  const minValidExercises = options.minValidExercises ?? 1;
  const maxGeneratedExercises = options.maxGeneratedExercises ?? MAX_GENERATED_EXERCISES;
  const envelopeResult = generatedMathEnvelopeSchema(maxGeneratedExercises).safeParse(input);

  if (!envelopeResult.success) {
    return invalidGeneratedMathExercises(
      "invalid-response",
      [],
      0,
      "Gemini returned an invalid math exercise shape.",
    );
  }

  const exercises: GeneratedMathExercise[] = [];
  let rejectedCount = 0;

  for (const candidate of envelopeResult.data.exercises) {
    const parsed = parseGeneratedMathExercise(candidate);

    if (parsed) {
      exercises.push(parsed);
    } else {
      rejectedCount += 1;
    }
  }

  if (exercises.length < minValidExercises) {
    return invalidGeneratedMathExercises(
      "too-few-valid-exercises",
      exercises,
      rejectedCount,
      `Gemini returned ${exercises.length} valid math exercises; at least ${minValidExercises} are required.`,
    );
  }

  return {
    status: "ready",
    exercises,
    rejectedCount,
  };
}

export function toGeneratedExactInputExerciseCandidates(
  exercises: GeneratedExactInputExercise[],
): GeneratedExactInputExerciseCandidate[] {
  return exercises.map((exercise, index) => ({
    ...exercise,
    candidateId: `candidate-${index + 1}`,
  }));
}

export function toGeneratedMathExerciseCandidates(
  exercises: GeneratedMathExercise[],
): GeneratedMathExerciseCandidate[] {
  return exercises.map((exercise, index) => ({
    ...exercise,
    candidateId: `candidate-${index + 1}`,
  }));
}

export function validateExactInputExerciseVerification(input: {
  candidates: GeneratedExactInputExerciseCandidate[];
  rawVerification: unknown;
}, options: ExactInputExerciseVerificationOptions = {}): ExactInputExerciseVerificationResult {
  const minVerifiedExercises = options.minVerifiedExercises ?? 1;
  const envelopeResult = choiceVerificationEnvelopeSchema(input.candidates.length).safeParse(
    input.rawVerification,
  );

  if (!envelopeResult.success) {
    return invalidExactInputExerciseVerification(
      "invalid-response",
      [],
      [],
      input.candidates.length,
      "Gemini returned an invalid exact-input verification shape.",
    );
  }

  const expectedCandidateIds = new Set(input.candidates.map((candidate) => candidate.candidateId));
  const seenCandidateIds = new Set<string>();
  const decisions: ExactInputExerciseVerificationDecision[] = [];

  for (const verification of envelopeResult.data.verifications) {
    if (!expectedCandidateIds.has(verification.candidateId)) {
      return invalidExactInputExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini exact-input verification referenced an unknown exercise candidate.",
      );
    }

    if (seenCandidateIds.has(verification.candidateId)) {
      return invalidExactInputExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini exact-input verification returned a duplicate exercise decision.",
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
    return invalidExactInputExerciseVerification(
      "candidate-mismatch",
      [],
      decisions,
      input.candidates.length,
      "Gemini exact-input verification did not decide every exercise candidate.",
    );
  }

  const decisionsByCandidateId = new Map(
    decisions.map((decision) => [decision.candidateId, decision]),
  );
  const verifiedExercises = input.candidates
    .filter((candidate) => decisionsByCandidateId.get(candidate.candidateId)?.verdict === "verified")
    .map(stripGeneratedExactInputExerciseCandidate);
  const rejectedCount = input.candidates.length - verifiedExercises.length;

  if (verifiedExercises.length < minVerifiedExercises) {
    return invalidExactInputExerciseVerification(
      "too-few-verified-exercises",
      verifiedExercises,
      decisions,
      rejectedCount,
      `Gemini verified ${verifiedExercises.length} exact-input exercises; at least ${minVerifiedExercises} are required.`,
    );
  }

  return {
    status: "ready",
    exercises: verifiedExercises,
    decisions,
    rejectedCount,
  };
}

export function validateMathExerciseVerification(input: {
  candidates: GeneratedMathExerciseCandidate[];
  rawVerification: unknown;
}, options: MathExerciseVerificationOptions = {}): MathExerciseVerificationResult {
  const minVerifiedExercises = options.minVerifiedExercises ?? 1;
  const envelopeResult = choiceVerificationEnvelopeSchema(input.candidates.length).safeParse(
    input.rawVerification,
  );

  if (!envelopeResult.success) {
    return invalidMathExerciseVerification(
      "invalid-response",
      [],
      [],
      input.candidates.length,
      "Gemini returned an invalid math verification shape.",
    );
  }

  const expectedCandidateIds = new Set(input.candidates.map((candidate) => candidate.candidateId));
  const seenCandidateIds = new Set<string>();
  const decisions: MathExerciseVerificationDecision[] = [];

  for (const verification of envelopeResult.data.verifications) {
    if (!expectedCandidateIds.has(verification.candidateId)) {
      return invalidMathExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini math verification referenced an unknown exercise candidate.",
      );
    }

    if (seenCandidateIds.has(verification.candidateId)) {
      return invalidMathExerciseVerification(
        "candidate-mismatch",
        [],
        decisions,
        input.candidates.length,
        "Gemini math verification returned a duplicate exercise decision.",
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
    return invalidMathExerciseVerification(
      "candidate-mismatch",
      [],
      decisions,
      input.candidates.length,
      "Gemini math verification did not decide every exercise candidate.",
    );
  }

  const decisionsByCandidateId = new Map(
    decisions.map((decision) => [decision.candidateId, decision]),
  );
  const verifiedExercises = input.candidates
    .filter((candidate) => decisionsByCandidateId.get(candidate.candidateId)?.verdict === "verified")
    .map(stripGeneratedMathExerciseCandidate);
  const rejectedCount = input.candidates.length - verifiedExercises.length;

  if (verifiedExercises.length < minVerifiedExercises) {
    return invalidMathExerciseVerification(
      "too-few-verified-exercises",
      verifiedExercises,
      decisions,
      rejectedCount,
      `Gemini verified ${verifiedExercises.length} math exercises; at least ${minVerifiedExercises} are required.`,
    );
  }

  return {
    status: "ready",
    exercises: verifiedExercises,
    decisions,
    rejectedCount,
  };
}

export function validateGeneratedSkillDrafts(
  input: unknown,
): GeneratedSkillDraftValidationResult {
  const result = generatedSkillDraftEnvelopeSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      reason: "invalid-response",
      message: "Gemini returned invalid skill drafts.",
    };
  }

  const drafts = result.data.drafts;

  return {
    status: "ready",
    drafts: drafts.map((draft) => ({
      title: draft.title,
      objective: draft.objective,
      rules: draft.rules,
      examples: draft.examples,
      exerciseConstraints: draft.exerciseConstraints,
      tags: normalizeTags(draft.tags),
    })),
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

function resolveExactInputRefillSetup(
  input: RefillExactInputExercisesInput,
):
  | {
      status: "ready";
      model: string;
      generateExactInputExercises: ExactInputExerciseGenerator;
      verifyExactInputExercises: ExactInputExerciseVerifier;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    } {
  if (input.generateExactInputExercises) {
    return {
      status: "ready",
      model: input.model ?? "test-generator",
      generateExactInputExercises: input.generateExactInputExercises,
      verifyExactInputExercises:
        input.verifyExactInputExercises ?? createTrustingExactInputExerciseVerifier(),
    };
  }

  try {
    const env = getGeminiEnv();

    return {
      status: "ready",
      model: env.GEMINI_MODEL,
      generateExactInputExercises: createGeminiExactInputExerciseGenerator({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
      }),
      verifyExactInputExercises:
        input.verifyExactInputExercises ??
        createGeminiExactInputExerciseVerifier({
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

function resolveMathRefillSetup(
  input: RefillMathExercisesInput,
):
  | {
      status: "ready";
      model: string;
      generateMathExercises: MathExerciseGenerator;
      verifyMathExercises: MathExerciseVerifier;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    } {
  if (input.generateMathExercises) {
    return {
      status: "ready",
      model: input.model ?? "test-generator",
      generateMathExercises: input.generateMathExercises,
      verifyMathExercises: input.verifyMathExercises ?? createTrustingMathExerciseVerifier(),
    };
  }

  try {
    const env = getGeminiEnv();

    return {
      status: "ready",
      model: env.GEMINI_MODEL,
      generateMathExercises: createGeminiMathExerciseGenerator({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
      }),
      verifyMathExercises:
        input.verifyMathExercises ??
        createGeminiMathExerciseVerifier({
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

  let env: ReturnType<typeof getGeminiEnv>;

  try {
    env = getGeminiEnv();
  } catch (error) {
    return {
      status: "missing-env",
      model: input.model ?? (process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
      message: formatEnvError(error),
    };
  }

  const qwenFallbackResult = resolveOptionalQwenFallbackConfig();
  const qwenFallback =
    qwenFallbackResult.status === "ready" ? qwenFallbackResult.config : null;

  if (qwenFallbackResult.status === "invalid") {
    console.warn("[ai] qwen fallback disabled for skill draft generation", {
      message: qwenFallbackResult.message,
    });
  }

  return {
    status: "ready",
    model: env.GEMINI_MODEL,
    generateSkillDraft: createGeminiSkillDraftGenerator({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      qwenFallback,
    }),
  };
}

export function createGeminiSkillDraftGenerator({
  apiKey,
  model,
  qwenFallback,
}: {
  apiKey: string;
  model: string;
  qwenFallback?: QwenFallbackConfig | null;
}): SkillDraftGenerator {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const qwenFallbackForInput = qwenSkillDraftFallbackForInput(qwenFallback, input);

    return runWithGeminiProviderFallback({
      fallback: qwenFallbackForInput
        ? {
            provider: "qwen",
            model: qwenFallbackForInput.model,
            run: () => createQwenSkillDraftGenerator(qwenFallbackForInput)(input),
          }
        : null,
      operation: "skill draft generation",
      primaryModel: model,
      runPrimary: async () => {
        const response = await ai.models.generateContent({
          model,
          contents: buildGeminiContentsWithSourceMedia(
            buildSourceSkillDraftPrompt(input),
            input.sourceMedia,
          ),
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
      },
    });
  };
}

export function createQwenSkillDraftGenerator({
  apiKey,
  baseUrl,
  model,
}: QwenFallbackConfig): SkillDraftGenerator {
  return async (input) =>
    runQwenJsonChatCompletion({
      apiKey,
      baseUrl,
      model,
      operation: "skill draft generation",
      messages: [
        {
          role: "system",
          content: "You create LearnRecur skill drafts. Return only a valid JSON object.",
        },
        {
          role: "user",
          content: buildQwenSkillDraftUserContent(input),
        },
      ],
    });
}

function qwenSkillDraftFallbackForInput(
  qwenFallback: QwenFallbackConfig | null | undefined,
  input: SkillDraftGeneratorInput,
) {
  if (!qwenFallback) {
    return null;
  }

  if (!input.sourceMedia?.length) {
    return qwenFallback;
  }

  if (input.sourceMedia.every((media) => media.mimeType.startsWith("image/"))) {
    return qwenFallback;
  }

  console.warn("[ai] qwen fallback disabled for non-image source media", {
    mediaMimeTypes: input.sourceMedia.map((media) => media.mimeType),
  });
  return null;
}

function buildQwenSkillDraftUserContent(
  input: SkillDraftGeneratorInput,
): QwenChatMessage["content"] {
  const prompt = buildSourceSkillDraftPrompt(input);

  if (!input.sourceMedia?.length) {
    return prompt;
  }

  if (input.sourceMedia.some((media) => !media.mimeType.startsWith("image/"))) {
    throw new Error("Qwen skill draft generation only supports image source media.");
  }

  return [
    {
      type: "text",
      text: prompt,
    },
    ...input.sourceMedia.map((media) => ({
      type: "image_url" as const,
      image_url: {
        url: buildQwenImageDataUrl(media.bytes, media.mimeType),
      },
    })),
  ];
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
      contents: buildGeminiContentsWithSourceMedia(
        buildChoiceExercisePrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiResponseJsonSchema(input.requestedCount),
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
      contents: buildGeminiContentsWithSourceMedia(
        buildChoiceExerciseVerificationPrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiChoiceVerificationJsonSchema(input.candidates.length),
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function createGeminiExactInputExerciseGenerator({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): ExactInputExerciseGenerator {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildGeminiContentsWithSourceMedia(
        buildExactInputExercisePrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiExactInputResponseJsonSchema(input.requestedCount),
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function createGeminiExactInputExerciseVerifier({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): ExactInputExerciseVerifier {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildGeminiContentsWithSourceMedia(
        buildExactInputExerciseVerificationPrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiExactInputVerificationJsonSchema(input.candidates.length),
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function createGeminiMathExerciseGenerator({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): MathExerciseGenerator {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildGeminiContentsWithSourceMedia(
        buildMathExercisePrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiMathResponseJsonSchema(input.requestedCount),
      },
    });
    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned no text.");
    }

    return JSON.parse(text) as unknown;
  };
}

function createGeminiMathExerciseVerifier({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): MathExerciseVerifier {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildGeminiContentsWithSourceMedia(
        buildMathExerciseVerificationPrompt(input),
        input.sourceMedia,
      ),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: buildGeminiMathVerificationJsonSchema(input.candidates.length),
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

function createTrustingExactInputExerciseVerifier(): ExactInputExerciseVerifier {
  return async (input) => ({
    verifications: input.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      verdict: "verified",
    })),
  });
}

function createTrustingMathExerciseVerifier(): MathExerciseVerifier {
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

function buildGeminiContentsWithSourceMedia(
  prompt: string,
  sourceMedia: SourceMediaContext[] | undefined,
) {
  if (!sourceMedia?.length) {
    return prompt;
  }

  return [
    ...sourceMedia.map((media) => ({
      inlineData: {
        data: media.bytes.toString("base64"),
        mimeType: media.mimeType,
      },
    })),
    {
      text: prompt,
    },
  ];
}

function buildSourceMediaPromptLines(sourceMedia: SourceMediaContext[] | undefined) {
  if (!sourceMedia?.length) {
    return [];
  }

  return [
    "",
    "Original uploaded source media is attached to this request.",
    "Use the attached media as the primary source of truth. Use the extracted text excerpt as a helpful cross-check, not as a replacement for the media.",
    `Attached source media: ${sourceMedia
      .map((media, index) => `${index + 1}. ${media.label} (${media.mimeType})`)
      .join("; ")}`,
  ];
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

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this to match the source style and scope, but do not quote long passages.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing exercises for this skill. Avoid exact prompt and answer repeats.",
      input.existingExerciseContext,
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

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this as the scope boundary for source-backed exercises.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing exercises for duplicate checks. Reject exact prompt and answer repeats.",
      input.existingExerciseContext,
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

function buildExactInputExercisePrompt(input: ExactInputExerciseGeneratorInput): string {
  const prompt = [
    "Generate exact-input practice exercises for LearnRecur.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, or answer keys outside the JSON.",
    `Create exactly ${input.requestedCount} exercises.`,
    "Each exercise must test the skill directly and have an objectively checkable short answer.",
    "Use only TEXT or NUMERIC answer kinds. Do not generate math-expression exercises.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
  ];

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this to match the source style and scope, but do not quote long passages.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing exact-input exercises for this skill. Avoid exact prompt and answer repeats.",
      input.existingExerciseContext,
    );
  }

  prompt.push(
    "",
    "For TEXT answers, answerSpec must be { kind: \"text\", accepted: string[], normalizeCase: true, normalizeWhitespace: true, normalizeDiacritics: true }.",
    "For NUMERIC answers, answerSpec must be { kind: \"numeric\", accepted: number[] or simple numeric strings[], tolerance: number }.",
    "Keep prompts short and make the required answer format obvious.",
    "correctAnswerDisplay should be one concise answer the learner can compare against after checking.",
  );

  return prompt.join("\n");
}

function buildExactInputExerciseVerificationPrompt(input: ExactInputExerciseVerifierInput): string {
  const candidates = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    prompt: candidate.prompt,
    answerKind: candidate.answerKind,
    answerSpec: candidate.answerSpec,
    correctAnswerDisplay: candidate.correctAnswerDisplay,
    explanation: candidate.explanation,
    difficulty: candidate.difficulty,
    expectedSeconds: candidate.expectedSeconds,
  }));

  const prompt = [
    "Verify generated LearnRecur exact-input exercise candidates.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, rewritten exercises, or answer keys outside the JSON.",
    "Be conservative: reject any candidate you are not confident is clear, fair, source-aligned, and objectively answerable.",
    "Return exactly one verification decision for every candidateId, and never invent candidate IDs.",
    "Use verdict verified only when the prompt, answer kind, answer spec, display answer, and explanation all agree.",
    "Reject math-expression exercises; this verifier is only for TEXT and NUMERIC exact input.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
  ];

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this as the scope boundary for source-backed exercises.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing exact-input exercises for duplicate checks. Reject exact prompt and answer repeats.",
      input.existingExerciseContext,
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

function buildMathExercisePrompt(input: MathExerciseGeneratorInput): string {
  const prompt = [
    "Generate math-expression practice exercises for LearnRecur.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, or answer keys outside the JSON.",
    `Create exactly ${input.requestedCount} exercises.`,
    "Each exercise must test the skill directly and have one objectively checkable single-expression answer.",
    "Use only MATH answer kind. Do not generate text, numeric-only, proof, multi-step, diagram, or wordy explanation tasks.",
    "Keep V0 conservative: arithmetic, fractions, powers, variables, simplification, and basic algebraic equivalence only.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
  ];

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this to match the source style and scope, but do not quote long passages.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing math exercises for this skill. Avoid exact prompt and answer repeats.",
      input.existingExerciseContext,
    );
  }

  prompt.push(
    "",
    "answerSpec must be { kind: \"math\", acceptedExpressions: string[], equivalence: \"basic-symbolic\" }.",
    "acceptedExpressions should contain compact plain math expressions like \"2x\", \"x^2+2x+1\", or \"3/4\".",
    "Do not use LaTeX-only commands in acceptedExpressions; prompts may include normal TeX-style display text if needed.",
    "correctAnswerDisplay should be one concise expression the learner can compare against after checking.",
  );

  return prompt.join("\n");
}

function buildMathExerciseVerificationPrompt(input: MathExerciseVerifierInput): string {
  const candidates = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    prompt: candidate.prompt,
    answerKind: candidate.answerKind,
    answerSpec: candidate.answerSpec,
    correctAnswerDisplay: candidate.correctAnswerDisplay,
    explanation: candidate.explanation,
    difficulty: candidate.difficulty,
    expectedSeconds: candidate.expectedSeconds,
  }));

  const prompt = [
    "Verify generated LearnRecur math exercise candidates.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, rewritten exercises, or answer keys outside the JSON.",
    "Be conservative: reject any candidate you are not confident is clear, fair, source-aligned, and objectively answerable.",
    "Return exactly one verification decision for every candidateId, and never invent candidate IDs.",
    "Use verdict verified only when the prompt, math answer spec, display answer, and explanation all agree.",
    "Reject proof, multi-step, diagram, calculus-heavy, ambiguous notation, or answer-shape-mismatched exercises.",
    "",
    `Skill title: ${input.skill.title}`,
    `Skill objective: ${input.skill.objective ?? "No objective provided."}`,
    `Tags: ${input.skill.tags.join(", ") || "none"}`,
    `Rules: ${summarizeJsonNotes(input.skill.rules)}`,
    `Examples: ${summarizeJsonNotes(input.skill.examples)}`,
    `Exercise constraints: ${summarizeJsonNotes(input.skill.exerciseConstraints)}`,
  ];

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  if (input.sourceContext) {
    prompt.push(
      "",
      "Linked source excerpt. Use this as the scope boundary for source-backed exercises.",
      input.sourceContext,
    );
  }

  if (input.existingExerciseContext) {
    prompt.push(
      "",
      "Existing math exercises for duplicate checks. Reject exact prompt and answer repeats.",
      input.existingExerciseContext,
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
  const prompt = [
    "Create one editable LearnRecur skill draft from the user's learning input.",
    "Return only JSON matching the provided response schema.",
    "Do not include markdown, commentary, exercises, or answer keys.",
    "Each skill must be narrow enough to practice with short objective exercises.",
    "The input may be pasted source material or the user's plain-language description of a skill they want to practice.",
    "Return exactly one draft. If the input is broad, choose the clearest narrow skill to practice first.",
    "Use the focus note to constrain which skills are worth drafting.",
    "",
    `Source label: ${input.sourceLabel ?? "Learning input"}`,
    `Focus note: ${input.focusNote ?? "No extra focus note."}`,
    `Collection hint: ${input.collectionName ?? "none"}`,
    `User tags: ${input.tags.join(", ") || "none"}`,
  ];

  prompt.push(...buildSourceMediaPromptLines(input.sourceMedia));

  prompt.push(
    "",
    input.sourceMedia?.length ? "Extracted text excerpt:" : "User input:",
    input.sourceContext,
    "",
    "Response requirements:",
    "- drafts: exactly one draft object.",
    "- title: short and specific for each draft.",
    "- objective: one sentence describing exactly what the learner should practice.",
    "- rules: concise rules or reminders grounded in the input.",
    "- examples: source-style examples, not exercise questions.",
    "- exerciseConstraints: guidance for future exercise generation.",
    "- tags: lowercase topic tags when possible.",
  );

  return prompt.join("\n");
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

export function buildExistingChoiceExerciseContext(
  exercises: Array<{ prompt: string; correctAnswerDisplay: string }>,
): string | null {
  if (exercises.length === 0) {
    return null;
  }

  const context = exercises
    .map(
      (exercise, index) =>
        `${index + 1}. Prompt: ${exercise.prompt.trim()}\nCorrect answer: ${exercise.correctAnswerDisplay.trim()}`,
    )
    .join("\n\n")
    .trim();

  if (!context) {
    return null;
  }

  if (context.length <= EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT) {
    return context;
  }

  const marker = "\n[truncated]";
  return `${context.slice(0, EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT - marker.length).trimEnd()}${marker}`;
}

export function buildExistingExactInputExerciseContext(
  exercises: Array<{
    prompt: string;
    answerKind: AnswerKind;
    answerSpec: Prisma.JsonValue;
    correctAnswerDisplay: string;
  }>,
): string | null {
  const exactExercises = exercises.filter(
    (exercise) => exercise.answerKind === AnswerKind.TEXT || exercise.answerKind === AnswerKind.NUMERIC,
  );

  if (exactExercises.length === 0) {
    return null;
  }

  const context = exactExercises
    .map(
      (exercise, index) =>
        `${index + 1}. Prompt: ${exercise.prompt.trim()}\nAnswer kind: ${exercise.answerKind.toLowerCase()}\nCorrect answer: ${exercise.correctAnswerDisplay.trim()}\nAccepted answer summary: ${summarizeExactAnswerSpec(exercise.answerSpec)}`,
    )
    .join("\n\n")
    .trim();

  if (!context) {
    return null;
  }

  if (context.length <= EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT) {
    return context;
  }

  const marker = "\n[truncated]";
  return `${context.slice(0, EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT - marker.length).trimEnd()}${marker}`;
}

export function buildExistingMathExerciseContext(
  exercises: Array<{
    prompt: string;
    answerKind: AnswerKind;
    answerSpec: Prisma.JsonValue;
    correctAnswerDisplay: string;
  }>,
): string | null {
  const mathExercises = exercises.filter((exercise) => exercise.answerKind === AnswerKind.MATH);

  if (mathExercises.length === 0) {
    return null;
  }

  const context = mathExercises
    .map(
      (exercise, index) =>
        `${index + 1}. Prompt: ${exercise.prompt.trim()}\nCorrect answer: ${exercise.correctAnswerDisplay.trim()}\nAccepted expression summary: ${summarizeMathAnswerSpec(exercise.answerSpec)}`,
    )
    .join("\n\n")
    .trim();

  if (!context) {
    return null;
  }

  if (context.length <= EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT) {
    return context;
  }

  const marker = "\n[truncated]";
  return `${context.slice(0, EXISTING_EXERCISE_CONTEXT_CHAR_LIMIT - marker.length).trimEnd()}${marker}`;
}

export function filterDuplicateChoiceExercises(
  exercises: GeneratedChoiceExercise[],
  existingExercises: Array<{ prompt: string; correctAnswerDisplay: string }>,
): { exercises: GeneratedChoiceExercise[]; duplicateCount: number } {
  const seenKeys = new Set(existingExercises.map(toChoiceExerciseDuplicateKey));
  const filteredExercises: GeneratedChoiceExercise[] = [];
  let duplicateCount = 0;

  for (const exercise of exercises) {
    const key = toChoiceExerciseDuplicateKey(exercise);

    if (seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seenKeys.add(key);
    filteredExercises.push(exercise);
  }

  return {
    exercises: filteredExercises,
    duplicateCount,
  };
}

export function filterDuplicateExactInputExercises(
  exercises: GeneratedExactInputExercise[],
  existingExercises: Array<{
    prompt: string;
    answerKind: AnswerKind;
    answerSpec: Prisma.JsonValue;
    correctAnswerDisplay: string;
  }>,
): { exercises: GeneratedExactInputExercise[]; duplicateCount: number } {
  const seenKeys = new Set(existingExercises.map(toExactInputExerciseDuplicateKey));
  const filteredExercises: GeneratedExactInputExercise[] = [];
  let duplicateCount = 0;

  for (const exercise of exercises) {
    const key = toExactInputExerciseDuplicateKey(exercise);

    if (seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seenKeys.add(key);
    filteredExercises.push(exercise);
  }

  return {
    exercises: filteredExercises,
    duplicateCount,
  };
}

export function filterDuplicateMathExercises(
  exercises: GeneratedMathExercise[],
  existingExercises: Array<{
    prompt: string;
    answerKind: AnswerKind;
    answerSpec: Prisma.JsonValue;
    correctAnswerDisplay: string;
  }>,
): { exercises: GeneratedMathExercise[]; duplicateCount: number } {
  const seenKeys = new Set(existingExercises.map(toMathExerciseDuplicateKey));
  const filteredExercises: GeneratedMathExercise[] = [];
  let duplicateCount = 0;

  for (const exercise of exercises) {
    const key = toMathExerciseDuplicateKey(exercise);

    if (seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seenKeys.add(key);
    filteredExercises.push(exercise);
  }

  return {
    exercises: filteredExercises,
    duplicateCount,
  };
}

export function countChoiceExerciseInventory(
  exercises: ChoiceExerciseInventoryRecord[],
): ChoiceExerciseInventoryCounts {
  return {
    verifiedExerciseCount: exercises.filter(
      (exercise) =>
        exercise.answerKind === AnswerKind.CHOICE &&
        exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
    ).length,
    retiredExerciseCount: exercises.filter(
      (exercise) => exercise.answerKind === AnswerKind.CHOICE && exercise.retiredAt !== null,
    ).length,
    readyExerciseCount: exercises.filter(isReadyChoiceExercise).length,
  };
}

export function isReadyChoiceExercise(exercise: ChoiceExerciseInventoryRecord): boolean {
  return (
    exercise.answerKind === AnswerKind.CHOICE &&
    exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
    exercise.retiredAt === null &&
    choicesSchema.safeParse(exercise.choices).success
  );
}

export function countExactInputExerciseInventory(
  exercises: ExactInputExerciseInventoryRecord[],
): ExactInputExerciseInventoryCounts {
  return {
    verifiedExerciseCount: exercises.filter(
      (exercise) =>
        (exercise.answerKind === AnswerKind.TEXT || exercise.answerKind === AnswerKind.NUMERIC) &&
        exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
    ).length,
    retiredExerciseCount: exercises.filter(
      (exercise) =>
        (exercise.answerKind === AnswerKind.TEXT || exercise.answerKind === AnswerKind.NUMERIC) &&
        exercise.retiredAt !== null,
    ).length,
    readyExerciseCount: exercises.filter(isReadyExactInputExercise).length,
  };
}

export function isReadyExactInputExercise(exercise: ExactInputExerciseInventoryRecord): boolean {
  if (
    exercise.verificationStatus !== ExerciseVerificationStatus.VERIFIED ||
    exercise.retiredAt !== null
  ) {
    return false;
  }

  const answerSpecResult = answerSpecSchema.safeParse(exercise.answerSpec);

  if (!answerSpecResult.success) {
    return false;
  }

  return (
    (exercise.answerKind === AnswerKind.TEXT && answerSpecResult.data.kind === "text") ||
    (exercise.answerKind === AnswerKind.NUMERIC && answerSpecResult.data.kind === "numeric")
  );
}

export function countMathExerciseInventory(
  exercises: MathExerciseInventoryRecord[],
): MathExerciseInventoryCounts {
  return {
    verifiedExerciseCount: exercises.filter(
      (exercise) =>
        exercise.answerKind === AnswerKind.MATH &&
        exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
    ).length,
    retiredExerciseCount: exercises.filter(
      (exercise) => exercise.answerKind === AnswerKind.MATH && exercise.retiredAt !== null,
    ).length,
    readyExerciseCount: exercises.filter(isReadyMathExercise).length,
  };
}

export function isReadyMathExercise(exercise: MathExerciseInventoryRecord): boolean {
  return (
    exercise.answerKind === AnswerKind.MATH &&
    exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
    exercise.retiredAt === null &&
    isUsableMathAnswerSpec(exercise.answerSpec)
  );
}

export function isExactInputUnlocked(repetitions: number): boolean {
  return repetitions >= EXACT_INPUT_UNLOCK_REPETITIONS;
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

async function createGeneratedSkillDraftsForSourceFileInTransaction(
  tx: SkillWriteClient,
  input: CreateGeneratedSkillDraftsForSourceFileInput,
): Promise<
  | {
      status: "created";
      skills: Skill[];
      skillSourceRefIds: string[];
    }
  | {
      status: "not-found";
    }
> {
  const sourceFileWhere = {
    ...input.sourceFileGuard,
    id: input.sourceFileId,
    userId: input.userId,
  };
  const updatedSourceFile = input.sourceFileUpdate
    ? await tx.sourceFile.updateMany({
        where: sourceFileWhere,
        data: input.sourceFileUpdate,
      })
    : await tx.sourceFile.findFirst({
        where: sourceFileWhere,
        select: {
          id: true,
        },
      });

  if (!updatedSourceFile || ("count" in updatedSourceFile && updatedSourceFile.count !== 1)) {
    return {
      status: "not-found",
    };
  }

  const collectionId = await resolveCollectionId(tx, input.userId, input.collectionName);

  await tx.sourceFile.update({
    where: {
      id_userId: {
        id: input.sourceFileId,
        userId: input.userId,
      },
    },
    data: {
      collectionId,
    },
  });

  const skills: Skill[] = [];
  const skillSourceRefIds: string[] = [];

  for (const draft of input.drafts) {
    const skill = await tx.skill.create({
      data: {
        userId: input.userId,
        collectionId,
        title: draft.title,
        objective: draft.objective,
        rules: toNotesJson(draft.rules),
        examples: toNotesJson(draft.examples),
        exerciseConstraints: toConstraintsJson(draft.exerciseConstraints),
        tags: normalizeTags([...input.tags, ...draft.tags]),
        status: SkillStatus.DRAFT,
      },
    });
    const sourceRef = await tx.skillSourceRef.create({
      data: {
        userId: input.userId,
        skillId: skill.id,
        sourceFileId: input.sourceFileId,
        note: input.focusNote,
      },
    });

    skills.push(skill);
    skillSourceRefIds.push(sourceRef.id);
  }

  return {
    status: "created",
    skills,
    skillSourceRefIds,
  };
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

type ActivationGenerationSetup =
  | {
      status: "ready";
      model: string;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    };

type ActivationGenerationJobClient = Pick<Prisma.TransactionClient, "generationJob">;

async function createOrClaimActivationGenerationJob({
  prisma,
  userId,
  skillId,
  setup,
  now,
}: {
  prisma: ActivationGenerationJobClient;
  userId: string;
  skillId: string;
  setup: ActivationGenerationSetup;
  now: Date;
}): Promise<
  | {
      status: "ready";
      generationJob: {
        id: string;
      };
    }
  | {
      status: "not-ready";
      message: string;
      generationJobId?: string;
    }
> {
  const data = {
    kind: GenerationJobKind.SKILL_ACTIVATION,
    status: setup.status === "ready" ? GenerationJobStatus.RUNNING : GenerationJobStatus.FAILED,
    provider: GEMINI_PROVIDER,
    model: setup.model,
    promptVersion: SKILL_MCQ_PROMPT_VERSION,
    requestedCount: REQUESTED_ACTIVATION_EXERCISES,
    acceptedCount: 0,
    rejectedCount: 0,
    errorMessage: setup.status === "ready" ? null : setup.message,
    startedAt: now,
    completedAt: setup.status === "ready" ? null : now,
  };

  const activeJob = await prisma.generationJob.findFirst({
    where: {
      userId,
      skillId,
      kind: GenerationJobKind.SKILL_ACTIVATION,
      status: {
        in: ACTIVE_GENERATION_JOB_STATUSES,
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      updatedAt: true,
    },
  });

  if (activeJob) {
    if (isFreshRunningGenerationJob(activeJob, now)) {
      return {
        status: "not-ready",
        message: "Skill activation is already running. Try again in a minute.",
        generationJobId: activeJob.id,
      };
    }

    const claimed = await prisma.generationJob.updateMany({
      where: {
        id: activeJob.id,
        userId,
        skillId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        updatedAt: activeJob.updatedAt,
        status: {
          in: ACTIVE_GENERATION_JOB_STATUSES,
        },
      },
      data,
    });

    if (claimed.count === 1) {
      return {
        status: "ready",
        generationJob: {
          id: activeJob.id,
        },
      };
    }
  }

  try {
    const generationJob = await prisma.generationJob.create({
      data: {
        userId,
        skillId,
        ...data,
      },
      select: {
        id: true,
      },
    });

    return {
      status: "ready",
      generationJob,
    };
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const existingJob = await prisma.generationJob.findFirst({
      where: {
        userId,
        skillId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: {
          in: ACTIVE_GENERATION_JOB_STATUSES,
        },
      },
      select: {
        id: true,
      },
    });

    return {
      status: "not-ready",
      message: "Skill activation is already running. Try again in a minute.",
      generationJobId: existingJob?.id,
    };
  }
}

function isFreshRunningGenerationJob(
  generationJob: {
    status: GenerationJobStatus;
    startedAt: Date | null;
  },
  now: Date,
) {
  return (
    generationJob.status === GenerationJobStatus.RUNNING &&
    generationJob.startedAt !== null &&
    now.getTime() - generationJob.startedAt.getTime() <
      ACTIVATION_GENERATION_TIMEOUT_MS
  );
}

function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

type RefillGenerationSetup =
  | {
      status: "ready";
      model: string;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    };

type RefillGenerationJobClient = Pick<Prisma.TransactionClient, "generationJob">;

async function createOrClaimRefillGenerationJob({
  prisma,
  generationJobId,
  userId,
  skillId,
  kind,
  promptVersion,
  setup,
  requestedCount,
  now,
}: {
  prisma: RefillGenerationJobClient;
  generationJobId: string | undefined;
  userId: string;
  skillId: string;
  kind: GenerationJobKind;
  promptVersion: string;
  setup: RefillGenerationSetup;
  requestedCount: number;
  now: Date;
}): Promise<
  | {
      status: "ready";
      generationJob: {
        id: string;
      };
    }
  | {
      status: "not-ready";
      message: string;
    }
> {
  const data = {
    userId,
    skillId,
    kind,
    status: setup.status === "ready" ? GenerationJobStatus.RUNNING : GenerationJobStatus.FAILED,
    provider: GEMINI_PROVIDER,
    model: setup.model,
    promptVersion,
    requestedCount,
    errorMessage: setup.status === "ready" ? null : setup.message,
    startedAt: now,
    completedAt: setup.status === "ready" ? null : now,
  };

  if (!generationJobId) {
    const generationJob = await prisma.generationJob.create({
      data,
      select: {
        id: true,
      },
    });

    return {
      status: "ready",
      generationJob,
    };
  }

  const claim = await prisma.generationJob.updateMany({
    where: {
      id: generationJobId,
      userId,
      skillId,
      kind,
      status: GenerationJobStatus.PENDING,
    },
    data,
  });

  if (claim.count === 1) {
    return {
      status: "ready",
      generationJob: {
        id: generationJobId,
      },
    };
  }

  const existingJob = await prisma.generationJob.findFirst({
    where: {
      id: generationJobId,
      userId,
      skillId,
      kind,
    },
    select: {
      status: true,
    },
  });

  return {
    status: "not-ready",
    message: existingJob
      ? `Refill job is already ${existingJob.status.toLowerCase().replaceAll("_", " ")}.`
      : "Refill job was not found or does not belong to this skill.",
  };
}

async function failPendingRefillGenerationJob({
  prisma,
  generationJobId,
  userId,
  skillId,
  kind,
  message,
  now,
}: {
  prisma: RefillGenerationJobClient;
  generationJobId: string;
  userId: string;
  skillId: string;
  kind: GenerationJobKind;
  message: string;
  now: Date;
}): Promise<
  | {
      status: "ready";
    }
  | {
      status: "not-ready";
      message: string;
    }
> {
  const claim = await prisma.generationJob.updateMany({
    where: {
      id: generationJobId,
      userId,
      skillId,
      kind,
      status: GenerationJobStatus.PENDING,
    },
    data: {
      status: GenerationJobStatus.FAILED,
      errorMessage: message,
      startedAt: now,
      completedAt: now,
    },
  });

  if (claim.count === 1) {
    return {
      status: "ready",
    };
  }

  const existingJob = await prisma.generationJob.findFirst({
    where: {
      id: generationJobId,
      userId,
      skillId,
      kind,
    },
    select: {
      status: true,
    },
  });

  return {
    status: "not-ready",
    message: existingJob
      ? `Refill job is already ${existingJob.status.toLowerCase().replaceAll("_", " ")}.`
      : "Refill job was not found or does not belong to this skill.",
  };
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

function parseGeneratedExactInputExercise(candidate: unknown): GeneratedExactInputExercise | null {
  const result = generatedExactInputExerciseSchema.safeParse(candidate);

  if (!result.success) {
    return null;
  }

  const exercise = result.data;
  const answerSpecResult = answerSpecSchema.safeParse(exercise.answerSpec);

  if (!answerSpecResult.success) {
    return null;
  }

  const answerSpec = answerSpecResult.data;

  if (
    (exercise.answerKind === AnswerKind.TEXT && answerSpec.kind !== "text") ||
    (exercise.answerKind === AnswerKind.NUMERIC && answerSpec.kind !== "numeric") ||
    answerSpec.kind === "choice" ||
    answerSpec.kind === "math"
  ) {
    return null;
  }

  if (answerSpec.kind === "numeric" && !hasValidNumericAcceptedValues(answerSpec)) {
    return null;
  }

  return {
    prompt: exercise.prompt,
    answerKind: exercise.answerKind,
    answerSpec,
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation ?? null,
    difficulty: exercise.difficulty ?? null,
    expectedSeconds: exercise.expectedSeconds ?? null,
  };
}

function parseGeneratedMathExercise(candidate: unknown): GeneratedMathExercise | null {
  const result = generatedMathExerciseSchema.safeParse(candidate);

  if (!result.success) {
    return null;
  }

  const exercise = result.data;
  const answerSpecResult = mathAnswerSpecSchema.safeParse(exercise.answerSpec);

  if (!answerSpecResult.success) {
    return null;
  }

  const answerSpec = answerSpecResult.data;

  if (!isUsableMathAnswerSpec(answerSpec)) {
    return null;
  }

  const displayCheck = checkAnswer({
    answerSpec,
    submittedAnswer: exercise.correctAnswerDisplay,
  });

  if (displayCheck.status !== "correct") {
    return null;
  }

  return {
    prompt: exercise.prompt,
    answerKind: AnswerKind.MATH,
    answerSpec,
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation ?? null,
    difficulty: exercise.difficulty ?? null,
    expectedSeconds: exercise.expectedSeconds ?? null,
  };
}

function hasValidNumericAcceptedValues(answerSpec: NumericAnswerSpec): boolean {
  return answerSpec.accepted.every((acceptedValue) => {
    const submittedAnswer = numericAcceptedValueToSubmittedAnswer(acceptedValue);

    if (submittedAnswer === null) {
      return false;
    }

    const result = checkAnswer({
      answerSpec: {
        ...answerSpec,
        accepted: [acceptedValue],
      },
      submittedAnswer,
    });

    return result.status !== "invalid-spec";
  });
}

function numericAcceptedValueToSubmittedAnswer(
  acceptedValue: NumericAnswerSpec["accepted"][number],
): string | number | null {
  if (typeof acceptedValue === "number" || typeof acceptedValue === "string") {
    return acceptedValue;
  }

  if ("numerator" in acceptedValue && "denominator" in acceptedValue) {
    if (acceptedValue.denominator === 0) {
      return null;
    }

    return `${acceptedValue.numerator}/${acceptedValue.denominator}`;
  }

  if (acceptedValue.type === "integer" || acceptedValue.type === "decimal") {
    return acceptedValue.value;
  }

  if ("value" in acceptedValue) {
    return acceptedValue.value;
  }

  return null;
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

function invalidGeneratedExactInputExercises(
  reason: "invalid-response" | "too-few-valid-exercises",
  exercises: GeneratedExactInputExercise[],
  rejectedCount: number,
  message: string,
): Extract<GeneratedExactInputExerciseValidationResult, { status: "invalid" }> {
  return {
    status: "invalid",
    reason,
    message,
    exercises,
    validCount: exercises.length,
    rejectedCount,
  };
}

function invalidGeneratedMathExercises(
  reason: "invalid-response" | "too-few-valid-exercises",
  exercises: GeneratedMathExercise[],
  rejectedCount: number,
  message: string,
): Extract<GeneratedMathExerciseValidationResult, { status: "invalid" }> {
  return {
    status: "invalid",
    reason,
    message,
    exercises,
    validCount: exercises.length,
    rejectedCount,
  };
}

function invalidExactInputExerciseVerification(
  reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises",
  exercises: GeneratedExactInputExercise[],
  decisions: ExactInputExerciseVerificationDecision[],
  rejectedCount: number,
  message: string,
): Extract<ExactInputExerciseVerificationResult, { status: "invalid" }> {
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

function invalidMathExerciseVerification(
  reason: "invalid-response" | "candidate-mismatch" | "too-few-verified-exercises",
  exercises: GeneratedMathExercise[],
  decisions: MathExerciseVerificationDecision[],
  rejectedCount: number,
  message: string,
): Extract<MathExerciseVerificationResult, { status: "invalid" }> {
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
  const { candidateId, ...exercise } = candidate;
  void candidateId;
  return exercise;
}

function stripGeneratedExactInputExerciseCandidate(
  candidate: GeneratedExactInputExerciseCandidate,
): GeneratedExactInputExercise {
  const { candidateId, ...exercise } = candidate;
  void candidateId;
  return exercise;
}

function stripGeneratedMathExerciseCandidate(
  candidate: GeneratedMathExerciseCandidate,
): GeneratedMathExercise {
  const { candidateId, ...exercise } = candidate;
  void candidateId;
  return exercise;
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

function normalizeReadyExerciseTarget(
  targetReadyCount: number | undefined,
  defaultTarget = DEFAULT_READY_EXERCISE_TARGET,
): number {
  if (!targetReadyCount || !Number.isFinite(targetReadyCount)) {
    return defaultTarget;
  }

  return Math.max(1, Math.min(MAX_GENERATED_EXERCISES, Math.floor(targetReadyCount)));
}

function toChoiceExerciseDuplicateKey(exercise: {
  prompt: string;
  correctAnswerDisplay: string;
}): string {
  return `${normalizeDuplicateText(exercise.prompt)}\u0000${normalizeDuplicateText(
    exercise.correctAnswerDisplay,
  )}`;
}

function toExactInputExerciseDuplicateKey(exercise: {
  prompt: string;
  answerKind: AnswerKind;
  answerSpec: Prisma.JsonValue | TextAnswerSpec | NumericAnswerSpec;
  correctAnswerDisplay: string;
}): string {
  return [
    normalizeDuplicateText(exercise.prompt),
    exercise.answerKind,
    normalizeDuplicateText(exercise.correctAnswerDisplay),
    summarizeExactAnswerSpec(exercise.answerSpec),
  ].join("\u0000");
}

function toMathExerciseDuplicateKey(exercise: {
  prompt: string;
  answerKind: AnswerKind;
  answerSpec: Prisma.JsonValue | MathAnswerSpec;
  correctAnswerDisplay: string;
}): string {
  return [
    normalizeDuplicateText(exercise.prompt),
    exercise.answerKind,
    normalizeDuplicateText(exercise.correctAnswerDisplay),
    summarizeMathAnswerSpec(exercise.answerSpec),
  ].join("\u0000");
}

function summarizeExactAnswerSpec(
  answerSpecInput: Prisma.JsonValue | TextAnswerSpec | NumericAnswerSpec,
): string {
  const result = answerSpecSchema.safeParse(answerSpecInput);

  if (!result.success) {
    return "invalid";
  }

  const answerSpec = result.data;

  if (answerSpec.kind === "text") {
    return [
      "text",
      ...answerSpec.accepted.map(normalizeDuplicateText).toSorted(),
      `case:${answerSpec.normalizeCase}`,
      `space:${answerSpec.normalizeWhitespace}`,
      `diacritics:${answerSpec.normalizeDiacritics}`,
    ].join("|");
  }

  if (answerSpec.kind === "numeric") {
    return [
      "numeric",
      ...answerSpec.accepted.map(stableJsonStringify).toSorted(),
      `tolerance:${answerSpec.tolerance}`,
    ].join("|");
  }

  return answerSpec.kind;
}

function summarizeMathAnswerSpec(answerSpecInput: Prisma.JsonValue | MathAnswerSpec): string {
  const result = mathAnswerSpecSchema.safeParse(answerSpecInput);

  if (!result.success) {
    return "invalid";
  }

  return [
    "math",
    ...result.data.acceptedExpressions.map(normalizeDuplicateText).toSorted(),
    `equivalence:${result.data.equivalence}`,
  ].join("|");
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  return `{${Object.entries(value)
    .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
    .join(",")}}`;
}

function normalizeDuplicateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function summarizeJsonNotes(value: Prisma.JsonValue | null): string {
  let summary = "none";

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return summary;
  }

  if ("items" in value && Array.isArray(value.items)) {
    summary = value.items.filter((item) => typeof item === "string").join("; ") || "none";
  } else if ("notes" in value && typeof value.notes === "string") {
    summary = value.notes;
  }

  return truncateForPrompt(summary, PROMPT_NOTE_CHAR_LIMIT);
}

function skillNotFound(): Extract<SkillDraftWriteResult, { status: "not-found" }> &
  Extract<SkillActivationResult, { status: "not-found" }> &
  Extract<SkillExerciseRefillResult, { status: "not-found" }> &
  Extract<ExactInputExerciseRefillResult, { status: "not-found" }> {
  return {
    status: "not-found",
    reason: "skill-not-found",
    message: "No draft skill was found for this user.",
  };
}

function splitNoteLines(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function checkNoteLineBudget(
  value: string,
): { reason: "line-too-long" | "too-many-lines" } | { reason: null } {
  let lineStart = 0;
  let nonEmptyLineCount = 0;

  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value[index] !== "\n") {
      continue;
    }

    const line = value.slice(lineStart, index).trim();
    lineStart = index + 1;

    if (!line) {
      continue;
    }

    if (line.length > MAX_DRAFT_NOTE_LINE_LENGTH) {
      return { reason: "line-too-long" };
    }

    nonEmptyLineCount += 1;

    if (nonEmptyLineCount > MAX_DRAFT_NOTE_ITEMS) {
      return { reason: "too-many-lines" };
    }
  }

  return { reason: null };
}

function splitNotes(value?: string): string[] {
  return splitNoteLines(value);
}

function splitTagParts(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function normalizeTags(value?: string | string[]): string[] {
  const rawTags = Array.isArray(value) ? value : splitTagParts(value ?? "");
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const rawTag of rawTags) {
    const tag = rawTag.trim().toLowerCase();

    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    tags.push(tag);
  }

  return tags.slice(0, MAX_TAGS);
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

type SkillWriteClient = Pick<
  Prisma.TransactionClient,
  "collection" | "skill" | "sourceFile" | "skillSourceRef"
>;
