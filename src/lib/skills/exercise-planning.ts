/**
 * Deterministic retrieval planning lives here so generation can decide what
 * evidence an exercise should produce before a provider is asked to word it.
 *
 * The versioned SkillGenerationSpec and ExerciseBlueprint contracts are kept
 * in generation-quality.ts. Planner-specific metadata remains structural so
 * this module can add memory and diversity decisions without making provider
 * or database calls.
 */

import type {
  AnswerMode as SharedAnswerMode,
  BlueprintSlot as SharedBlueprintSlot,
  ExerciseBlueprint as SharedExerciseBlueprint,
} from "@/lib/skills/generation-quality";
import { GENERATION_QUALITY_CONTRACT_VERSION } from "@/lib/skills/generation-quality";

export const EXERCISE_PLANNING_VERSION = "exercise-planning-v1" as const;
export const MAX_BLUEPRINT_SLOTS = 10;
export const MAX_RECENT_EXERCISES_CONSIDERED = 100;

export type FsrsStateInput = "NEW" | "LEARNING" | "REVIEW" | "RELEARNING" | string;
export type FsrsRatingInput =
  | "AGAIN"
  | "HARD"
  | "GOOD"
  | "EASY"
  | string
  | { rating?: string; value?: string };
export type AnswerMode = SharedAnswerMode;

export type SubjectCapabilityId =
  | "symbolic_numeric"
  | "language_form"
  | "conceptual_source_grounded"
  | "unsupported";

export type SubjectCapabilityProfile = {
  id: SubjectCapabilityId | string;
  allowedAnswerModes?: readonly string[];
  preferredAnswerModes?: readonly string[];
  allowedExerciseFamilies?: readonly string[];
  blockedExerciseFamilies?: readonly string[];
  variationDimensions?: readonly string[];
  commonFailureModes?: readonly string[];
  publicationPolicy?: "automatic" | "manual_review";
};

export type ScopeBoundary = {
  included?: readonly string[];
  excluded?: readonly string[];
};

export type SourceRequirement = {
  required?: boolean;
  anchors?: readonly string[];
  evidenceIds?: readonly string[];
  sourceRevisionIds?: readonly string[];
  minimumEvidenceAnchors?: number;
  allowedProvenance?: readonly string[];
  allowVerifiedSupplement?: boolean;
};

/** Optional planner extensions accepted alongside the shared spec contract. */
type PlannerSkillGenerationFields = {
  contractVersion?: string;
  skillId?: string;
  id?: string;
  specVersion?: string;
  version?: string;
  fingerprint?: string | null;
  skillSpecFingerprint?: string | null;
  materialFingerprint?: string | null;
  sourceRevisionId?: string | null;
  title?: string;
  objective?: string;
  observableSuccessCriteria?: readonly string[];
  prerequisiteAssumptions?: readonly string[];
  prerequisites?: readonly string[];
  scope?: ScopeBoundary | string | null;
  scopeBoundaries?: ScopeBoundary | string | null;
  allowedAnswerModes?: readonly string[];
  allowedExerciseModes?: readonly string[];
  answerModes?: readonly string[];
  sourceRequirements?: SourceRequirement | string | null;
  misconceptions?: readonly string[];
  commonMisconceptions?: readonly string[];
  allowedExerciseFamilies?: readonly string[];
  subjectCapability?: SubjectCapabilityId | SubjectCapabilityProfile | string;
  difficultyPolicy?: unknown;
  explanationPolicy?: unknown;
  ambiguityPolicy?: unknown;
};

export type SkillGenerationSpecInput = PlannerSkillGenerationFields & {
  [key: string]: unknown;
};
export type SkillGenerationSpec = SkillGenerationSpecInput;

/**
 * The memory inputs are intentionally scalar or derived summaries. Callers
 * should not pass raw learner answers or private source material here.
 */
export type GenerationProfile = {
  fsrsState?: FsrsStateInput;
  state?: FsrsStateInput;
  dueAt?: Date | string | number | null;
  due?: Date | string | number | null;
  dueInSeconds?: number | null;
  dueInMs?: number | null;
  now?: Date | string | number | null;
  lapses?: number;
  repetitions?: number;
  reps?: number;
  recentRatings?: readonly FsrsRatingInput[];
  ratings?: readonly FsrsRatingInput[];
  desiredCount?: number;
  count?: number;
  supportedAnswerModes?: readonly string[];
  answerModes?: readonly string[];
  subjectCapability?: SubjectCapabilityId | SubjectCapabilityProfile | string;
  capability?: SubjectCapabilityId | SubjectCapabilityProfile | string;
  stability?: number | null;
  lastReviewedAt?: Date | string | number | null;
  recentIndependentReviews?: number;
  independentReviews?: number;
  recentAssistedAttempts?: number;
  assistedAttempts?: number;
  desiredDifficulty?: number | null;
  desiredExerciseMix?: Readonly<Record<string, number>>;
  learningTime?: boolean;
  [key: string]: unknown;
};

export type RecentExercise = {
  id?: string | null;
  exerciseId?: string | null;
  family?: string | null;
  exerciseFamily?: string | null;
  retrievalStage?: string | null;
  stage?: string | null;
  answerMode?: string | null;
  answerKind?: string | null;
  surfaceFeatures?: readonly string[] | string | null;
  freshnessKey?: string | null;
  prompt?: string | null;
  fingerprint?: string | null;
  contentFingerprint?: string | null;
  createdAt?: Date | string | number | null;
  retired?: boolean;
  status?: string | null;
  evidence?: string | null;
  [key: string]: unknown;
};

export type RetrievalStage =
  | "recognition"
  | "cued_recall"
  | "exact_recall"
  | "application"
  | "interleaved_discrimination"
  | "delayed_transfer";

export type CognitiveOperation =
  | "recall"
  | "application"
  | "discrimination"
  | "transfer";

export type EvidenceMode = "learning-time" | "retention";
export type EvidenceClass = "learning" | "independent_retention";
export type AssistancePolicy = "optional_scaffold" | "none";

export type GenerationReasonCode =
  | "new_or_uncertain"
  | "retention_progression"
  | "lapse_recovery"
  | "due_now"
  | "due_soon"
  | "due_not_yet"
  | "due_unknown"
  | "answer_mode_intersection"
  | "no_supported_answer_mode"
  | "unsupported_subject_capability"
  | "subject_capability_constraint"
  | "count_clamped"
  | "recent_family_avoidance"
  | "family_diversity"
  | "independent_retention"
  | "assisted_learning"
  | "interleaving"
  | "transfer_eligible"
  | "source_anchor_required"
  | "source_evidence_missing"
  | "no_allowed_exercise_mode"
  | "manual_review_required"
  | "fingerprints_unchanged"
  | "initial_spec"
  | "material_changed"
  | "material_fingerprint_changed"
  | "source_revision_changed"
  | "spec_fingerprint_changed"
  | "scope_changed"
  | "retrieval_target_changed"
  | "spec_version_changed"
  | "duplicate_candidate"
  | "duplicate_candidate_id"
  | "recent_duplicate"
  | "missing_family"
  | "family_surface_repeat"
  | "family_concentration"
  | "operation_concentration"
  | "hint_used"
  | "retry_used"
  | "worked_example"
  | "answer_revealed"
  | "guided_completion"
  | "cue_not_cold"
  | string;

export type MemoryStateSummary = {
  fsrsState: "NEW" | "LEARNING" | "REVIEW" | "RELEARNING" | "UNKNOWN";
  dueStatus: "overdue" | "due" | "due_soon" | "not_due" | "unknown";
  dueAt: string | null;
  stabilityBand: "unknown" | "new" | "fragile" | "growing" | "strong";
  stability: number | null;
  lapses: number;
  repetitions: number;
  recentRatingCounts: Readonly<Record<"AGAIN" | "HARD" | "GOOD" | "EASY", number>>;
  recentIndependentReviews: number;
  recentAssistedAttempts: number;
  planKind: "learning" | "recovery" | "retention";
};

export type PlannerBlueprintSlot = Omit<
  SharedBlueprintSlot,
  "familyConstraints" | "sourceRequirements"
> & {
  id: string;
  sourceRequirements: SharedBlueprintSlot["sourceRequirements"];
};

export type BlueprintSlot = PlannerBlueprintSlot & {
  index: number;
  retrievalStage: RetrievalStage;
  stage: RetrievalStage;
  cognitiveOperation: CognitiveOperation;
  operation: CognitiveOperation;
  difficultyDimensions: readonly string[];
  family: string;
  exerciseFamily: string;
  evidenceClass: EvidenceClass;
  assistancePolicy: AssistancePolicy;
  misconceptionPurpose: string | null;
  distractorPurpose: string | null;
  plannerSourceRequirements: {
    required: boolean;
    anchors: readonly string[];
    sourceRevisionIds: readonly string[];
    allowVerifiedSupplement: boolean;
  };
  noveltyRequirements: {
    avoidFamilies: readonly string[];
    avoidSurfaceFeatures: readonly string[];
    avoidFreshnessKeys: readonly string[];
    requireChangedSurface: boolean;
  };
  familyConstraints: SharedBlueprintSlot["familyConstraints"];
  planningFamilyConstraints: {
    maxBatchCount: number;
    variationDimensions: readonly string[];
  };
  reasonCodes: readonly GenerationReasonCode[];
};

export type PlannedExerciseBlueprint = Omit<SharedExerciseBlueprint, "slots"> & {
  version: typeof EXERCISE_PLANNING_VERSION;
  id: string;
  skillId: string;
  skillSpecFingerprint: string;
  plannedCount: number;
  requestedCountInput: number;
  status: "ready" | "manual_review";
  reasonCodes: readonly GenerationReasonCode[];
  memoryState: MemoryStateSummary;
  slots: readonly BlueprintSlot[];
  coverage: {
    retrievalStages: readonly RetrievalStage[];
    families: readonly string[];
    answerModes: readonly AnswerMode[];
    evidenceModes: readonly EvidenceMode[];
  };
};

export type ExerciseBlueprint = PlannedExerciseBlueprint;

export type PlanExerciseBlueprintInput = {
  skillSpec?: SkillGenerationSpecInput;
  spec?: SkillGenerationSpecInput;
  generationProfile?: GenerationProfile;
  profile?: GenerationProfile;
  recentExercises?: readonly RecentExercise[];
  recentHistory?: readonly RecentExercise[];
};

export type AttemptEvidenceInput = {
  isCorrect?: boolean;
  correct?: boolean;
  result?: string | null;
  submitted?: boolean;
  attemptNumber?: number | null;
  cold?: boolean;
  isCold?: boolean;
  cueLevel?: string | null;
  hintUsed?: boolean;
  hintsUsed?: number | null;
  retryCount?: number | null;
  retries?: number | null;
  workedExampleShown?: boolean;
  workedExample?: boolean;
  answerRevealed?: boolean;
  guidedCompletion?: boolean;
  guided?: boolean;
  assistance?: {
    hintUsed?: boolean;
    hintsUsed?: number | null;
    retryCount?: number | null;
    workedExampleShown?: boolean;
    answerRevealed?: boolean;
    guidedCompletion?: boolean;
    cueLevel?: string | null;
  } | null;
  [key: string]: unknown;
};

export type AttemptEvidenceKind =
  | "independent_retention"
  | "independent_failure"
  | "assisted_learning"
  | "skipped"
  | "invalid";

export type AttemptEvidenceResult = {
  kind: AttemptEvidenceKind;
  category: AttemptEvidenceKind;
  evidence: "retention" | "learning" | "none";
  isIndependentRetention: boolean;
  contributesToRetention: boolean;
  strength: "strong" | "weak" | "none";
  reasonCodes: readonly GenerationReasonCode[];
};

export type SkillSpecEvolutionInput = {
  previousSpec?: SkillGenerationSpecInput | null;
  nextSpec?: SkillGenerationSpecInput | null;
  oldSpec?: SkillGenerationSpecInput | null;
  newSpec?: SkillGenerationSpecInput | null;
  materialChanged?: boolean;
  sourceRevisionChanged?: boolean;
  materialFingerprintChanged?: boolean;
  scopeChanged?: boolean;
  retrievalTargetChanged?: boolean;
};

export type SkillSpecEvolutionDecision = "keep" | "reverify" | "retire";

export type SkillSpecEvolutionResult = {
  decision: SkillSpecEvolutionDecision;
  action: SkillSpecEvolutionDecision;
  reasonCodes: readonly GenerationReasonCode[];
  previousSpecFingerprint: string | null;
  nextSpecFingerprint: string | null;
  materialFingerprintChanged: boolean;
  scopeChanged: boolean;
  retrievalTargetChanged: boolean;
  reuseFsrsState: boolean;
  requiresNewSkill: boolean;
};

export type CandidateBatchItem = {
  candidateId?: string | null;
  id?: string | null;
  family?: string | null;
  exerciseFamily?: string | null;
  retrievalStage?: string | null;
  stage?: string | null;
  cognitiveOperation?: string | null;
  operation?: string | null;
  answerMode?: string | null;
  answerKind?: string | null;
  type?: string | null;
  surfaceFeatures?: readonly string[] | string | null;
  freshnessKey?: string | null;
  fingerprint?: string | null;
  contentFingerprint?: string | null;
  prompt?: string | null;
  blueprintSlotId?: string | null;
  [key: string]: unknown;
};

export type CandidateBatchDiversityOptions = {
  recentExercises?: readonly RecentExercise[];
  minDistinctFamilies?: number;
  maxSameFamilyRatio?: number;
  maxSameOperationRatio?: number;
  allowSingleFamily?: boolean;
};

export type CandidateBatchDiversityResult = {
  valid: boolean;
  isValid: boolean;
  status: "accepted" | "rejected";
  reasonCodes: readonly GenerationReasonCode[];
  distinctFamilies: number;
  familyCounts: Readonly<Record<string, number>>;
  operationCounts: Readonly<Record<string, number>>;
  duplicateCandidateIds: readonly string[];
  invalidCandidateIds: readonly string[];
  repeatedFamilyCandidateIds: readonly string[];
};

const DEFAULT_CAPABILITIES: Readonly<Record<SubjectCapabilityId, SubjectCapabilityProfile>> = {
  symbolic_numeric: {
    id: "symbolic_numeric",
    allowedAnswerModes: ["choice", "numeric", "math", "text"],
    preferredAnswerModes: ["math", "numeric", "text", "choice"],
    variationDimensions: ["numbers", "units", "operation", "representation"],
    commonFailureModes: ["sign error", "operation error", "unit mismatch"],
    publicationPolicy: "automatic",
  },
  language_form: {
    id: "language_form",
    allowedAnswerModes: ["choice", "text"],
    preferredAnswerModes: ["text", "choice"],
    variationDimensions: ["subject", "context", "tense", "diacritics"],
    commonFailureModes: ["agreement", "inflection", "diacritic", "context confusion"],
    publicationPolicy: "automatic",
  },
  conceptual_source_grounded: {
    id: "conceptual_source_grounded",
    allowedAnswerModes: ["choice", "text"],
    preferredAnswerModes: ["choice", "text"],
    variationDimensions: ["example", "classification", "contrast", "source wording"],
    commonFailureModes: ["overgeneralization", "category confusion", "unsupported inference"],
    publicationPolicy: "automatic",
  },
  unsupported: {
    id: "unsupported",
    allowedAnswerModes: [],
    preferredAnswerModes: [],
    variationDimensions: [],
    commonFailureModes: [],
    publicationPolicy: "manual_review",
  },
};

export const SUBJECT_CAPABILITY_PROFILES = DEFAULT_CAPABILITIES;

const ANSWER_MODE_ORDER: readonly AnswerMode[] = ["choice", "text", "numeric", "math"];
const RATING_VALUES = ["AGAIN", "HARD", "GOOD", "EASY"] as const;
const LEARNING_SEQUENCE: readonly RetrievalStage[] = [
  "recognition",
  "recognition",
  "cued_recall",
  "cued_recall",
  "exact_recall",
  "application",
  "interleaved_discrimination",
  "delayed_transfer",
  "exact_recall",
  "application",
];

const RETENTION_SEQUENCE: readonly RetrievalStage[] = [
  "exact_recall",
  "application",
  "interleaved_discrimination",
  "delayed_transfer",
  "exact_recall",
  "application",
  "interleaved_discrimination",
  "delayed_transfer",
  "exact_recall",
  "application",
];

const MODE_ALIASES: Readonly<Record<string, AnswerMode>> = {
  choice: "choice",
  choices: "choice",
  mcq: "choice",
  multiple_choice: "choice",
  multiplechoice: "choice",
  choice_exercise: "choice",
  text: "text",
  string: "text",
  exact_text: "text",
  exact_input: "text",
  exactinput: "text",
  numeric: "numeric",
  number: "numeric",
  math: "math",
  symbolic: "math",
  expression: "math",
};

function normalizeToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function canonicalAnswerMode(value: unknown): AnswerMode | null {
  const token = normalizeToken(value).replace(/-/g, "_");
  return MODE_ALIASES[token] ?? null;
}

function canonicalModeList(values: unknown): AnswerMode[] {
  if (!Array.isArray(values)) return [];
  const modes = values
    .map(canonicalAnswerMode)
    .filter((mode): mode is AnswerMode => mode !== null);
  return ANSWER_MODE_ORDER.filter((mode) => modes.includes(mode));
}

type ExerciseMode = "recall" | "application" | "discrimination" | "transfer";

const EXERCISE_MODE_ALIASES: Readonly<Record<string, ExerciseMode>> = {
  recall: "recall",
  cued_recall: "recall",
  exact_recall: "recall",
  application: "application",
  discrimination: "discrimination",
  recognition: "discrimination",
  interleaved_discrimination: "discrimination",
  transfer: "transfer",
  delayed_transfer: "transfer",
};

function canonicalExerciseMode(value: unknown): ExerciseMode | null {
  const token = normalizeToken(value).replace(/-/g, "_");
  return EXERCISE_MODE_ALIASES[token] ?? null;
}

function canonicalExerciseModeList(values: unknown): ExerciseMode[] {
  if (!Array.isArray(values)) return [];
  const modes = values
    .map(canonicalExerciseMode)
    .filter((mode): mode is ExerciseMode => mode !== null);
  return ["recall", "application", "discrimination", "transfer"].filter((mode) =>
    modes.includes(mode as ExerciseMode),
  ) as ExerciseMode[];
}

function finiteNonNegativeInteger(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function isoDate(value: unknown): string | null {
  return parseDate(value)?.toISOString() ?? null;
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(stableJson(value))}`;
}

function resolveCapability(
  input: SubjectCapabilityId | SubjectCapabilityProfile | string | undefined,
): SubjectCapabilityProfile {
  if (input && typeof input === "object") {
    const id = normalizeToken(input.id).replace(/-/g, "_");
    const base =
      DEFAULT_CAPABILITIES[id as SubjectCapabilityId] ?? DEFAULT_CAPABILITIES.unsupported;
    return {
      ...base,
      ...input,
      id: input.id,
      allowedAnswerModes:
        input.allowedAnswerModes ?? base.allowedAnswerModes ?? [],
      preferredAnswerModes:
        input.preferredAnswerModes ?? base.preferredAnswerModes ?? [],
      variationDimensions:
        input.variationDimensions ?? base.variationDimensions ?? [],
      commonFailureModes: input.commonFailureModes ?? base.commonFailureModes ?? [],
    };
  }
  const id = normalizeToken(input ?? "conceptual_source_grounded").replace(/-/g, "_");
  return DEFAULT_CAPABILITIES[id as SubjectCapabilityId] ?? DEFAULT_CAPABILITIES.unsupported;
}

function resolveSpecId(spec: SkillGenerationSpecInput): string {
  const value = spec.skillId ?? spec.id ?? "skill";
  return String(value).trim() || "skill";
}

function resolveSpecVersion(spec: SkillGenerationSpecInput): string {
  const value = spec.specVersion ?? spec.version;
  return typeof value === "string" && value.trim() ? value.trim() : "unversioned";
}

function resolveSpecFingerprint(spec: SkillGenerationSpecInput): string {
  const explicit = spec.fingerprint ?? spec.skillSpecFingerprint;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return stableHash(
    stableJson({
      skillId: resolveSpecId(spec),
      title: normalizeText(spec.title),
      objective: normalizeText(spec.objective),
      observableSuccessCriteria: normalizeStringList(spec.observableSuccessCriteria),
      prerequisites: normalizeStringList(spec.prerequisiteAssumptions ?? spec.prerequisites),
      scope: normalizeScope(spec),
      allowedAnswerModes: canonicalModeList(spec.allowedAnswerModes ?? spec.answerModes),
      allowedExerciseModes: canonicalExerciseModeList(spec.allowedExerciseModes),
      misconceptions: normalizeStringList(spec.misconceptions ?? spec.commonMisconceptions),
      allowedExerciseFamilies: normalizeStringList(spec.allowedExerciseFamilies),
    }),
  );
}

function resolveMaterialFingerprint(spec: SkillGenerationSpecInput): string | null {
  const value = spec.materialFingerprint ?? spec.sourceRevisionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeScope(spec: SkillGenerationSpecInput): { included: string[]; excluded: string[] } {
  const raw = spec.scope ?? spec.scopeBoundaries;
  if (typeof raw === "string") return { included: [normalizeText(raw)], excluded: [] };
  if (!raw || typeof raw !== "object") return { included: [], excluded: [] };
  return {
    included: normalizeStringList(raw.included).map(normalizeText).filter(Boolean),
    excluded: normalizeStringList(raw.excluded).map(normalizeText).filter(Boolean),
  };
}

type PlannerSourceRequirements = {
  required: boolean;
  anchors: string[];
  sourceRevisionIds: string[];
  allowVerifiedSupplement: boolean;
};

function normalizePlannerSourceRequirements(spec: SkillGenerationSpecInput): PlannerSourceRequirements {
  const raw = spec.sourceRequirements;
  if (typeof raw === "string") {
    return {
      required: true,
      anchors: [raw.trim()].filter(Boolean),
      sourceRevisionIds: [],
      allowVerifiedSupplement: false,
    };
  }
  if (!raw || typeof raw !== "object") {
    return {
      required: false,
      anchors: [],
      sourceRevisionIds: [],
      allowVerifiedSupplement: false,
    };
  }
  const anchors = normalizeStringList(raw.anchors ?? raw.evidenceIds ?? raw.sourceRevisionIds);
  return {
    required: raw.required === true,
    anchors,
    sourceRevisionIds: normalizeStringList(raw.sourceRevisionIds),
    allowVerifiedSupplement: raw.allowVerifiedSupplement === true,
  };
}

function normalizeSourceRequirements(
  spec: SkillGenerationSpecInput,
): SharedBlueprintSlot["sourceRequirements"] {
  const planner = normalizePlannerSourceRequirements(spec);
  return {
    required: planner.required,
    evidenceIds: planner.anchors,
  };
}

function resolveProfileValue<T>(profile: GenerationProfile, primary: keyof GenerationProfile, fallback: keyof GenerationProfile): T | undefined {
  return (profile[primary] ?? profile[fallback]) as T | undefined;
}

function normalizeProfile(profile: GenerationProfile): {
  state: MemoryStateSummary["fsrsState"];
  dueAt: Date | null;
  now: Date | null;
  lapses: number;
  repetitions: number;
  ratings: Array<(typeof RATING_VALUES)[number]>;
  requestedCount: number;
  supportedModes: AnswerMode[];
  capability: SubjectCapabilityProfile;
  stability: number | null;
  independentReviews: number;
  assistedAttempts: number;
} {
  const stateToken = normalizeToken(resolveProfileValue<FsrsStateInput>(profile, "fsrsState", "state"))
    .replace(/-/g, "_")
    .toUpperCase();
  const state: MemoryStateSummary["fsrsState"] = [
    "NEW",
    "LEARNING",
    "REVIEW",
    "RELEARNING",
  ].includes(stateToken)
    ? (stateToken as MemoryStateSummary["fsrsState"])
    : "UNKNOWN";
  const explicitNow = parseDate(profile.now);
  const dueOffsetMs =
    typeof profile.dueInMs === "number" && Number.isFinite(profile.dueInMs)
      ? profile.dueInMs
      : typeof profile.dueInSeconds === "number" && Number.isFinite(profile.dueInSeconds)
        ? profile.dueInSeconds * 1_000
        : null;
  const dueAt = parseDate(profile.dueAt ?? profile.due) ??
    (dueOffsetMs !== null
      ? new Date((explicitNow ?? new Date(0)).getTime() + dueOffsetMs)
      : null);
  const now = explicitNow ?? (dueAt && dueOffsetMs === null ? new Date(dueAt.getTime()) : dueOffsetMs !== null ? new Date(0) : null);
  const ratingsValue = resolveProfileValue<readonly FsrsRatingInput[]>(
    profile,
    "recentRatings",
    "ratings",
  );
  const ratings = (ratingsValue ?? [])
    .map((rating) =>
      normalizeToken(
        typeof rating === "object" ? rating.rating ?? rating.value : rating,
      )
        .replace(/-/g, "_")
        .toUpperCase(),
    )
    .filter((rating): rating is (typeof RATING_VALUES)[number] =>
      (RATING_VALUES as readonly string[]).includes(rating),
    );
  const supportedModes = canonicalModeList(
    resolveProfileValue<readonly string[]>(profile, "supportedAnswerModes", "answerModes"),
  );
  const capability = resolveCapability(profile.subjectCapability ?? profile.capability);
  return {
    state,
    dueAt,
    now,
    lapses: finiteNonNegativeInteger(profile.lapses),
    repetitions: finiteNonNegativeInteger(profile.repetitions ?? profile.reps),
    ratings,
    requestedCount: finiteNonNegativeInteger(profile.desiredCount ?? profile.count),
    supportedModes,
    capability,
    stability:
      typeof profile.stability === "number" && Number.isFinite(profile.stability)
        ? Math.max(0, profile.stability)
        : null,
    independentReviews: finiteNonNegativeInteger(
      profile.recentIndependentReviews ?? profile.independentReviews,
    ),
    assistedAttempts: finiteNonNegativeInteger(
      profile.recentAssistedAttempts ?? profile.assistedAttempts,
    ),
  };
}

function dueStatus(dueAt: Date | null, now: Date | null): MemoryStateSummary["dueStatus"] {
  if (!dueAt || !now) return "unknown";
  const delta = dueAt.getTime() - now.getTime();
  if (delta <= 0) return delta < 0 ? "overdue" : "due";
  if (delta <= 24 * 60 * 60 * 1000) return "due_soon";
  return "not_due";
}

function stabilityBand(stability: number | null, state: MemoryStateSummary["fsrsState"]): MemoryStateSummary["stabilityBand"] {
  if (stability === null) {
    if (state === "NEW") return "new";
    return state === "UNKNOWN" ? "unknown" : "fragile";
  }
  if (stability < 1) return "new";
  if (stability < 3) return "fragile";
  if (stability < 21) return "growing";
  return "strong";
}

function buildMemoryState(profile: ReturnType<typeof normalizeProfile>): MemoryStateSummary {
  const counts = {
    AGAIN: profile.ratings.filter((rating) => rating === "AGAIN").length,
    HARD: profile.ratings.filter((rating) => rating === "HARD").length,
    GOOD: profile.ratings.filter((rating) => rating === "GOOD").length,
    EASY: profile.ratings.filter((rating) => rating === "EASY").length,
  };
  const recentIndependentReviews =
    profile.independentReviews ||
    profile.ratings.filter((rating) => rating === "GOOD" || rating === "EASY").length;
  const hasFailure = profile.lapses > 0 || counts.AGAIN > 0 || profile.state === "RELEARNING";
  const uncertain =
    profile.state === "NEW" ||
    profile.state === "LEARNING" ||
    profile.state === "UNKNOWN" ||
    profile.repetitions < 2 ||
    (profile.assistedAttempts > recentIndependentReviews && profile.assistedAttempts > 0);
  return {
    fsrsState: profile.state,
    dueStatus: dueStatus(profile.dueAt, profile.now),
    dueAt: isoDate(profile.dueAt),
    stabilityBand: stabilityBand(profile.stability, profile.state),
    stability: profile.stability,
    lapses: profile.lapses,
    repetitions: profile.repetitions,
    recentRatingCounts: counts,
    recentIndependentReviews,
    recentAssistedAttempts: profile.assistedAttempts,
    planKind: hasFailure ? "recovery" : uncertain ? "learning" : "retention",
  };
}

function operationForStage(stage: RetrievalStage): CognitiveOperation {
  if (stage === "recognition" || stage === "interleaved_discrimination") {
    return "discrimination";
  }
  if (stage === "application") return "application";
  if (stage === "delayed_transfer") return "transfer";
  return "recall";
}

function modePreferences(stage: RetrievalStage, capability: SubjectCapabilityProfile): AnswerMode[] {
  const preferred = canonicalModeList(capability.preferredAnswerModes);
  const byStage: Record<RetrievalStage, AnswerMode[]> = {
    recognition: ["choice", "text", "numeric", "math"],
    cued_recall: ["text", "choice", "numeric", "math"],
    exact_recall: ["text", "numeric", "math", "choice"],
    application: ["numeric", "math", "text", "choice"],
    interleaved_discrimination: ["choice", "text", "numeric", "math"],
    delayed_transfer: ["text", "numeric", "math", "choice"],
  };
  return [...new Set([...preferred, ...byStage[stage]])];
}

function familyCandidates(stage: RetrievalStage, mode: AnswerMode): string[] {
  const modeFamily = mode === "math" ? "symbolic-production" : mode === "numeric" ? "numeric-work" : null;
  const candidates: Record<RetrievalStage, string[]> = {
    recognition: ["recognition-choice", "recognition-discrimination"],
    cued_recall: ["cued-recall", "cued-recall-context"],
    exact_recall: [modeFamily ?? "exact-recall", "exact-recall", "production-text"],
    application: ["application-context", "application-variation"],
    interleaved_discrimination: ["interleaved-choice", "interleaved-discrimination"],
    delayed_transfer: ["delayed-transfer", "transfer-context"],
  };
  return candidates[stage];
}

function familyFit(family: string, stage: RetrievalStage): number {
  const token = normalizeToken(family);
  const operation = operationForStage(stage);
  if (
    (stage === "recognition" && (token.includes("recogn") || token.includes("discrimin"))) ||
    (stage === "cued_recall" && token.includes("cued")) ||
    (stage === "exact_recall" && (token.includes("exact") || token.includes("production") || token.includes("numeric") || token.includes("symbolic"))) ||
    (stage === "application" && token.includes("application")) ||
    (stage === "interleaved_discrimination" && token.includes("interleav")) ||
    (stage === "delayed_transfer" && (token.includes("transfer") || token.includes("delayed")))
  ) {
    return 2;
  }
  if (
    (operation === "recall" && (token.includes("recall") || token.includes("production"))) ||
    (operation === "application" && token.includes("context")) ||
    (operation === "discrimination" && token.includes("choice")) ||
    (operation === "transfer" && token.includes("context"))
  ) {
    return 1;
  }
  return 0;
}

function recentExerciseFields(exercise: RecentExercise): {
  family: string;
  stage: string;
  mode: AnswerMode | null;
  features: string[];
  freshnessKey: string;
  prompt: string;
} {
  return {
    family: normalizeToken(exercise.family ?? exercise.exerciseFamily),
    stage: normalizeToken(exercise.retrievalStage ?? exercise.stage),
    mode: canonicalAnswerMode(exercise.answerMode ?? exercise.answerKind),
    features: normalizeStringList(exercise.surfaceFeatures).map(normalizeToken),
    freshnessKey: normalizeToken(exercise.freshnessKey ?? exercise.fingerprint ?? exercise.contentFingerprint),
    prompt: normalizeText(exercise.prompt),
  };
}

function normalizedRecentExercises(history: readonly RecentExercise[]): ReturnType<typeof recentExerciseFields>[] {
  return history
    .slice(-MAX_RECENT_EXERCISES_CONSIDERED)
    .map(recentExerciseFields)
    .filter((item) => item.family || item.freshnessKey || item.prompt);
}

function chooseMode(
  stage: RetrievalStage,
  available: readonly AnswerMode[],
  capability: SubjectCapabilityProfile,
  usedModes: readonly AnswerMode[],
): AnswerMode {
  const preferences = modePreferences(stage, capability);
  const unused = preferences.find((mode) => available.includes(mode) && !usedModes.includes(mode));
  return unused ?? preferences.find((mode) => available.includes(mode)) ?? available[0];
}

function chooseFamily(
  stage: RetrievalStage,
  mode: AnswerMode,
  allowedFamilies: readonly string[],
  usedFamilies: readonly string[],
  recentFamilies: readonly string[],
): { family: string; avoidedRecent: boolean } {
  const preferred = familyCandidates(stage, mode);
  const sortedAllowed = [...new Set(allowedFamilies.map((family) => family.trim()).filter(Boolean))].sort();
  const candidates = sortedAllowed.length > 0 ? sortedAllowed : preferred;
  const rank = (family: string): [number, number, number, string] => [
    recentFamilies.includes(normalizeToken(family)) ? 1 : 0,
    usedFamilies.includes(normalizeToken(family)) ? 1 : 0,
    -familyFit(family, stage),
    family,
  ];
  const family = [...candidates].sort((left, right) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] < rightRank[index]) return -1;
      if (leftRank[index] > rightRank[index]) return 1;
    }
    return 0;
  })[0];
  const normalized = normalizeToken(family);
  return { family, avoidedRecent: recentFamilies.includes(normalized) === false && recentFamilies.length > 0 };
}

function targetDifficulty(
  stage: RetrievalStage,
  memory: MemoryStateSummary,
  desiredDifficulty: number | null,
): number {
  const base =
    desiredDifficulty !== null
      ? desiredDifficulty
      : memory.planKind === "recovery"
        ? 1
        : memory.planKind === "learning"
          ? 2
          : memory.stabilityBand === "strong"
            ? 4
            : memory.stabilityBand === "growing"
              ? 3
              : 2;
  const offset: Record<RetrievalStage, number> = {
    recognition: -1,
    cued_recall: 0,
    exact_recall: 1,
    application: 1,
    interleaved_discrimination: 1,
    delayed_transfer: 2,
  };
  return clamp(Math.round(base + offset[stage]), 1, 5);
}

function difficultyDimensions(stage: RetrievalStage, capability: SubjectCapabilityProfile): string[] {
  const dimensions = normalizeStringList(capability.variationDimensions);
  const stageDimension =
    stage === "recognition"
      ? "cue reduction"
      : stage === "cued_recall"
        ? "support reduction"
        : stage === "exact_recall"
          ? "independent production"
          : stage === "application"
            ? "changed context"
            : stage === "interleaved_discrimination"
              ? "nearby-skill discrimination"
              : "delayed transfer";
  return [...new Set([stageDimension, ...dimensions])];
}

function familyMaxCount(batchCount: number): number {
  if (batchCount <= 1) return 1;
  return Math.max(1, Math.ceil(batchCount * 0.6));
}

function buildReasonCodes(
  memory: MemoryStateSummary,
  profile: ReturnType<typeof normalizeProfile>,
  sourceRequirements: BlueprintSlot["sourceRequirements"],
  capability: SubjectCapabilityProfile,
  countClamped: boolean,
  hasModes: boolean,
): GenerationReasonCode[] {
  const reasons: GenerationReasonCode[] = [];
  if (memory.planKind === "retention") reasons.push("retention_progression");
  else reasons.push("new_or_uncertain");
  if (memory.planKind === "recovery") reasons.push("lapse_recovery");
  if (memory.dueStatus === "overdue" || memory.dueStatus === "due") reasons.push("due_now");
  else if (memory.dueStatus === "due_soon") reasons.push("due_soon");
  else if (memory.dueStatus === "not_due") reasons.push("due_not_yet");
  else reasons.push("due_unknown");
  if (countClamped) reasons.push("count_clamped");
  if (hasModes) reasons.push("answer_mode_intersection");
  else reasons.push("no_supported_answer_mode");
  if (capability.id === "unsupported") reasons.push("unsupported_subject_capability");
  if (capability.id !== "conceptual_source_grounded" && capability.publicationPolicy === "manual_review") {
    reasons.push("manual_review_required");
  }
  if (sourceRequirements.required) reasons.push("source_anchor_required");
  if (profile.assistedAttempts > 0) reasons.push("assisted_learning");
  else if (memory.planKind === "retention") reasons.push("independent_retention");
  return reasons;
}

function normalizePlanInput(
  inputOrSpec: PlanExerciseBlueprintInput | SkillGenerationSpecInput,
  profileArgument?: GenerationProfile,
  recentArgument?: readonly RecentExercise[],
): {
  spec: SkillGenerationSpecInput;
  profile: GenerationProfile;
  recentExercises: readonly RecentExercise[];
} {
  if (
    "skillSpec" in inputOrSpec ||
    "spec" in inputOrSpec ||
    "generationProfile" in inputOrSpec ||
    "profile" in inputOrSpec ||
    "recentExercises" in inputOrSpec ||
    "recentHistory" in inputOrSpec
  ) {
    const input = inputOrSpec as PlanExerciseBlueprintInput;
    return {
      spec: input.skillSpec ?? input.spec ?? {},
      profile: input.generationProfile ?? input.profile ?? {},
      recentExercises: input.recentExercises ?? input.recentHistory ?? [],
    };
  }
  return {
    spec: inputOrSpec,
    profile: profileArgument ?? {},
    recentExercises: recentArgument ?? [],
  };
}

export function planExerciseBlueprint(input: PlanExerciseBlueprintInput): ExerciseBlueprint;
export function planExerciseBlueprint(
  spec: SkillGenerationSpecInput,
  profile: GenerationProfile,
  recentExercises?: readonly RecentExercise[],
): ExerciseBlueprint;
export function planExerciseBlueprint(
  inputOrSpec: PlanExerciseBlueprintInput | SkillGenerationSpecInput,
  profileArgument?: GenerationProfile,
  recentArgument?: readonly RecentExercise[],
): ExerciseBlueprint {
  const input = normalizePlanInput(inputOrSpec, profileArgument, recentArgument);
  const profile = normalizeProfile(input.profile);
  const sourceRequirements = normalizeSourceRequirements(input.spec);
  const capability = resolveCapability(profile.capability.id === "unsupported" ? input.spec.subjectCapability : profile.capability);
  const effectiveCapability = resolveCapability(
    profile.capability.id === "conceptual_source_grounded" && input.spec.subjectCapability
      ? input.spec.subjectCapability
      : capability,
  );
  const memory = buildMemoryState({ ...profile, capability: effectiveCapability });
  const requestedCount = profile.requestedCount;
  const plannedCount = clamp(requestedCount, 0, MAX_BLUEPRINT_SLOTS);
  const countClamped = plannedCount !== requestedCount;
  const specModes = canonicalModeList(
    input.spec.allowedAnswerModes ?? input.spec.allowedExerciseModes ?? input.spec.answerModes,
  );
  const capabilityModes = canonicalModeList(effectiveCapability.allowedAnswerModes);
  const profileModes = profile.supportedModes.length > 0 ? profile.supportedModes : capabilityModes;
  const modes = ANSWER_MODE_ORDER.filter(
    (mode) =>
      profileModes.includes(mode) &&
      (specModes.length === 0 || specModes.includes(mode)) &&
      capabilityModes.includes(mode),
  );
  const reasons = buildReasonCodes(
    memory,
    profile,
    sourceRequirements,
    effectiveCapability,
    countClamped,
    modes.length > 0,
  );
  const unsupported = effectiveCapability.id === "unsupported" || modes.length === 0;
  if (unsupported || plannedCount === 0) {
    const status = unsupported ? "manual_review" : "ready";
    return {
      contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
      blueprintVersion: EXERCISE_PLANNING_VERSION,
      version: EXERCISE_PLANNING_VERSION,
      id: stableId("blueprint", {
        skillId: resolveSpecId(input.spec),
        fingerprint: resolveSpecFingerprint(input.spec),
        requestedCount,
        modes,
      }),
      skillId: resolveSpecId(input.spec),
      skillSpecVersion: resolveSpecVersion(input.spec),
      skillSpecFingerprint: resolveSpecFingerprint(input.spec),
      requestedCount,
      requestedCountInput: requestedCount,
      plannedCount: 0,
      status,
      reasonCodes: [...new Set(reasons)],
      memoryState: memory,
      slots: [],
      coverage: { retrievalStages: [], families: [], answerModes: [], evidenceModes: [] },
    };
  }

  const allowedFamilies = normalizeStringList(input.spec.allowedExerciseFamilies);
  const recent = normalizedRecentExercises(input.recentExercises);
  const recentFamilies = [...new Set(recent.map((item) => item.family).filter(Boolean))].sort();
  const recentSurfaceFeatures = [...new Set(recent.flatMap((item) => item.features))].sort();
  const recentFreshnessKeys = [...new Set(recent.map((item) => item.freshnessKey).filter(Boolean))].sort();
  const usedFamilies: string[] = [];
  const usedModes: AnswerMode[] = [];
  const sequence = memory.planKind === "retention" ? RETENTION_SEQUENCE : LEARNING_SEQUENCE;
  const slots: BlueprintSlot[] = [];
  for (let index = 0; index < plannedCount; index += 1) {
    const retrievalStage = sequence[index % sequence.length];
    const answerMode = chooseMode(retrievalStage, modes, effectiveCapability, usedModes);
    const chosen = chooseFamily(retrievalStage, answerMode, allowedFamilies, usedFamilies, recentFamilies);
    const family = chosen.family;
    const normalizedFamily = normalizeToken(family);
    const slotReasons: GenerationReasonCode[] = [
      memory.planKind === "retention" ? "retention_progression" : "new_or_uncertain",
      memory.planKind === "recovery" ? "lapse_recovery" : "family_diversity",
      memory.planKind === "retention" ? "independent_retention" : "assisted_learning",
    ];
    if (chosen.avoidedRecent) slotReasons.push("recent_family_avoidance");
    if (retrievalStage === "interleaved_discrimination") slotReasons.push("interleaving");
    if (retrievalStage === "delayed_transfer") slotReasons.push("transfer_eligible");
    if (sourceRequirements.required) slotReasons.push("source_anchor_required");
    const evidenceMode: EvidenceMode = memory.planKind === "retention" ? "retention" : "learning-time";
    const evidenceClass: EvidenceClass =
      memory.planKind === "retention" ? "independent_retention" : "learning";
    const assistancePolicy: AssistancePolicy =
      memory.planKind === "retention" || (retrievalStage !== "recognition" && retrievalStage !== "cued_recall")
        ? "none"
        : "optional_scaffold";
    const misconceptionPurpose =
      (retrievalStage === "recognition" || retrievalStage === "interleaved_discrimination")
        ? normalizeStringList(input.spec.misconceptions ?? input.spec.commonMisconceptions)[0] ?? null
        : null;
    const slot: BlueprintSlot = {
      id: stableId("slot", {
        skillId: resolveSpecId(input.spec),
        specFingerprint: resolveSpecFingerprint(input.spec),
        index,
        retrievalStage,
        family: normalizedFamily,
        answerMode,
        evidenceMode,
      }),
      slotId: stableId("slot", {
        skillId: resolveSpecId(input.spec),
        specFingerprint: resolveSpecFingerprint(input.spec),
        index,
        retrievalStage,
        family: normalizedFamily,
        answerMode,
        evidenceMode,
      }),
      index,
      retrievalStage,
      stage: retrievalStage,
      cognitiveOperation: operationForStage(retrievalStage),
      operation: operationForStage(retrievalStage),
      mode: operationForStage(retrievalStage),
      targetDifficulty: targetDifficulty(
        retrievalStage,
        memory,
        typeof input.profile.desiredDifficulty === "number" && Number.isFinite(input.profile.desiredDifficulty)
          ? input.profile.desiredDifficulty
          : null,
      ),
      difficultyDimensions: difficultyDimensions(retrievalStage, effectiveCapability),
      answerMode,
      family,
      exerciseFamily: family,
      evidenceMode,
      evidenceClass,
      assistancePolicy,
      misconceptionOrDistractorPurpose: misconceptionPurpose,
      misconceptionPurpose,
      distractorPurpose: answerMode === "choice" ? misconceptionPurpose : null,
      sourceRequirements,
      plannerSourceRequirements: normalizePlannerSourceRequirements(input.spec),
      noveltyConstraints: {
        avoidPromptFingerprints: [],
        avoidCandidateIds: [],
        minimumSurfaceChange: recent.length > 0 ? "change the exercise surface" : null,
      },
      noveltyRequirements: {
        avoidFamilies: recentFamilies,
        avoidSurfaceFeatures: recentSurfaceFeatures,
        avoidFreshnessKeys: recentFreshnessKeys,
        requireChangedSurface: recent.length > 0,
      },
      familyConstraints: {
        allowedFamilies: allowedFamilies.length > 0 ? allowedFamilies : [family],
        excludedFamilies: normalizeStringList(effectiveCapability.blockedExerciseFamilies),
        maxSlotsPerFamily: familyMaxCount(plannedCount),
      },
      planningFamilyConstraints: {
        maxBatchCount: familyMaxCount(plannedCount),
        variationDimensions: normalizeStringList(effectiveCapability.variationDimensions),
      },
      reasonCodes: [...new Set(slotReasons)],
    };
    slots.push(slot);
    usedFamilies.push(normalizedFamily);
    usedModes.push(answerMode);
  }

  const retrievalStages = [...new Set(slots.map((slot) => slot.retrievalStage))];
  const families = [...new Set(slots.map((slot) => slot.family))].sort();
  const answerModes = [...new Set(slots.map((slot) => slot.answerMode))].sort(
    (left, right) => ANSWER_MODE_ORDER.indexOf(left) - ANSWER_MODE_ORDER.indexOf(right),
  );
  const evidenceModes = [...new Set(slots.map((slot) => slot.evidenceMode))];
  return {
    contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    blueprintVersion: EXERCISE_PLANNING_VERSION,
    version: EXERCISE_PLANNING_VERSION,
    id: stableId("blueprint", {
      skillId: resolveSpecId(input.spec),
      fingerprint: resolveSpecFingerprint(input.spec),
      requestedCount,
      slots: slots.map((slot) => slot.id),
    }),
    skillId: resolveSpecId(input.spec),
    skillSpecVersion: resolveSpecVersion(input.spec),
    skillSpecFingerprint: resolveSpecFingerprint(input.spec),
    requestedCount,
    requestedCountInput: requestedCount,
    plannedCount,
    status: "ready",
    reasonCodes: [...new Set(reasons)],
    memoryState: memory,
    slots,
    coverage: { retrievalStages, families, answerModes, evidenceModes },
  };
}

function assistanceCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isPositive(value: unknown): boolean {
  return value === true || assistanceCount(value) > 0;
}

export function classifyAttemptEvidence(input: AttemptEvidenceInput): AttemptEvidenceResult {
  if (!input || typeof input !== "object") {
    return {
      kind: "invalid",
      category: "invalid",
      evidence: "none",
      isIndependentRetention: false,
      contributesToRetention: false,
      strength: "none",
      reasonCodes: ["manual_review_required"],
    };
  }
  const assistance = input.assistance ?? {};
  const resultToken = normalizeToken(input.result).replace(/-/g, "_");
  const skipped = resultToken === "skipped" || input.submitted === false;
  if (skipped) {
    return {
      kind: "skipped",
      category: "skipped",
      evidence: "none",
      isIndependentRetention: false,
      contributesToRetention: false,
      strength: "none",
      reasonCodes: ["manual_review_required"],
    };
  }
  const correctness =
    typeof input.isCorrect === "boolean"
      ? input.isCorrect
      : typeof input.correct === "boolean"
        ? input.correct
        : resultToken === "correct"
          ? true
          : resultToken === "incorrect"
            ? false
            : null;
  if (correctness === null) {
    return {
      kind: "invalid",
      category: "invalid",
      evidence: "none",
      isIndependentRetention: false,
      contributesToRetention: false,
      strength: "none",
      reasonCodes: ["manual_review_required"],
    };
  }

  const hintsUsed = Math.max(
    assistanceCount(input.hintsUsed),
    assistanceCount(input.hintUsed),
    assistanceCount(assistance.hintsUsed),
    assistanceCount(assistance.hintUsed),
  );
  const hintUsed =
    isPositive(input.hintUsed) ||
    hintsUsed > 0 ||
    isPositive(assistance.hintUsed) ||
    assistanceCount(assistance.hintsUsed) > 0;
  const retryCount = Math.max(
    assistanceCount(input.retryCount),
    assistanceCount(input.retries),
    assistanceCount(assistance.retryCount),
  );
  const workedExample =
    input.workedExampleShown === true || input.workedExample === true || assistance.workedExampleShown === true;
  const answerRevealed = input.answerRevealed === true || assistance.answerRevealed === true;
  const guided =
    input.guidedCompletion === true ||
    input.guided === true ||
    assistance.guidedCompletion === true ||
    [input.cueLevel, assistance.cueLevel].some((level) =>
      ["guided", "demo", "duo", "worked_example"].includes(normalizeToken(level)),
    );
  const explicitCold = input.cold === true || input.isCold === true;
  const explicitNonCold = input.cold === false || input.isCold === false;
  const attemptNumber =
    typeof input.attemptNumber === "number" && Number.isFinite(input.attemptNumber)
      ? Math.floor(input.attemptNumber)
      : null;
  const hasAssistance = hintUsed || retryCount > 0 || workedExample || answerRevealed || guided || explicitNonCold;
  const reasonCodes: GenerationReasonCode[] = [];
  if (hintUsed) {
    reasonCodes.push("assisted_learning", "hint_used");
  }
  if (retryCount > 0) {
    reasonCodes.push("assisted_learning", "retry_used");
  }
  if (workedExample) {
    reasonCodes.push("assisted_learning", "worked_example");
  }
  if (answerRevealed) {
    reasonCodes.push("assisted_learning", "answer_revealed");
  }
  if (guided) {
    reasonCodes.push("assisted_learning", "guided_completion");
  }
  if (explicitNonCold) reasonCodes.push("cue_not_cold");
  if (!hasAssistance && (explicitCold || attemptNumber === null || attemptNumber <= 1)) {
    reasonCodes.push("independent_retention");
  }
  if (!correctness) {
    if (!hasAssistance) reasonCodes.push("new_or_uncertain");
    return {
      kind: hasAssistance ? "assisted_learning" : "independent_failure",
      category: hasAssistance ? "assisted_learning" : "independent_failure",
      evidence: hasAssistance ? "learning" : "none",
      isIndependentRetention: false,
      contributesToRetention: false,
      strength: "none",
      reasonCodes: [...new Set(reasonCodes)],
    };
  }
  if (hasAssistance) {
    return {
      kind: "assisted_learning",
      category: "assisted_learning",
      evidence: "learning",
      isIndependentRetention: false,
      contributesToRetention: false,
      strength: "weak",
      reasonCodes: [...new Set(reasonCodes.length > 0 ? reasonCodes : ["assisted_learning"])],
    };
  }
  return {
    kind: "independent_retention",
    category: "independent_retention",
    evidence: "retention",
    isIndependentRetention: true,
    contributesToRetention: true,
    strength: "strong",
    reasonCodes: [...new Set(reasonCodes.length > 0 ? reasonCodes : ["independent_retention"])],
  };
}

function evolutionInput(
  inputOrPrevious: SkillSpecEvolutionInput | SkillGenerationSpecInput | null,
  nextArgument?: SkillGenerationSpecInput | null,
  optionsArgument?: Omit<SkillSpecEvolutionInput, "previousSpec" | "nextSpec">,
): SkillSpecEvolutionInput {
  if (
    inputOrPrevious &&
    typeof inputOrPrevious === "object" &&
    ("previousSpec" in inputOrPrevious || "nextSpec" in inputOrPrevious || "oldSpec" in inputOrPrevious || "newSpec" in inputOrPrevious)
  ) {
    return inputOrPrevious as SkillSpecEvolutionInput;
  }
  return {
    previousSpec: inputOrPrevious,
    nextSpec: nextArgument,
    ...optionsArgument,
  };
}

function meaningfulSpecView(spec: SkillGenerationSpecInput): Record<string, unknown> {
  return {
    title: normalizeText(spec.title),
    objective: normalizeText(spec.objective),
    observableSuccessCriteria: normalizeStringList(spec.observableSuccessCriteria).map(normalizeText),
    prerequisites: normalizeStringList(spec.prerequisiteAssumptions ?? spec.prerequisites).map(normalizeText),
    scope: normalizeScope(spec),
    allowedAnswerModes: canonicalModeList(
      spec.allowedAnswerModes ?? spec.allowedExerciseModes ?? spec.answerModes,
    ),
    misconceptions: normalizeStringList(spec.misconceptions ?? spec.commonMisconceptions).map(normalizeText),
    allowedExerciseFamilies: normalizeStringList(spec.allowedExerciseFamilies).map(normalizeToken),
  };
}

export function assessSkillSpecEvolution(input: SkillSpecEvolutionInput): SkillSpecEvolutionResult;
export function assessSkillSpecEvolution(
  previousSpec: SkillGenerationSpecInput | null,
  nextSpec: SkillGenerationSpecInput | null,
  options?: Omit<SkillSpecEvolutionInput, "previousSpec" | "nextSpec">,
): SkillSpecEvolutionResult;
export function assessSkillSpecEvolution(
  inputOrPrevious: SkillSpecEvolutionInput | SkillGenerationSpecInput | null,
  nextArgument?: SkillGenerationSpecInput | null,
  optionsArgument?: Omit<SkillSpecEvolutionInput, "previousSpec" | "nextSpec">,
): SkillSpecEvolutionResult {
  const input = evolutionInput(inputOrPrevious, nextArgument, optionsArgument);
  const previous = input.previousSpec ?? input.oldSpec ?? null;
  const next = input.nextSpec ?? input.newSpec ?? null;
  const previousFingerprint = previous ? resolveSpecFingerprint(previous) : null;
  const nextFingerprint = next ? resolveSpecFingerprint(next) : null;
  if (!next) {
    return {
      decision: "retire",
      action: "retire",
      reasonCodes: ["retrieval_target_changed"],
      previousSpecFingerprint: previousFingerprint,
      nextSpecFingerprint: null,
      materialFingerprintChanged: true,
      scopeChanged: true,
      retrievalTargetChanged: true,
      reuseFsrsState: false,
      requiresNewSkill: true,
    };
  }
  if (!previous) {
    return {
      decision: "reverify",
      action: "reverify",
      reasonCodes: ["initial_spec"],
      previousSpecFingerprint: null,
      nextSpecFingerprint: nextFingerprint,
      materialFingerprintChanged: false,
      scopeChanged: false,
      retrievalTargetChanged: false,
      reuseFsrsState: false,
      requiresNewSkill: false,
    };
  }
  const previousMaterial = resolveMaterialFingerprint(previous);
  const nextMaterial = resolveMaterialFingerprint(next);
  const materialFingerprintChanged =
    input.materialFingerprintChanged === true ||
    previousMaterial !== nextMaterial;
  const scopeChanged =
    input.scopeChanged === true ||
    stableJson(normalizeScope(previous)) !== stableJson(normalizeScope(next));
  const targetChanged =
    input.retrievalTargetChanged === true ||
    stableJson(meaningfulSpecView(previous)) !== stableJson(meaningfulSpecView(next));
  const sourceRevisionChanged = input.sourceRevisionChanged === true;
  const specFingerprintChanged = previousFingerprint !== nextFingerprint;
  const specVersionChanged = resolveSpecVersion(previous) !== resolveSpecVersion(next);
  const materialChanged = input.materialChanged === true || sourceRevisionChanged || materialFingerprintChanged;
  const reasonCodes: GenerationReasonCode[] = [];
  if (scopeChanged) reasonCodes.push("scope_changed");
  if (targetChanged) reasonCodes.push("retrieval_target_changed");
  if (materialChanged) reasonCodes.push("material_changed");
  if (materialFingerprintChanged) reasonCodes.push("material_fingerprint_changed");
  if (sourceRevisionChanged) reasonCodes.push("source_revision_changed");
  if (specFingerprintChanged) reasonCodes.push("spec_fingerprint_changed");
  if (specVersionChanged) reasonCodes.push("spec_version_changed");
  if (reasonCodes.length === 0) reasonCodes.push("fingerprints_unchanged");

  const decision: SkillSpecEvolutionDecision = scopeChanged || targetChanged ? "retire" : reasonCodes.length === 1 && reasonCodes[0] === "fingerprints_unchanged" ? "keep" : "reverify";
  return {
    decision,
    action: decision,
    reasonCodes,
    previousSpecFingerprint: previousFingerprint,
    nextSpecFingerprint: nextFingerprint,
    materialFingerprintChanged,
    scopeChanged,
    retrievalTargetChanged: targetChanged,
    reuseFsrsState: decision !== "retire",
    requiresNewSkill: decision === "retire",
  };
}

function candidateFields(candidate: CandidateBatchItem, index: number): {
  id: string;
  family: string;
  operation: string;
  stage: string;
  mode: AnswerMode | null;
  features: string[];
  freshnessKey: string;
  prompt: string;
  duplicateKey: string;
  surfaceKey: string;
} {
  const id = String(candidate.candidateId ?? candidate.id ?? `candidate-${index + 1}`).trim() || `candidate-${index + 1}`;
  const family = normalizeToken(candidate.family ?? candidate.exerciseFamily);
  const stage = normalizeToken(candidate.retrievalStage ?? candidate.stage);
  const mode = canonicalAnswerMode(candidate.answerMode ?? candidate.answerKind ?? candidate.type);
  const operation = normalizeToken(candidate.cognitiveOperation ?? candidate.operation);
  const features = normalizeStringList(candidate.surfaceFeatures).map(normalizeToken);
  const freshnessKey = normalizeToken(
    candidate.freshnessKey ?? candidate.fingerprint ?? candidate.contentFingerprint,
  );
  const prompt = normalizeText(candidate.prompt);
  const duplicateKey = freshnessKey
    ? `freshness:${freshnessKey}`
    : `content:${family}|${mode ?? "unknown"}|${prompt}`;
  const surfaceKey = features.length > 0 ? features.join("|") : prompt;
  return {
    id,
    family,
    operation,
    stage,
    mode,
    features,
    freshnessKey,
    prompt,
    duplicateKey,
    surfaceKey,
  };
}

function recordCounts(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    if (value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function candidateBatchInput(
  inputOrCandidates:
    | readonly CandidateBatchItem[]
    | { candidates: readonly CandidateBatchItem[]; options?: CandidateBatchDiversityOptions } & CandidateBatchDiversityOptions,
  optionsArgument?: CandidateBatchDiversityOptions,
): { candidates: readonly CandidateBatchItem[]; options: CandidateBatchDiversityOptions } {
  if (Array.isArray(inputOrCandidates)) {
    return { candidates: inputOrCandidates, options: optionsArgument ?? {} };
  }
  const objectInput = inputOrCandidates as {
    candidates: readonly CandidateBatchItem[];
    options?: CandidateBatchDiversityOptions;
  } & CandidateBatchDiversityOptions;
  const { candidates, options, ...inlineOptions } = objectInput;
  return { candidates, options: { ...inlineOptions, ...options } };
}

export function validateCandidateBatchDiversity(
  candidates: readonly CandidateBatchItem[],
  options?: CandidateBatchDiversityOptions,
): CandidateBatchDiversityResult;
export function validateCandidateBatchDiversity(
  input: { candidates: readonly CandidateBatchItem[]; options?: CandidateBatchDiversityOptions } & CandidateBatchDiversityOptions,
): CandidateBatchDiversityResult;
export function validateCandidateBatchDiversity(
  inputOrCandidates:
    | readonly CandidateBatchItem[]
    | { candidates: readonly CandidateBatchItem[]; options?: CandidateBatchDiversityOptions } & CandidateBatchDiversityOptions,
  optionsArgument?: CandidateBatchDiversityOptions,
): CandidateBatchDiversityResult {
  const { candidates, options } = candidateBatchInput(inputOrCandidates, optionsArgument);
  const fields = candidates.map(candidateFields);
  const reasonSet = new Set<GenerationReasonCode>();
  const duplicateCandidateIds = new Set<string>();
  const invalidCandidateIds = new Set<string>();
  const repeatedFamilyCandidateIds = new Set<string>();
  const seenIds = new Set<string>();
  const seenDuplicateKeys = new Map<string, string>();
  const familySurfaceKeys = new Map<string, string>();

  for (const field of fields) {
    if (seenIds.has(field.id)) {
      reasonSet.add("duplicate_candidate_id");
      duplicateCandidateIds.add(field.id);
    }
    seenIds.add(field.id);
    if (!field.family) {
      reasonSet.add("missing_family");
      invalidCandidateIds.add(field.id);
    }
    if (field.freshnessKey || field.prompt) {
      const previousId = seenDuplicateKeys.get(field.duplicateKey);
      if (previousId) {
        reasonSet.add("duplicate_candidate");
        duplicateCandidateIds.add(field.id);
        duplicateCandidateIds.add(previousId);
      } else {
        seenDuplicateKeys.set(field.duplicateKey, field.id);
      }
    }
    if (field.family && field.surfaceKey) {
      const surfaceKey = `${field.family}|${field.mode ?? "unknown"}|${field.surfaceKey}`;
      const previousId = familySurfaceKeys.get(surfaceKey);
      if (previousId) {
        reasonSet.add("family_surface_repeat");
        repeatedFamilyCandidateIds.add(field.id);
        repeatedFamilyCandidateIds.add(previousId);
      } else {
        familySurfaceKeys.set(surfaceKey, field.id);
      }
    }
  }

  const recent = (options.recentExercises ?? []).map(recentExerciseFields);
  for (const field of fields) {
    if (!field.family) continue;
    const matchesRecent = recent.some(
      (item) =>
        (field.freshnessKey && item.freshnessKey && field.freshnessKey === item.freshnessKey) ||
        (field.prompt && item.prompt && field.prompt === item.prompt && field.family === item.family),
    );
    if (matchesRecent) {
      reasonSet.add("recent_duplicate");
      duplicateCandidateIds.add(field.id);
    }
  }

  const familyValues = fields.map((field) => field.family).filter(Boolean);
  const familyCounts = recordCounts(familyValues);
  const distinctFamilies = Object.keys(familyCounts).length;
  const minimumFamilies = options.allowSingleFamily
    ? 1
    : clamp(finiteNonNegativeInteger(options.minDistinctFamilies, fields.length >= 5 ? 3 : fields.length >= 3 ? 2 : 1), 1, Math.max(1, fields.length));
  if (distinctFamilies < minimumFamilies) reasonSet.add("family_concentration");
  const maxFamilyRatio =
    typeof options.maxSameFamilyRatio === "number" && Number.isFinite(options.maxSameFamilyRatio)
      ? clamp(options.maxSameFamilyRatio, 0, 1)
      : 0.6;
  const largestFamilyCount = Math.max(0, ...Object.values(familyCounts));
  if (fields.length >= 3 && fields.length > 0 && largestFamilyCount / fields.length > maxFamilyRatio) {
    reasonSet.add("family_concentration");
  }

  const operationCounts = recordCounts(fields.map((field) => field.operation).filter(Boolean));
  const maxOperationRatio =
    typeof options.maxSameOperationRatio === "number" && Number.isFinite(options.maxSameOperationRatio)
      ? clamp(options.maxSameOperationRatio, 0, 1)
      : 0.8;
  const largestOperationCount = Math.max(0, ...Object.values(operationCounts));
  if (fields.length >= 4 && fields.some((field) => field.operation) && largestOperationCount / fields.length > maxOperationRatio) {
    reasonSet.add("operation_concentration");
  }

  const reasonOrder: GenerationReasonCode[] = [
    "missing_family",
    "duplicate_candidate_id",
    "duplicate_candidate",
    "recent_duplicate",
    "family_surface_repeat",
    "family_concentration",
    "operation_concentration",
  ];
  const reasonCodes = reasonOrder.filter((reason) => reasonSet.has(reason));
  return {
    valid: reasonCodes.length === 0,
    isValid: reasonCodes.length === 0,
    status: reasonCodes.length === 0 ? "accepted" : "rejected",
    reasonCodes,
    distinctFamilies,
    familyCounts: Object.fromEntries(Object.entries(familyCounts).sort(([left], [right]) => left.localeCompare(right))),
    operationCounts: Object.fromEntries(Object.entries(operationCounts).sort(([left], [right]) => left.localeCompare(right))),
    duplicateCandidateIds: [...duplicateCandidateIds].sort(),
    invalidCandidateIds: [...invalidCandidateIds].sort(),
    repeatedFamilyCandidateIds: [...repeatedFamilyCandidateIds].sort(),
  };
}

export const validateCandidateBatch = validateCandidateBatchDiversity;
export const validateExerciseBatchDiversity = validateCandidateBatchDiversity;
export const validateExerciseFamilyBatch = validateCandidateBatchDiversity;
