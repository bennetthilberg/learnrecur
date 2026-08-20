import { createHash } from "node:crypto";

import { z } from "zod";

import {
  checkAnswer,
  isUsableMathAnswerSpec,
  type AnswerSpec,
  type Choice,
} from "@/lib/answer-checking";

export const AGENT_OPERATION_POLL_AFTER_MS = 3_000;
export const AGENT_MAX_BATCH_ITEMS = 10;
export const AGENT_MAX_CANDIDATE_EXERCISES = 5;
export const AGENT_MAX_NONTERMINAL_ITEMS_PER_USER = 10;

const idSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const clientReferenceSchema = z.string().trim().min(1).max(80);
const titleSchema = z.string().trim().min(1).max(120);
const objectiveSchema = z.string().trim().min(12).max(1_200);
const guidanceLineSchema = z.string().trim().min(1).max(500);
const guidanceLinesSchema = z.array(guidanceLineSchema).max(8).default([]);
const exerciseConstraintsSchema = z.string().trim().max(1_000).default("");
const tagSchema = z.string().trim().min(1).max(40);
const tagsSchema = z.array(tagSchema).max(12).default([]).superRefine(uniqueStrings("Tags"));
const collectionSchema = z.string().trim().min(1).max(120).optional();
const promptSchema = z.string().trim().min(8).max(1_200);
const explanationSchema = z.string().trim().min(1).max(1_200).optional();
const difficultySchema = z.number().int().min(1).max(5).optional();
const expectedSecondsSchema = z.number().int().min(5).max(180).optional();

const commonCandidateFields = {
  clientReference: clientReferenceSchema.optional(),
  prompt: promptSchema,
  explanation: explanationSchema,
  difficulty: difficultySchema,
  expectedSeconds: expectedSecondsSchema,
};

const choiceCandidateSchema = z
  .strictObject({
    kind: z.literal("choice"),
    ...commonCandidateFields,
    choices: z
      .array(
        z.strictObject({
          id: z.string().trim().min(1).max(80),
          label: z.string().trim().min(1).max(500),
        }),
      )
      .min(3)
      .max(5),
    correctChoiceId: z.string().trim().min(1).max(80),
  })
  .superRefine((value, context) => {
    const ids = value.choices.map((choice) => choice.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choice IDs must be unique.",
      });
    }
    if (!ids.includes(value.correctChoiceId)) {
      context.addIssue({
        code: "custom",
        path: ["correctChoiceId"],
        message: "The correct choice ID must identify an available choice.",
      });
    }
  });

const textCandidateSchema = z.strictObject({
  kind: z.literal("text"),
  ...commonCandidateFields,
  acceptedAnswers: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(8)
    .superRefine(uniqueStrings("Accepted answers")),
  normalization: z
    .strictObject({
      case: z.boolean().default(true),
      whitespace: z.boolean().default(true),
      diacritics: z.boolean().default(true),
    })
    .default({ case: true, whitespace: true, diacritics: true }),
  displayAnswer: z.string().trim().min(1).max(500).optional(),
});

const numericAnswerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+|\d+\s*\/\s*[+-]?\d+)$/.test(value), {
    message: "Numeric answers must be a decimal, integer, or fraction without exponent notation.",
  })
  .refine((value) => !/\/\s*[+-]?0+$/.test(value), {
    message: "Numeric fractions cannot have a denominator of zero.",
  });

const numericCandidateSchema = z.strictObject({
  kind: z.literal("numeric"),
  ...commonCandidateFields,
  acceptedAnswers: z
    .array(numericAnswerSchema)
    .min(1)
    .max(8)
    .superRefine(uniqueStrings("Accepted answers")),
  tolerance: z.number().finite().min(0).max(1).default(0.001),
  displayAnswer: numericAnswerSchema.optional(),
});

const mathCandidateSchema = z.strictObject({
  kind: z.literal("math"),
  ...commonCandidateFields,
  acceptedExpressions: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(4)
    .superRefine(uniqueStrings("Accepted expressions")),
  equivalence: z.literal("basic-symbolic").default("basic-symbolic"),
  displayAnswer: z.string().trim().min(1).max(500).optional(),
});

export const agentCandidateExerciseSchema = z.discriminatedUnion("kind", [
  choiceCandidateSchema,
  textCandidateSchema,
  numericCandidateSchema,
  mathCandidateSchema,
]);

export type AgentCandidateExercise = z.infer<typeof agentCandidateExerciseSchema>;

export const agentSkillSpecSchema = z.strictObject({
  title: titleSchema,
  objective: objectiveSchema,
  rules: guidanceLinesSchema,
  examples: guidanceLinesSchema,
  exerciseConstraints: exerciseConstraintsSchema,
  tags: tagsSchema,
  collection: collectionSchema,
});

const candidateListSchema = z
  .array(agentCandidateExerciseSchema)
  .min(1)
  .max(AGENT_MAX_CANDIDATE_EXERCISES)
  .superRefine((candidates, context) => {
    const references = candidates.flatMap((candidate) =>
      candidate.clientReference ? [candidate.clientReference] : [],
    );
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: "custom",
        message: "Candidate client references must be unique.",
      });
    }
  })
  .optional();

export const agentAddFromSpecsSchema = z
  .strictObject({
    idempotency_key: idempotencyKeySchema,
    items: z
      .array(
        z.strictObject({
          client_reference: clientReferenceSchema,
          skill: agentSkillSpecSchema,
          candidate_exercises: candidateListSchema,
        }),
      )
      .min(1)
      .max(AGENT_MAX_BATCH_ITEMS),
  })
  .superRefine((value, context) => {
    const references = value.items.map((item) => item.client_reference);
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item client references must be unique.",
      });
    }
  });

export const agentAddFromTextSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  source_text: z.string().trim().min(12).max(12_000),
  intent: z.string().trim().min(12).max(800),
  source_label: z.string().trim().min(1).max(160).optional(),
  collection: collectionSchema,
  tags: tagsSchema,
  candidate_exercises: candidateListSchema,
});

export const agentAddFromMaterialSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  material_id: idSchema,
  expected_revision_id: idSchema,
  instruction: z.string().trim().min(3).max(4_000),
  section_ids: z
    .array(idSchema)
    .max(24)
    .superRefine(uniqueStrings("Section IDs"))
    .optional(),
  max_skills: z.number().int().min(1).max(10).default(10),
});

const fileSchema = z.strictObject({
  name: z.string().trim().min(1).max(220),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp", "application/pdf"]),
  size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
});

export const agentPrepareFilesSchema = z
  .strictObject({
    idempotency_key: idempotencyKeySchema,
    intent: z.string().trim().min(12).max(800),
    source_label: z.string().trim().min(1).max(160).optional(),
    collection: collectionSchema,
    tags: tagsSchema,
    files: z.array(fileSchema).min(1).max(5),
    candidate_exercises: candidateListSchema,
  })
  .superRefine((value, context) => {
    if (value.files.reduce((total, file) => total + file.size_bytes, 0) > 20 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Combined source files cannot exceed 20 MiB.",
      });
    }
  });

export const agentStartFilesSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  operation_id: idSchema,
});

export const agentListMaterialsSchema = z.strictObject({
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const agentGetMaterialOutlineSchema = z.strictObject({
  material_id: idSchema,
  expected_revision_id: idSchema.optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const agentSearchMaterialExcerptsSchema = z.strictObject({
  material_id: idSchema,
  expected_revision_id: idSchema,
  query: z.string().trim().min(3).max(500),
  section_ids: z
    .array(idSchema)
    .max(24)
    .superRefine(uniqueStrings("Section IDs"))
    .optional(),
  limit: z.number().int().min(1).max(5).default(3),
});

export const agentGetOperationSchema = z.strictObject({ operation_id: idSchema });

export const agentContinueOperationSchema = z.strictObject({
  operation_id: idSchema,
  idempotency_key: idempotencyKeySchema,
  instruction: z.string().trim().min(3).max(4_000),
});

export const agentRetryOperationSchema = z.strictObject({
  operation_id: idSchema,
  idempotency_key: idempotencyKeySchema,
  item_ids: z
    .array(idSchema)
    .min(1)
    .max(10)
    .superRefine(uniqueStrings("Item IDs"))
    .optional(),
});

export type NormalizedAgentCandidateExercise = {
  candidateId: string;
  clientReference: string | null;
  type: "MULTIPLE_CHOICE" | "EXACT_INPUT";
  answerKind: "CHOICE" | "TEXT" | "NUMERIC" | "MATH";
  prompt: string;
  choices: Choice[] | null;
  answerSpec: AnswerSpec;
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

export function normalizeAgentCandidateExercise(
  candidate: AgentCandidateExercise,
  index: number,
): NormalizedAgentCandidateExercise {
  const common = {
    candidateId: `candidate-${index + 1}`,
    clientReference: candidate.clientReference ?? null,
    prompt: candidate.prompt,
    explanation: candidate.explanation ?? null,
    difficulty: candidate.difficulty ?? null,
    expectedSeconds: candidate.expectedSeconds ?? null,
  };

  if (candidate.kind === "choice") {
    const correct = candidate.choices.find((choice) => choice.id === candidate.correctChoiceId);
    if (!correct) throw new Error("The correct choice is missing.");
    const answerSpec = { kind: "choice" as const, correctChoiceId: candidate.correctChoiceId };
    assertSelfChecks(answerSpec, candidate.choices, candidate.correctChoiceId);
    return {
      ...common,
      type: "MULTIPLE_CHOICE",
      answerKind: "CHOICE",
      choices: candidate.choices,
      answerSpec,
      correctAnswerDisplay: correct.label,
    };
  }

  if (candidate.kind === "text") {
    const answerSpec = {
      kind: "text" as const,
      accepted: candidate.acceptedAnswers,
      normalizeCase: candidate.normalization.case,
      normalizeWhitespace: candidate.normalization.whitespace,
      normalizeDiacritics: candidate.normalization.diacritics,
    };
    const display = candidate.displayAnswer ?? candidate.acceptedAnswers[0];
    assertSelfChecks(answerSpec, undefined, display);
    return {
      ...common,
      type: "EXACT_INPUT",
      answerKind: "TEXT",
      choices: null,
      answerSpec,
      correctAnswerDisplay: display,
    };
  }

  if (candidate.kind === "numeric") {
    const answerSpec = {
      kind: "numeric" as const,
      accepted: candidate.acceptedAnswers,
      tolerance: candidate.tolerance,
    };
    const display = candidate.displayAnswer ?? candidate.acceptedAnswers[0];
    assertSelfChecks(answerSpec, undefined, display);
    return {
      ...common,
      type: "EXACT_INPUT",
      answerKind: "NUMERIC",
      choices: null,
      answerSpec,
      correctAnswerDisplay: display,
    };
  }

  const answerSpec = {
    kind: "math" as const,
    acceptedExpressions: candidate.acceptedExpressions,
    equivalence: candidate.equivalence,
  };
  if (!isUsableMathAnswerSpec(answerSpec)) {
    throw new Error("Accepted math expressions are not usable.");
  }
  const display = candidate.displayAnswer ?? candidate.acceptedExpressions[0];
  assertSelfChecks(answerSpec, undefined, display);
  return {
    ...common,
    type: "EXACT_INPUT",
    answerKind: "MATH",
    choices: null,
    answerSpec,
    correctAnswerDisplay: display,
  };
}

export function buildAgentPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function buildAgentCandidateDuplicateKey(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return buildAgentPayloadHash({
    type: record.type,
    answerKind: record.answerKind,
    prompt:
      typeof record.prompt === "string"
        ? record.prompt.normalize("NFKC").trim().toLocaleLowerCase("en-US")
        : record.prompt,
    choices: record.choices,
    answerSpec: record.answerSpec,
  });
}

function assertSelfChecks(answerSpec: AnswerSpec, choices: unknown, displayAnswer: string) {
  const result = checkAnswer({ answerSpec, choices, submittedAnswer: displayAnswer });
  if (!result.isCorrect) {
    throw new Error("The candidate display answer does not self-check against its answer key.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function uniqueStrings(label: string) {
  return (values: string[], context: z.RefinementCtx) => {
    const normalized = values.map((value) => value.trim().toLocaleLowerCase("en-US"));
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", message: `${label} must be unique.` });
    }
  };
}
