import { z } from "zod";

export const EVALUATION_SCHEMA_VERSION = "ai-generation-eval-v1" as const;
export const DEFAULT_MIN_SAMPLE_SIZE = 30;
export const DEFAULT_CRITICAL_RECALL_THRESHOLD = 0.99;
export const DEFAULT_MAX_SIMILARITY = 0.86;

export const EVALUATION_PROVIDERS = ["primary", "fallback"] as const;
export const EVALUATION_PROVIDER_SELECTIONS = [
  "primary",
  "fallback",
  "both",
  "chain",
] as const;
export const EVALUATION_METRICS = [
  "schemaValidity",
  "semanticCorrectness",
  "sourceFidelity",
  "answerDeterminism",
  "explanationCorrectness",
  "diversity",
  "latency",
  "tokenMetadata",
  "costMetadata",
  "staleSpec",
  "failureFallback",
] as const;

export const EVALUATION_DEFECT_CODES = [
  "premise-inconsistent",
  "unsupported-claim",
  "source-conflict",
  "ambiguous-choice",
  "duplicate-paraphrase",
  "prompt-injection",
  "stale-spec",
  "schema-invalid",
  "answer-mismatch",
  "explanation-mismatch",
  "provider-failure",
  "fallback-not-used",
  "fallback-quality",
  "metadata-missing",
  "latency-regression",
  "token-regression",
  "cost-regression",
] as const;

const finiteNonNegativeNumber = z.number().finite().nonnegative();
const nullableFiniteNonNegativeNumber = finiteNonNegativeNumber.nullable();
const nonEmptyString = z.string().trim().min(1);
const stringList = z.array(nonEmptyString).max(30);

export const evaluationJobSchema = z.strictObject({
  jobId: nonEmptyString.max(120),
  operation: z.literal("choice-exercise-generation"),
  skillSpecVersion: nonEmptyString.max(80),
  promptVersion: nonEmptyString.max(80),
  schemaVersion: nonEmptyString.max(80),
  validatorVersion: nonEmptyString.max(80),
  skill: z.strictObject({
    id: nonEmptyString.max(120),
    title: nonEmptyString.max(120),
    objective: z.string().trim().max(1_200).nullable(),
    rules: stringList,
    examples: stringList,
    exerciseConstraints: z.string().trim().max(1_000).nullable(),
    tags: stringList,
  }),
  sourceRevisionId: nonEmptyString.max(120).nullable(),
  sourceContext: z.string().nullable(),
  existingExerciseContext: z.string().nullable(),
  requestedCount: z.number().int().min(1).max(10),
  budgets: z.strictObject({
    maxLatencyMs: finiteNonNegativeNumber,
    maxInputTokens: finiteNonNegativeNumber,
    maxOutputTokens: finiteNonNegativeNumber,
    maxCostUsd: finiteNonNegativeNumber,
  }),
});

export const runtimeMetadataSchema = z.strictObject({
  latencyMs: nullableFiniteNonNegativeNumber,
  inputTokens: nullableFiniteNonNegativeNumber,
  outputTokens: nullableFiniteNonNegativeNumber,
  estimatedCostUsd: nullableFiniteNonNegativeNumber,
  skillSpecVersion: z.string().trim().max(80).nullable(),
  promptVersion: z.string().trim().max(80).nullable(),
  schemaVersion: z.string().trim().max(80).nullable(),
});

export const replayAttemptSchema = z
  .strictObject({
    model: nonEmptyString.max(160),
    outcome: z.enum(["success", "failure"]),
    retryable: z.boolean(),
    response: z.unknown().optional(),
    errorCode: nonEmptyString.max(80).optional(),
    metadata: runtimeMetadataSchema,
  })
  .superRefine((attempt, context) => {
    if (attempt.outcome === "success" && !Object.hasOwn(attempt, "response")) {
      context.addIssue({
        code: "custom",
        path: ["response"],
        message: "Successful replay attempts require a response.",
      });
    }

    if (attempt.outcome === "failure" && !attempt.errorCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Failed replay attempts require an error code.",
      });
    }
  });

const semanticOracleSchema = z.strictObject({
  expectedChoiceId: nonEmptyString.max(80).optional(),
  defensibleChoiceIds: z.array(nonEmptyString.max(80)).max(6).optional(),
  premiseRule: z.enum(["none", "confidence-interval-consistency"]),
  requiredTerms: stringList,
  forbiddenTerms: stringList,
});

const sourceOracleSchema = z.strictObject({
  requiredTerms: stringList,
  forbiddenTerms: stringList,
  requiresConflictLanguage: z.boolean(),
  promptInjectionRule: z.enum(["none", "reject-if-output-repeats-directive"]),
});

const explanationOracleSchema = z.strictObject({
  requiredTerms: stringList,
  forbiddenTerms: stringList,
});

const diversityOracleSchema = z.strictObject({
  maxSimilarity: z.number().finite().min(0).max(1),
  compareAgainstExisting: z.boolean(),
});

const chainExpectationSchema = z.strictObject({
  primaryOutcome: z.enum(["success", "failure"]),
  fallbackOutcome: z.enum(["not-run", "success", "failure"]),
  fallbackRequired: z.boolean(),
});

export const fixtureExpectationSchema = z.strictObject({
  publication: z.enum(["accept", "reject"]),
  critical: z.boolean(),
  defectCodes: z.array(z.enum(EVALUATION_DEFECT_CODES)).max(10),
  primaryOutcome: z.enum(["success", "failure"]),
  fallbackOutcome: z.enum(["success", "failure"]),
  chain: chainExpectationSchema,
  semantic: semanticOracleSchema,
  source: sourceOracleSchema,
  explanation: explanationOracleSchema,
  diversity: diversityOracleSchema,
  expectedSkillSpecVersion: nonEmptyString.max(80).optional(),
});

export const evaluationFixtureSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
  id: nonEmptyString.max(120),
  title: nonEmptyString.max(240),
  domain: nonEmptyString.max(80),
  tags: stringList,
  job: evaluationJobSchema,
  expected: fixtureExpectationSchema,
  replay: z.strictObject({
    primary: replayAttemptSchema,
    fallback: replayAttemptSchema,
  }),
});

export type EvaluationProvider = (typeof EVALUATION_PROVIDERS)[number];
export type ProviderSelection = (typeof EVALUATION_PROVIDER_SELECTIONS)[number];
export type EvaluationMetricName = (typeof EVALUATION_METRICS)[number];
export type EvaluationDefectCode = (typeof EVALUATION_DEFECT_CODES)[number];
export type EvaluationJob = z.infer<typeof evaluationJobSchema>;
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;
export type ReplayAttempt = z.infer<typeof replayAttemptSchema>;
export type FixtureExpectation = z.infer<typeof fixtureExpectationSchema>;
export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;

export type EvaluationMode = "offline-replay" | "live";
export type AttemptStatus =
  | "fixture-success"
  | "fixture-failure"
  | "live-success"
  | "live-failure";

export type EvaluationAttempt = {
  provider: EvaluationProvider;
  status: AttemptStatus;
  model: string;
  evidence: "fixture-replay" | "live-provider";
  retryable: boolean;
  response?: unknown;
  errorCode?: string;
  metadata: RuntimeMetadata;
};

export type MetricStatus = "pass" | "fail" | "unmeasured";

export type MetricScore = {
  status: MetricStatus;
  score: number | null;
  reason: string | null;
  defectCodes: EvaluationDefectCode[];
};

export type EvaluationRunSummary = {
  fixtureId: string;
  provider: EvaluationProvider | "chain";
  evidence: "fixture-replay" | "live-provider";
  critical: boolean;
  expectedDecision: "accept" | "reject";
  observedDecision: "accept" | "reject" | "no-response";
  decisionMatched: boolean;
  criticalDefectDetected: boolean;
  detectedDefectCodes: EvaluationDefectCode[];
  metrics: Record<EvaluationMetricName, MetricScore>;
  attempts: Array<{
    provider: EvaluationProvider;
    status: AttemptStatus;
    model: string;
    evidence: "fixture-replay" | "live-provider";
    retryable: boolean;
    errorCode?: string;
  }>;
};

export type ReleaseIdentity = {
  label: string;
  model?: string;
  promptVersion?: string;
  schemaVersion?: string;
  validatorVersion?: string;
};

export type ConfidenceInterval = {
  confidenceLevel: 0.95;
  successes: number;
  trials: number;
  rate: number;
  lower: number;
  upper: number;
  interpretation: "small sample descriptive only" | "descriptive release evidence";
};

export type MetricSummary = {
  metric: EvaluationMetricName;
  successes: number;
  trials: number;
  unmeasured: number;
  passRate: number | null;
  interval: ConfidenceInterval | null;
};

export type ProviderSummary = {
  provider: EvaluationProvider | "chain";
  runs: number;
  completed: number;
  failures: number;
  accepted: number;
  rejected: number;
  criticalFixtures: number;
  criticalDefectDetections: number;
  criticalDefectRecall: number | null;
  criticalDefectInterval: ConfidenceInterval | null;
  metrics: Record<EvaluationMetricName, MetricSummary>;
};

export type GateStatus = "pass" | "fail" | "insufficient-evidence";

export type GateResult = {
  id:
    | "critical-fixture-zero-defect"
    | "quality-metrics"
    | "fallback-quality"
    | "minimum-sample"
    | "metadata-completeness"
    | "quality-regression"
    | "critical-regression";
  status: GateStatus;
  reason: string;
};

export type EvaluationReport = {
  reportVersion: typeof EVALUATION_SCHEMA_VERSION;
  mode: EvaluationMode;
  createdAt: string;
  release: ReleaseIdentity;
  minSampleSize: number;
  qualitySampleSize: number;
  criticalFixtureCount: number;
  evidence: {
    level: "no-data" | "small-sample" | "release-sized";
    statement: string;
  };
  runs: EvaluationRunSummary[];
  providers: ProviderSummary[];
  gates: GateResult[];
  overallVerdict: "proceed" | "pause" | "rollback";
};

export type EvaluationExecutor = (
  fixture: EvaluationFixture,
  provider: EvaluationProvider,
) => Promise<EvaluationAttempt>;

export type EvaluationExecutors = Partial<Record<EvaluationProvider, EvaluationExecutor>>;

export type RunEvaluationOptions = {
  fixtures: EvaluationFixture[];
  mode: EvaluationMode;
  providerSelection: ProviderSelection;
  minSampleSize?: number;
  release?: ReleaseIdentity;
  executors?: EvaluationExecutors;
  now?: Date;
};

export type ReportComparison = {
  baseline: ReleaseIdentity;
  candidate: ReleaseIdentity;
  gates: GateResult[];
  recommendation: "proceed" | "pause" | "rollback";
  rollbackTarget: ReleaseIdentity | null;
};

export function parseEvaluationFixtures(input: unknown): EvaluationFixture[] {
  const result = z.array(evaluationFixtureSchema).safeParse(input);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(`Invalid evaluation fixture${path}: ${issue?.message ?? "unknown error"}`);
  }

  const seen = new Set<string>();
  for (const fixture of result.data) {
    if (seen.has(fixture.id)) {
      throw new Error(`Invalid evaluation fixture: duplicate id ${fixture.id}`);
    }
    seen.add(fixture.id);
  }

  return result.data;
}
