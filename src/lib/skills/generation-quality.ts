import { z } from "zod";

/**
 * This version is part of every persisted generation-quality decision. Bump it
 * when the meaning of one of these contracts changes, not when a prompt is
 * merely reworded.
 */
export const GENERATION_QUALITY_CONTRACT_VERSION = "generation-quality-v1" as const;

const MAX_IDENTIFIER_LENGTH = 160;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_EVIDENCE_LENGTH = 50;

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const identifierSchema = nonEmptyText(MAX_IDENTIFIER_LENGTH);
const fingerprintSchema = nonEmptyText(MAX_FINGERPRINT_LENGTH);

function uniqueValues<T>(values: T[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueList<T extends z.ZodTypeAny>(itemSchema: T, maximum: number, minimum = 0) {
  return z
    .array(itemSchema)
    .min(minimum)
    .max(maximum)
    .refine(uniqueValues, { message: "Values must be unique." });
}

export const exerciseModeValues = [
  "recall",
  "application",
  "discrimination",
  "transfer",
] as const;

export const exerciseModeSchema = z.enum(exerciseModeValues);
export type ExerciseMode = z.infer<typeof exerciseModeSchema>;

export const answerModeValues = ["choice", "text", "numeric", "math"] as const;
export const answerModeSchema = z.enum(answerModeValues);
export type AnswerMode = z.infer<typeof answerModeSchema>;

const provenanceValues = [
  "learner-source",
  "verified-supplement",
  "pedagogical-transformation",
] as const;

const difficultyDimensionValues = [
  "cueing",
  "surface-complexity",
  "number-complexity",
  "transfer-distance",
  "response-production",
] as const;

const progressionValues = ["fixed", "progressive", "mastery-aware"] as const;

const sourceRequirementSchema = z.strictObject({
  required: z.boolean(),
  minimumEvidenceAnchors: z.number().int().min(0).max(64),
  allowedProvenance: uniqueList(z.enum(provenanceValues), 3, 1),
}).superRefine((requirements, context) => {
  if (requirements.required && requirements.minimumEvidenceAnchors < 1) {
    context.addIssue({
      code: "custom",
      path: ["minimumEvidenceAnchors"],
      message: "Required source material must include at least one evidence anchor.",
    });
  }
});

export type SkillSourceRequirements = z.infer<typeof sourceRequirementSchema>;

const scopeBoundariesSchema = z.strictObject({
  included: uniqueList(nonEmptyText(240), 32, 1),
  excluded: uniqueList(nonEmptyText(240), 32),
});

export type ScopeBoundaries = z.infer<typeof scopeBoundariesSchema>;

const difficultyPolicySchema = z
  .strictObject({
    min: z.number().int().min(1).max(5),
    max: z.number().int().min(1).max(5),
    target: z.number().int().min(1).max(5),
    progression: z.enum(progressionValues),
    dimensions: uniqueList(z.enum(difficultyDimensionValues), 5, 1),
  })
  .superRefine((policy, context) => {
    if (policy.min > policy.max) {
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "Difficulty max must be greater than or equal to min.",
      });
    }

    if (policy.target < policy.min || policy.target > policy.max) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Difficulty target must be within the configured range.",
      });
    }
  });

export type DifficultyPolicy = z.infer<typeof difficultyPolicySchema>;

const explanationPolicySchema = z.strictObject({
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(1_200),
  includeRule: z.boolean(),
  includeDistractorRationale: z.boolean(),
});

export type ExplanationPolicy = z.infer<typeof explanationPolicySchema>;

const ambiguityPolicySchema = z.strictObject({
  action: z.enum(["reject", "manual-review", "request-clarification"]),
  requireSingleDefensibleAnswer: z.boolean(),
  disallowUnstatedAssumptions: z.boolean(),
});

export type AmbiguityPolicy = z.infer<typeof ambiguityPolicySchema>;

/** The immutable, learner-approved target consumed by generation. */
export const skillGenerationSpecSchema = z.strictObject({
  contractVersion: z.literal(GENERATION_QUALITY_CONTRACT_VERSION),
  specVersion: identifierSchema,
  objective: nonEmptyText(1_200),
  observableSuccessCriteria: uniqueList(nonEmptyText(500), 16, 1),
  prerequisiteAssumptions: uniqueList(nonEmptyText(500), 16),
  scopeBoundaries: scopeBoundariesSchema,
  sourceRequirements: sourceRequirementSchema,
  allowedExerciseModes: uniqueList(exerciseModeSchema, exerciseModeValues.length, 1),
  difficultyPolicy: difficultyPolicySchema,
  explanationPolicy: explanationPolicySchema,
  ambiguityPolicy: ambiguityPolicySchema,
  materialFingerprint: fingerprintSchema,
});

export type SkillGenerationSpec = z.infer<typeof skillGenerationSpecSchema>;

const blueprintSourceRequirementsSchema = z
  .strictObject({
    required: z.boolean(),
    evidenceIds: uniqueList(identifierSchema, 64),
  })
  .superRefine((requirements, context) => {
    if (requirements.required && requirements.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Required source evidence must name at least one evidence ID.",
      });
    }
  });

export type BlueprintSourceRequirements = z.infer<typeof blueprintSourceRequirementsSchema>;

const noveltyConstraintsSchema = z.strictObject({
  avoidPromptFingerprints: uniqueList(fingerprintSchema, 64),
  avoidCandidateIds: uniqueList(identifierSchema, 64),
  minimumSurfaceChange: nonEmptyText(240).nullable(),
});

export type NoveltyConstraints = z.infer<typeof noveltyConstraintsSchema>;

const familyConstraintsSchema = z.strictObject({
  allowedFamilies: uniqueList(identifierSchema, 32),
  excludedFamilies: uniqueList(identifierSchema, 32),
  maxSlotsPerFamily: z.number().int().min(1).max(64),
});

export type FamilyConstraints = z.infer<typeof familyConstraintsSchema>;

const evidenceModeSchema = z.enum(["learning-time", "retention"]);

/** One requested exercise coverage slot, before any wording is generated. */
export const blueprintSlotSchema = z.strictObject({
  slotId: identifierSchema,
  mode: exerciseModeSchema,
  targetDifficulty: z.number().int().min(1).max(5),
  misconceptionOrDistractorPurpose: nonEmptyText(500).nullable(),
  answerMode: answerModeSchema,
  sourceRequirements: blueprintSourceRequirementsSchema,
  noveltyConstraints: noveltyConstraintsSchema,
  familyConstraints: familyConstraintsSchema,
  evidenceMode: evidenceModeSchema,
});

export type BlueprintSlot = z.infer<typeof blueprintSlotSchema>;

/** Versioned coverage plan used to select candidates rather than first-valid items. */
export const exerciseBlueprintSchema = z
  .strictObject({
    contractVersion: z.literal(GENERATION_QUALITY_CONTRACT_VERSION),
    blueprintVersion: identifierSchema,
    skillSpecVersion: identifierSchema,
    requestedCount: z.number().int().min(1).max(64),
    slots: z.array(blueprintSlotSchema).min(1).max(64),
  })
  .superRefine((blueprint, context) => {
    const slotIds = blueprint.slots.map((slot) => slot.slotId);
    if (!uniqueValues(slotIds)) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "Blueprint slot IDs must be unique.",
      });
    }

    if (blueprint.requestedCount !== blueprint.slots.length) {
      context.addIssue({
        code: "custom",
        path: ["requestedCount"],
        message: "Requested count must equal the number of coverage slots.",
      });
    }
  });

export type ExerciseBlueprint = z.infer<typeof exerciseBlueprintSchema>;

const privacyClassificationValues = ["public", "private", "sensitive", "restricted"] as const;
export const privacyClassificationSchema = z.enum(privacyClassificationValues);
export type PrivacyClassification = z.infer<typeof privacyClassificationSchema>;

const includedSourceSchema = z.strictObject({
  sourceId: identifierSchema,
  revisionId: identifierSchema.nullable().optional(),
  locator: nonEmptyText(600).nullable().optional(),
  fingerprint: fingerprintSchema,
  charactersIncluded: z.number().int().nonnegative().max(10_000_000),
});

const omittedSourceSchema = z.strictObject({
  sourceId: identifierSchema,
  fingerprint: fingerprintSchema,
  reason: z.enum([
    "outside-requested-scope",
    "low-confidence",
    "unreadable",
    "missing",
    "duplicate",
    "privacy-restricted",
    "not-selected",
    "provider-limit",
  ]),
});

const truncationNoticeSchema = z
  .strictObject({
    field: identifierSchema,
    sourceId: identifierSchema.nullable().optional(),
    originalCharacters: z.number().int().nonnegative().max(10_000_000),
    includedCharacters: z.number().int().nonnegative().max(10_000_000),
    reason: z.enum(["transport-limit", "field-limit", "provider-limit"]),
  })
  .superRefine((notice, context) => {
    if (notice.includedCharacters >= notice.originalCharacters) {
      context.addIssue({
        code: "custom",
        path: ["includedCharacters"],
        message: "A truncation notice must show that content was omitted.",
      });
    }
  });

const sourceFingerprintSchema = z.strictObject({
  sourceId: identifierSchema,
  fingerprint: fingerprintSchema,
});

export type SourceFingerprint = z.infer<typeof sourceFingerprintSchema>;

const fieldLengthAccountingEntrySchema = z
  .strictObject({
    originalCharacters: z.number().int().nonnegative().max(10_000_000),
    includedCharacters: z.number().int().nonnegative().max(10_000_000),
    limitCharacters: z.number().int().positive().max(10_000_000).nullable(),
    truncated: z.boolean(),
  })
  .superRefine((entry, context) => {
    if (entry.includedCharacters > entry.originalCharacters) {
      context.addIssue({
        code: "custom",
        path: ["includedCharacters"],
        message: "Included characters cannot exceed original characters.",
      });
    }

    if (entry.limitCharacters !== null && entry.includedCharacters > entry.limitCharacters) {
      context.addIssue({
        code: "custom",
        path: ["limitCharacters"],
        message: "Included characters cannot exceed the field limit.",
      });
    }

    if (entry.truncated && entry.includedCharacters >= entry.originalCharacters) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "Truncated fields must include fewer characters than the original.",
      });
    }
  });

const fieldLengthAccountingSchema = z.record(
  identifierSchema,
  fieldLengthAccountingEntrySchema,
);

/** Privacy-preserving record of exactly which source evidence reached a stage. */
export const contextManifestSchema = z
  .strictObject({
    contractVersion: z.literal(GENERATION_QUALITY_CONTRACT_VERSION),
    manifestVersion: identifierSchema,
    privacyClassification: privacyClassificationSchema,
    includedSources: z.array(includedSourceSchema).max(64),
    omittedSources: z.array(omittedSourceSchema).max(64),
    truncationNotices: z.array(truncationNoticeSchema).max(64),
    sourceFingerprints: z.array(sourceFingerprintSchema).max(128),
    fieldLengthAccounting: fieldLengthAccountingSchema,
  })
  .superRefine((manifest, context) => {
    const includedIds = manifest.includedSources.map((source) => source.sourceId);
    const omittedIds = manifest.omittedSources.map((source) => source.sourceId);
    const fingerprintIds = manifest.sourceFingerprints.map((source) => source.sourceId);

    if (!uniqueValues(includedIds)) {
      context.addIssue({
        code: "custom",
        path: ["includedSources"],
        message: "Included source IDs must be unique.",
      });
    }

    if (!uniqueValues(omittedIds)) {
      context.addIssue({
        code: "custom",
        path: ["omittedSources"],
        message: "Omitted source IDs must be unique.",
      });
    }

    if (!uniqueValues(fingerprintIds)) {
      context.addIssue({
        code: "custom",
        path: ["sourceFingerprints"],
        message: "Source fingerprint IDs must be unique.",
      });
    }

    const includedOrOmitted = new Set([...includedIds, ...omittedIds]);
    if (includedIds.some((sourceId) => omittedIds.includes(sourceId))) {
      context.addIssue({
        code: "custom",
        path: ["omittedSources"],
        message: "A source cannot be both included and omitted.",
      });
    }

    if (
      fingerprintIds.length !== includedOrOmitted.size ||
      fingerprintIds.some((sourceId) => !includedOrOmitted.has(sourceId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceFingerprints"],
        message: "Every included or omitted source must have one fingerprint entry.",
      });
    }
  });

export type ContextManifest = z.infer<typeof contextManifestSchema>;

export const generationQualityRejectCodeValues = [
  "malformed-candidate",
  "duplicate-choice-id",
  "duplicate-choice-label",
  "correct-choice-missing",
  "correct-choice-id-mismatch",
  "correct-choice-index-mismatch",
  "correct-answer-display-mismatch",
  "explanation-answer-mismatch",
  "invalid-proportion",
  "invalid-confidence-interval",
  "confidence-interval-mismatch",
  "ambiguous-confidence-interval",
  "duplicate-candidate",
  "blueprint-answer-mode-mismatch",
] as const;

export const generationQualityRejectCodeSchema = z.enum(generationQualityRejectCodeValues);
export type GenerationQualityRejectCode = z.infer<typeof generationQualityRejectCodeSchema>;
export const GENERATION_QUALITY_REJECT_CODES = generationQualityRejectCodeValues;

export const candidateQualityStageValues = [
  "contract",
  "answer-contract",
  "semantic-consistency",
  "explanation",
  "ambiguity",
  "novelty",
] as const;

export const candidateQualityStageSchema = z.enum(candidateQualityStageValues);
export type CandidateQualityStage = z.infer<typeof candidateQualityStageSchema>;
export const CANDIDATE_QUALITY_STAGES = candidateQualityStageValues;

const evidenceValueSchema = z.union([z.string().max(240), z.number().finite(), z.boolean()]);

export const qualityEvidenceSchema = z.strictObject({
  code: nonEmptyText(120),
  path: nonEmptyText(240),
  message: nonEmptyText(500),
  observed: z.record(nonEmptyText(80), evidenceValueSchema).optional(),
});

export type QualityEvidence = z.infer<typeof qualityEvidenceSchema>;

const stageOutcomeSchema = z
  .strictObject({
    stage: candidateQualityStageSchema,
    outcome: z.enum(["pass", "fail", "not-run"]),
    reasonCodes: uniqueList(generationQualityRejectCodeSchema, MAX_EVIDENCE_LENGTH),
    evidence: z.array(qualityEvidenceSchema).max(MAX_EVIDENCE_LENGTH),
  })
  .superRefine((stage, context) => {
    if (stage.outcome === "fail" && stage.reasonCodes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "A failed stage must expose at least one reject code.",
      });
    }
  });

export type CandidateStageOutcome = z.infer<typeof stageOutcomeSchema>;

/** Complete, inspectable acceptance record. A model verdict is intentionally not a field. */
export const candidateAcceptanceDecisionSchema = z
  .strictObject({
    contractVersion: z.literal(GENERATION_QUALITY_CONTRACT_VERSION),
    candidateId: identifierSchema,
    accepted: z.boolean(),
    stageOutcomes: z.array(stageOutcomeSchema).min(1).max(candidateQualityStageValues.length),
    rejectCodes: uniqueList(generationQualityRejectCodeSchema, MAX_EVIDENCE_LENGTH),
    evidence: z.array(qualityEvidenceSchema).max(MAX_EVIDENCE_LENGTH),
  })
  .superRefine((decision, context) => {
    const stages = decision.stageOutcomes.map((stage) => stage.stage);
    if (!uniqueValues(stages)) {
      context.addIssue({
        code: "custom",
        path: ["stageOutcomes"],
        message: "Stage outcomes must contain each stage at most once.",
      });
    }

    const hasFailure = decision.stageOutcomes.some((stage) => stage.outcome === "fail");
    const rejectCodeSet = new Set(decision.rejectCodes);
    for (const stage of decision.stageOutcomes) {
      if (
        stage.outcome === "fail" &&
        stage.reasonCodes.some((reasonCode) => !rejectCodeSet.has(reasonCode))
      ) {
        context.addIssue({
          code: "custom",
          path: ["stageOutcomes"],
          message: "Failed-stage reason codes must appear in the decision reject codes.",
        });
        break;
      }
    }

    if (decision.accepted && (decision.rejectCodes.length > 0 || hasFailure)) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "An accepted decision cannot contain reject codes or failed stages.",
      });
    }

    if (!decision.accepted && decision.rejectCodes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["rejectCodes"],
        message: "A rejected decision must expose at least one reject code.",
      });
    }
  });

export type CandidateAcceptanceDecision = z.infer<typeof candidateAcceptanceDecisionSchema>;
export type ChoiceCandidateQualityAssessment = CandidateAcceptanceDecision;
export type QualityRejectCode = GenerationQualityRejectCode;
export const choiceCandidateQualityAssessmentSchema = candidateAcceptanceDecisionSchema;
export const qualityRejectCodeSchema = generationQualityRejectCodeSchema;

const choiceSchema = z.strictObject({
  id: identifierSchema,
  label: nonEmptyText(1_000),
});

const choiceAnswerSpecSchema = z.strictObject({
  kind: z.literal("choice"),
  correctChoiceId: identifierSchema,
});

/**
 * Structural compatibility boundary for the normalized choice candidate already
 * produced by src/lib/skills/index.ts. The optional index and legacy top-level ID
 * are diagnostic-only compatibility fields; the answerSpec remains authoritative.
 */
export const choiceCandidateSchema = z.strictObject({
  candidateId: identifierSchema,
  prompt: nonEmptyText(1_200).refine((prompt) => prompt.length >= 8, {
    message: "Prompt must be at least 8 characters.",
  }),
  choices: z.array(choiceSchema).min(2).max(6),
  answerSpec: choiceAnswerSpecSchema,
  correctAnswerDisplay: nonEmptyText(500),
  explanation: z.string().trim().max(1_200).nullable(),
  difficulty: z.number().int().min(1).max(5).nullable(),
  expectedSeconds: z.number().int().min(5).max(180).nullable(),
  correctChoiceId: identifierSchema.optional(),
  correctChoiceIndex: z.number().int().min(0).max(5).optional(),
});

export type ChoiceCandidateInput = z.infer<typeof choiceCandidateSchema>;
export type ChoiceCandidate = ChoiceCandidateInput;

export type ChoiceCandidateQualityAssessmentOptions = {
  /** Existing or recent candidates used for exact novelty checks. */
  existingCandidates?: readonly unknown[];
  recentCandidates?: readonly unknown[];
  /** If supplied, a non-choice slot is a deterministic contract mismatch. */
  blueprintSlot?: Pick<BlueprintSlot, "answerMode"> | BlueprintSlot;
  /** Accepted for integration compatibility but deliberately ignored. */
  modelDecision?: unknown;
};

export type PromptNumericConsistencyResult = {
  status: "consistent" | "inconsistent";
  applicable: boolean;
  rejectCodes: GenerationQualityRejectCode[];
  evidence: QualityEvidence[];
};

type NumericToken = {
  raw: string;
  value: number;
  explicitPercent: boolean;
  start: number;
  end: number;
};

type ConfidenceInterval = {
  lower: NumericToken;
  upper: NumericToken;
  start: number;
  end: number;
};

type ProportionEstimate = NumericToken & {
  normalizedValue: number;
};

const numericTokenPattern = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const confidenceIntervalPattern = new RegExp(
  `\\b(?:confidence\\s+interval|confidence\\s+band|CI)\\b[^.!?\\n]{0,120}?[\\(\\[]\\s*(${numericTokenPattern}\\s*(?:%|percent|percentage)?)\\s*(?:,|;|\\bto\\b|[-–])\\s*(${numericTokenPattern}\\s*(?:%|percent|percentage)?)\\s*[\\)\\]]`,
  "gi",
);
const textualConfidenceIntervalPattern = new RegExp(
  `\\b(?:confidence\\s+interval|confidence\\s+band|CI)\\b[^.!?\\n]{0,120}?(?:\\bfrom\\b|\\bbetween\\b)\\s*(${numericTokenPattern}\\s*(?:%|percent|percentage)?)\\s*(?:,|;|\\bto\\b|\\band\\b|[-–])\\s*(${numericTokenPattern}\\s*(?:%|percent|percentage)?)`,
  "gi",
);
const numericTokenPatternGlobal = new RegExp(
  `${numericTokenPattern}\\s*(?:%|percent|percentage)?`,
  "gi",
);

const proportionContextPattern =
  /\b(?:proportion|percentage|percent|rate|prevalence|share|probability|support(?:s|ed)?|respondent\w*|volunteer\w*|participant\w*|success|positive)\b/i;

function parseNumericToken(raw: string, start: number): NumericToken | null {
  const match = raw.trim().match(
    new RegExp(`^(${numericTokenPattern})\\s*(%|percent|percentage)?$`, "i"),
  );
  if (!match) {
    return null;
  }

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const explicitPercent = Boolean(match[2]);
  return {
    raw: raw.trim(),
    value: numericValue,
    explicitPercent,
    start,
    end: start + raw.length,
  };
}

function isNumberBoundary(text: string, index: number): boolean {
  return index < 0 || index >= text.length || !/[\w.]/.test(text[index] ?? "");
}

function extractNumericTokens(text: string): NumericToken[] {
  const tokens: NumericToken[] = [];
  for (const match of text.matchAll(numericTokenPatternGlobal)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (!isNumberBoundary(text, start - 1) || !isNumberBoundary(text, start + raw.length)) {
      continue;
    }

    const token = parseNumericToken(raw, start);
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function extractConfidenceIntervals(text: string): ConfidenceInterval[] {
  const intervals: ConfidenceInterval[] = [];
  const addInterval = (match: RegExpMatchArray, matchIndex: number) => {
    const lowerRaw = match[1];
    const upperRaw = match[2];
    if (!lowerRaw || !upperRaw) {
      return;
    }

    const fullMatch = match[0];
    const lowerOffset = fullMatch.indexOf(lowerRaw);
    const upperOffset = fullMatch.lastIndexOf(upperRaw);
    const lower = parseNumericToken(lowerRaw, matchIndex + lowerOffset);
    const upper = parseNumericToken(upperRaw, matchIndex + upperOffset);
    if (!lower || !upper) {
      return;
    }

    intervals.push({
      lower,
      upper,
      start: matchIndex,
      end: matchIndex + fullMatch.length,
    });
  };

  for (const match of text.matchAll(confidenceIntervalPattern)) {
    addInterval(match, match.index ?? 0);
  }

  for (const match of text.matchAll(textualConfidenceIntervalPattern)) {
    const matchIndex = match.index ?? 0;
    const alreadyCaptured = intervals.some(
      (interval) => interval.start === matchIndex && interval.end >= matchIndex + match[0].length,
    );
    if (!alreadyCaptured) {
      addInterval(match, matchIndex);
    }
  }

  return intervals;
}

function tokenIsInsideInterval(token: NumericToken, interval: ConfidenceInterval): boolean {
  return token.start >= interval.lower.start && token.end <= interval.upper.end;
}

function isConfidenceLevelToken(text: string, token: NumericToken): boolean {
  if (!token.explicitPercent) {
    return false;
  }

  const following = text.slice(token.end, token.end + 40);
  const preceding = text.slice(Math.max(0, token.start - 24), token.start);
  return (
    /^\s*(?:confidence\s+interval|confidence\s+level|confidence\b|CI\b)/i.test(following) ||
    /(?:confidence\s+|confidence\s+level\s*)$/i.test(preceding)
  );
}

function isLikelyProportionEstimate(text: string, token: NumericToken): boolean {
  if (isConfidenceLevelToken(text, token)) {
    return false;
  }

  const preceding = text.slice(Math.max(0, token.start - 100), token.start);
  const following = text.slice(token.end, Math.min(text.length, token.end + 100));
  const nearby = `${preceding} ${following}`;
  const hasOfPhrase = /^\s+of\b/i.test(following);

  if (token.explicitPercent) {
    return hasOfPhrase || proportionContextPattern.test(nearby);
  }

  return (
    proportionContextPattern.test(nearby) &&
    (token.value <= 1 || /\b(?:proportion|rate|prevalence|share|probability)\b/i.test(preceding))
  );
}

function sentenceBounds(text: string, index: number): { start: number; end: number } {
  const before = Math.max(
    text.lastIndexOf(".", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
    text.lastIndexOf("\n", index - 1),
  );
  const nextStops = [
    text.indexOf(".", index),
    text.indexOf("!", index),
    text.indexOf("?", index),
    text.indexOf("\n", index),
  ].filter((stop) => stop >= 0);
  return {
    start: before + 1,
    end: nextStops.length > 0 ? Math.min(...nextStops) + 1 : text.length,
  };
}

function sameSentence(text: string, first: number, second: number): boolean {
  const firstBounds = sentenceBounds(text, first);
  return second >= firstBounds.start && second < firstBounds.end;
}

function normalizeProportionToken(token: NumericToken): number {
  return token.explicitPercent ? token.value / 100 : token.value;
}

function normalizeEstimateToken(text: string, token: NumericToken): number {
  if (token.explicitPercent) {
    return token.value / 100;
  }

  const preceding = text.slice(Math.max(0, token.start - 40), token.start);
  if (
    token.value > 1 &&
    token.value <= 100 &&
    /\b(?:percentage|percent)\b/i.test(preceding)
  ) {
    return token.value / 100;
  }

  return token.value;
}

function normalizeInterval(interval: ConfidenceInterval):
  | { lower: number; upper: number }
  | { invalid: true } {
  const hasExplicitPercent = interval.lower.explicitPercent || interval.upper.explicitPercent;
  const lowerRaw = normalizeProportionToken(interval.lower);
  const upperRaw = normalizeProportionToken(interval.upper);
  const unmarkedPercentageInterval =
    !hasExplicitPercent &&
    (lowerRaw > 1 || upperRaw > 1) &&
    lowerRaw >= 0 &&
    upperRaw >= 0 &&
    lowerRaw <= 100 &&
    upperRaw <= 100;
  const lower = unmarkedPercentageInterval ? lowerRaw / 100 : lowerRaw;
  const upper = unmarkedPercentageInterval ? upperRaw / 100 : upperRaw;

  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return { invalid: true };
  }

  if (lower < 0 || upper < 0 || lower > 1 || upper > 1 || lower > upper) {
    return { invalid: true };
  }

  return { lower, upper };
}

function evidence(
  code: string,
  path: string,
  message: string,
  observed?: Record<string, string | number | boolean>,
): QualityEvidence {
  return observed === undefined ? { code, path, message } : { code, path, message, observed };
}

function addUniqueCode(codes: GenerationQualityRejectCode[], code: GenerationQualityRejectCode) {
  if (!codes.includes(code)) {
    codes.push(code);
  }
}

/**
 * Checks only numeric relationships that are explicit enough to be defensible.
 * Unrelated numbers and confidence intervals for means are intentionally left
 * alone rather than guessed to be proportions.
 */
export function assessPromptNumericConsistency(text: string): PromptNumericConsistencyResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      status: "inconsistent",
      applicable: true,
      rejectCodes: ["invalid-proportion"],
      evidence: [evidence("invalid-proportion", "prompt", "Prompt text is missing.")],
    };
  }

  const intervals = extractConfidenceIntervals(text);
  const tokens = extractNumericTokens(text);
  const estimates: ProportionEstimate[] = tokens.flatMap((token) => {
    if (
      intervals.some((interval) => tokenIsInsideInterval(token, interval)) ||
      !isLikelyProportionEstimate(text, token)
    ) {
      return [];
    }

    return [{ ...token, normalizedValue: normalizeEstimateToken(text, token) }];
  });

  const rejectCodes: GenerationQualityRejectCode[] = [];
  const findings: QualityEvidence[] = [];

  for (const estimate of estimates) {
    if (estimate.normalizedValue < 0 || estimate.normalizedValue > 1) {
      addUniqueCode(rejectCodes, "invalid-proportion");
      findings.push(
        evidence(
          "invalid-proportion",
          `prompt[${estimate.start}]`,
          "A proportion or percentage estimate must be between 0 and 1 after normalization.",
          { value: estimate.normalizedValue },
        ),
      );
    }
  }

  let applicable = estimates.length > 0;
  let checkedInterval = false;

  for (const interval of intervals) {
    const intervalContext = text.slice(
      Math.max(0, interval.start - 120),
      Math.min(text.length, interval.end + 120),
    );
    const explicitPercentBounds = interval.lower.explicitPercent || interval.upper.explicitPercent;
    const nearbyEstimates = estimates.filter((estimate) => {
      const candidateInSameSentence = sameSentence(text, interval.start, estimate.start);
      return candidateInSameSentence || Math.abs(estimate.start - interval.start) <= 240;
    });
    const relatedContext = proportionContextPattern.test(intervalContext);

    if (!explicitPercentBounds && !relatedContext && nearbyEstimates.length === 0) {
      continue;
    }

    applicable = true;
    checkedInterval = true;
    const normalizedInterval = normalizeInterval(interval);
    if ("invalid" in normalizedInterval) {
      addUniqueCode(rejectCodes, "invalid-confidence-interval");
      findings.push(
        evidence(
          "invalid-confidence-interval",
          `prompt[${interval.start}]`,
          "A proportion confidence interval must have ordered bounds from 0 to 1 after normalization.",
          {
            lower: normalizeProportionToken(interval.lower),
            upper: normalizeProportionToken(interval.upper),
          },
        ),
      );
      continue;
    }

    if (nearbyEstimates.length > 1) {
      const sameSentenceEstimates = nearbyEstimates.filter((estimate) =>
        sameSentence(text, interval.start, estimate.start),
      );
      if (sameSentenceEstimates.length > 1) {
        addUniqueCode(rejectCodes, "ambiguous-confidence-interval");
        findings.push(
          evidence(
            "ambiguous-confidence-interval",
            `prompt[${interval.start}]`,
            "More than one nearby proportion estimate could refer to this confidence interval.",
          ),
        );
        continue;
      }
    }

    const estimate =
      nearbyEstimates.find((candidate) => sameSentence(text, interval.start, candidate.start)) ??
      (nearbyEstimates.length === 1 ? nearbyEstimates[0] : undefined);
    if (!estimate || estimate.normalizedValue < 0 || estimate.normalizedValue > 1) {
      continue;
    }

    if (
      estimate.normalizedValue < normalizedInterval.lower - Number.EPSILON ||
      estimate.normalizedValue > normalizedInterval.upper + Number.EPSILON
    ) {
      addUniqueCode(rejectCodes, "confidence-interval-mismatch");
      findings.push(
        evidence(
          "confidence-interval-mismatch",
          `prompt[${estimate.start}]`,
          "The stated proportion estimate falls outside its stated confidence interval.",
          {
            estimate: estimate.normalizedValue,
            lower: normalizedInterval.lower,
            upper: normalizedInterval.upper,
          },
        ),
      );
    }
  }

  if (!applicable) {
    return {
      status: "consistent",
      applicable: false,
      rejectCodes: [],
      evidence: [
        evidence(
          "numeric-invariant-not-applicable",
          "prompt",
          "No supported proportion or confidence-interval relationship was detected.",
        ),
      ],
    };
  }

  if (!checkedInterval && estimates.length > 0) {
    findings.push(
      evidence(
        "proportion-range-checked",
        "prompt",
        "Detected proportion or percentage estimates were checked for a valid range.",
      ),
    );
  }

  return {
    status: rejectCodes.length === 0 ? "consistent" : "inconsistent",
    applicable,
    rejectCodes,
    evidence: findings,
  };
}

function normalizeComparisonText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeChoiceLabel(value: string): string {
  return normalizeComparisonText(value).toLocaleLowerCase("en-US");
}

function assessAnswerContract(candidate: ChoiceCandidateInput): {
  rejectCodes: GenerationQualityRejectCode[];
  evidence: QualityEvidence[];
  ambiguityCodes: GenerationQualityRejectCode[];
  ambiguityEvidence: QualityEvidence[];
} {
  const rejectCodes: GenerationQualityRejectCode[] = [];
  const findings: QualityEvidence[] = [];
  const ambiguityCodes: GenerationQualityRejectCode[] = [];
  const ambiguityEvidence: QualityEvidence[] = [];
  const ids = new Set<string>();
  const labels = new Map<string, number>();

  candidate.choices.forEach((choice, index) => {
    if (ids.has(choice.id)) {
      addUniqueCode(rejectCodes, "duplicate-choice-id");
      findings.push(
        evidence(
          "duplicate-choice-id",
          `choices[${index}].id`,
          "Choice IDs must be unique.",
        ),
      );
    }
    ids.add(choice.id);

    const normalizedLabel = normalizeChoiceLabel(choice.label);
    const previousIndex = labels.get(normalizedLabel);
    if (previousIndex !== undefined) {
      addUniqueCode(ambiguityCodes, "duplicate-choice-label");
      ambiguityEvidence.push(
        evidence(
          "duplicate-choice-label",
          `choices[${index}].label`,
          "Answer choices must have distinct labels after conservative text normalization.",
          { firstChoiceIndex: previousIndex, repeatedChoiceIndex: index },
        ),
      );
    } else {
      labels.set(normalizedLabel, index);
    }
  });

  const correctChoiceId = candidate.answerSpec.correctChoiceId;
  const correctChoiceIndex = candidate.choices.findIndex((choice) => choice.id === correctChoiceId);
  const correctChoice = candidate.choices[correctChoiceIndex];

  if (!correctChoice) {
    addUniqueCode(rejectCodes, "correct-choice-missing");
    findings.push(
      evidence(
        "correct-choice-missing",
        "answerSpec.correctChoiceId",
        "The answer spec must reference one of the supplied choice IDs.",
      ),
    );
  }

  if (candidate.correctChoiceId !== undefined && candidate.correctChoiceId !== correctChoiceId) {
    addUniqueCode(rejectCodes, "correct-choice-id-mismatch");
    findings.push(
      evidence(
        "correct-choice-id-mismatch",
        "correctChoiceId",
        "The compatibility answer ID disagrees with answerSpec.correctChoiceId.",
      ),
    );
  }

  if (
    candidate.correctChoiceIndex !== undefined &&
    candidate.choices[candidate.correctChoiceIndex]?.id !== correctChoiceId
  ) {
    addUniqueCode(rejectCodes, "correct-choice-index-mismatch");
    findings.push(
      evidence(
        "correct-choice-index-mismatch",
        "correctChoiceIndex",
        "The zero-based correct choice index must point to answerSpec.correctChoiceId.",
        { expectedIndex: correctChoiceIndex, suppliedIndex: candidate.correctChoiceIndex },
      ),
    );
  }

  if (
    correctChoice &&
    normalizeComparisonText(candidate.correctAnswerDisplay) !==
      normalizeComparisonText(correctChoice.label)
  ) {
    addUniqueCode(rejectCodes, "correct-answer-display-mismatch");
    findings.push(
      evidence(
        "correct-answer-display-mismatch",
        "correctAnswerDisplay",
        "The displayed correct answer must match the referenced choice label.",
      ),
    );
  }

  return {
    rejectCodes,
    evidence: findings,
    ambiguityCodes,
    ambiguityEvidence,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assessExplanationConsistency(candidate: ChoiceCandidateInput): {
  rejectCodes: GenerationQualityRejectCode[];
  evidence: QualityEvidence[];
} {
  if (candidate.explanation === null) {
    return { rejectCodes: [], evidence: [] };
  }

  const references = new Set<string>();
  const explanation = candidate.explanation;
  const choicesByLabel = new Map(
    candidate.choices.map((choice) => [normalizeChoiceLabel(choice.label), choice.id]),
  );

  const quotedReferencePattern =
    /\b(?:the\s+)?(?:correct\s+)?(?:answer|choice|option)\s*(?:is|was|:|=)\s*["“]([^"”\n]{1,300})["”]/gi;
  for (const match of explanation.matchAll(quotedReferencePattern)) {
    const quotedValue = match[1];
    if (!quotedValue) continue;
    const choiceId = choicesByLabel.get(normalizeChoiceLabel(quotedValue));
    if (choiceId) references.add(choiceId);
  }

  for (const choice of candidate.choices) {
    const escapedId = escapeRegExp(choice.id);
    const idPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(?:correct\\s+)?(?:answer|choice|option)\\s*(?:is|was|:|=)\\s*(?:choice|option)\\s+${escapedId}\\b`,
        "i",
      ),
      new RegExp(
        `\\b(?:the\\s+)?(?:correct\\s+)?(?:answer|choice|option)\\s*(?:is|was|:|=)\\s*${escapedId}(?=[.,;!?]|$|\\s+(?:because|since)\\b)`,
        "i",
      ),
      new RegExp(
        `\\b(?:choice|option)\\s+${escapedId}\\s+is\\s+(?:the\\s+)?correct\\b`,
        "i",
      ),
      new RegExp(`\\b(?:choose|select)\\s+(?:(?:choice|option)\\s+)?${escapedId}\\b`, "i"),
    ];
    if (idPatterns.some((pattern) => pattern.test(explanation))) {
      references.add(choice.id);
    }

    const escapedLabel = escapeRegExp(choice.label.trim());
    if (
      escapedLabel.length <= 320 &&
      new RegExp(
        `\\b(?:the\\s+)?(?:correct\\s+)?(?:answer|choice|option)\\s*(?:is|was|:|=)\\s*${escapedLabel}(?=\\b|[.,;!?]|$)`,
        "i",
      ).test(explanation)
    ) {
      references.add(choice.id);
    }
  }

  const rejectCodes: GenerationQualityRejectCode[] = [];
  const findings: QualityEvidence[] = [];
  for (const referencedChoiceId of references) {
    if (referencedChoiceId !== candidate.answerSpec.correctChoiceId) {
      addUniqueCode(rejectCodes, "explanation-answer-mismatch");
      findings.push(
        evidence(
          "explanation-answer-mismatch",
          "explanation",
          "The explanation explicitly names a different choice as the answer.",
        ),
      );
    }
  }

  return { rejectCodes, evidence: findings };
}

function candidateForFingerprint(value: unknown): ChoiceCandidateInput | null {
  const parsed = choiceCandidateSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const withSyntheticId = { ...(value as Record<string, unknown>), candidateId: "existing" };
    const syntheticResult = choiceCandidateSchema.safeParse(withSyntheticId);
    return syntheticResult.success ? syntheticResult.data : null;
  }

  return null;
}

function candidateFingerprint(candidate: ChoiceCandidateInput): string {
  const choices = [...candidate.choices]
    .map((choice) => `${normalizeChoiceLabel(choice.id)}:${normalizeChoiceLabel(choice.label)}`)
    .sort();
  return [
    normalizeChoiceLabel(candidate.prompt),
    choices.join("\u0001"),
    normalizeChoiceLabel(candidate.answerSpec.correctChoiceId),
    normalizeComparisonText(candidate.correctAnswerDisplay),
  ].join("\u0000");
}

function hasPriorDuplicate(
  candidate: ChoiceCandidateInput,
  options: ChoiceCandidateQualityAssessmentOptions,
): boolean {
  const fingerprint = candidateFingerprint(candidate);
  return [...(options.existingCandidates ?? []), ...(options.recentCandidates ?? [])].some(
    (prior) => {
      const parsed = candidateForFingerprint(prior);
      return parsed !== null && candidateFingerprint(parsed) === fingerprint;
    },
  );
}

function candidateIdForDecision(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const candidateId = (input as { candidateId?: unknown }).candidateId;
    if (typeof candidateId === "string" && candidateId.trim().length > 0) {
      return candidateId.trim().slice(0, MAX_IDENTIFIER_LENGTH);
    }
  }
  return "unknown";
}

function stageOutcome(
  stage: CandidateQualityStage,
  outcome: CandidateStageOutcome["outcome"],
  reasonCodes: GenerationQualityRejectCode[],
  findings: QualityEvidence[],
): CandidateStageOutcome {
  return { stage, outcome, reasonCodes: [...new Set(reasonCodes)], evidence: findings };
}

function buildDecision(
  candidateId: string,
  stages: CandidateStageOutcome[],
  rejectCodes: GenerationQualityRejectCode[],
  findings: QualityEvidence[],
): CandidateAcceptanceDecision {
  const boundedStages = stages.map((stage) => ({
    ...stage,
    reasonCodes: stage.reasonCodes.slice(0, MAX_EVIDENCE_LENGTH),
    evidence: stage.evidence.slice(0, MAX_EVIDENCE_LENGTH),
  }));
  const boundedFindings = findings.slice(0, MAX_EVIDENCE_LENGTH);
  const decision = {
    contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    candidateId,
    accepted: rejectCodes.length === 0,
    stageOutcomes: boundedStages,
    rejectCodes: [...new Set(rejectCodes)],
    evidence: boundedFindings,
  } satisfies CandidateAcceptanceDecision;

  return candidateAcceptanceDecisionSchema.parse(decision);
}

function malformedDecision(input: unknown, parseError: z.ZodError): CandidateAcceptanceDecision {
  const findings = parseError.issues.slice(0, MAX_EVIDENCE_LENGTH).map((issue) =>
    evidence(
      "malformed-candidate",
      issue.path.length > 0 ? issue.path.join(".") : "candidate",
      issue.message,
    ),
  );
  const rejectCodes: GenerationQualityRejectCode[] = ["malformed-candidate"];
  return buildDecision(
    candidateIdForDecision(input),
    [
      stageOutcome("contract", "fail", rejectCodes, findings),
      stageOutcome("answer-contract", "not-run", [], []),
      stageOutcome("semantic-consistency", "not-run", [], []),
      stageOutcome("explanation", "not-run", [], []),
      stageOutcome("ambiguity", "not-run", [], []),
      stageOutcome("novelty", "not-run", [], []),
    ],
    rejectCodes,
    findings,
  );
}

/**
 * Deterministically assesses one existing normalized choice candidate. Any
 * model decision supplied through options is deliberately ignored.
 */
export function assessChoiceCandidateQuality(
  input: unknown,
  options: ChoiceCandidateQualityAssessmentOptions = {},
): CandidateAcceptanceDecision {
  const parsed = choiceCandidateSchema.safeParse(input);
  if (!parsed.success) {
    return malformedDecision(input, parsed.error);
  }

  const candidate = parsed.data;
  const rejectCodes: GenerationQualityRejectCode[] = [];
  const findings: QualityEvidence[] = [];
  const stages: CandidateStageOutcome[] = [
    stageOutcome(
      "contract",
      "pass",
      [],
      [evidence("candidate-shape-valid", "candidate", "Candidate matches the normalized choice shape.")],
    ),
  ];

  const answerAssessment = assessAnswerContract(candidate);
  answerAssessment.rejectCodes.forEach((code) => addUniqueCode(rejectCodes, code));
  answerAssessment.ambiguityCodes.forEach((code) => addUniqueCode(rejectCodes, code));
  findings.push(...answerAssessment.evidence, ...answerAssessment.ambiguityEvidence);
  stages.push(
    stageOutcome(
      "answer-contract",
      answerAssessment.rejectCodes.length === 0 ? "pass" : "fail",
      answerAssessment.rejectCodes,
      answerAssessment.evidence,
    ),
    stageOutcome(
      "ambiguity",
      answerAssessment.ambiguityCodes.length === 0 ? "pass" : "fail",
      answerAssessment.ambiguityCodes,
      answerAssessment.ambiguityEvidence,
    ),
  );

  const numericAssessment = assessPromptNumericConsistency(candidate.prompt);
  numericAssessment.rejectCodes.forEach((code) => addUniqueCode(rejectCodes, code));
  findings.push(...numericAssessment.evidence);
  stages.push(
    stageOutcome(
      "semantic-consistency",
      numericAssessment.rejectCodes.length === 0 ? "pass" : "fail",
      numericAssessment.rejectCodes,
      numericAssessment.evidence,
    ),
  );

  const explanationAssessment = assessExplanationConsistency(candidate);
  explanationAssessment.rejectCodes.forEach((code) => addUniqueCode(rejectCodes, code));
  findings.push(...explanationAssessment.evidence);
  stages.push(
    stageOutcome(
      "explanation",
      explanationAssessment.rejectCodes.length === 0 ? "pass" : "fail",
      explanationAssessment.rejectCodes,
      explanationAssessment.evidence.length > 0
        ? explanationAssessment.evidence
        : candidate.explanation === null
          ? []
          : [
              evidence(
                "explanation-no-deterministic-contradiction",
                "explanation",
                "No explicit answer contradiction was deterministically identified.",
              ),
            ],
    ),
  );

  if (options.blueprintSlot && options.blueprintSlot.answerMode !== "choice") {
    addUniqueCode(rejectCodes, "blueprint-answer-mode-mismatch");
    const blueprintEvidence = evidence(
      "blueprint-answer-mode-mismatch",
      "blueprintSlot.answerMode",
      "A choice candidate cannot fill a non-choice blueprint slot.",
    );
    findings.push(blueprintEvidence);
    stages.push(stageOutcome("novelty", "fail", ["blueprint-answer-mode-mismatch"], [blueprintEvidence]));
  } else if (hasPriorDuplicate(candidate, options)) {
    addUniqueCode(rejectCodes, "duplicate-candidate");
    const duplicateEvidence = evidence(
      "duplicate-candidate",
      "candidate",
      "Candidate matches an existing or recent choice candidate after conservative normalization.",
    );
    findings.push(duplicateEvidence);
    stages.push(stageOutcome("novelty", "fail", ["duplicate-candidate"], [duplicateEvidence]));
  } else if (options.existingCandidates || options.recentCandidates) {
    stages.push(
      stageOutcome(
        "novelty",
        "pass",
        [],
        [evidence("novelty-checked", "candidate", "No exact prior candidate fingerprint matched.")],
      ),
    );
  } else {
    stages.push(stageOutcome("novelty", "not-run", [], []));
  }

  return buildDecision(candidate.candidateId, stages, rejectCodes, findings);
}

export type ChoiceCandidateBatchAssessment = {
  decisions: CandidateAcceptanceDecision[];
  acceptedCandidates: ChoiceCandidateInput[];
  rejectedCandidates: unknown[];
};

/** Assesses a batch while applying exact novelty checks against earlier candidates. */
export function assessChoiceCandidatesQuality(
  inputs: readonly unknown[],
  options: ChoiceCandidateQualityAssessmentOptions = {},
): ChoiceCandidateBatchAssessment {
  const decisions: CandidateAcceptanceDecision[] = [];
  const acceptedCandidates: ChoiceCandidateInput[] = [];
  const rejectedCandidates: unknown[] = [];

  for (const input of inputs) {
    const decision = assessChoiceCandidateQuality(input, {
      ...options,
      existingCandidates: [...(options.existingCandidates ?? []), ...acceptedCandidates],
    });
    decisions.push(decision);
    if (decision.accepted) {
      const parsed = choiceCandidateSchema.safeParse(input);
      if (parsed.success) {
        acceptedCandidates.push(parsed.data);
      }
    } else {
      rejectedCandidates.push(input);
    }
  }

  return { decisions, acceptedCandidates, rejectedCandidates };
}

// Short aliases keep the contract easy to discover without creating separate behavior.
export const assessChoiceCandidate = assessChoiceCandidateQuality;
export const assessChoiceCandidates = assessChoiceCandidatesQuality;
export const checkPromptNumericConsistency = assessPromptNumericConsistency;
