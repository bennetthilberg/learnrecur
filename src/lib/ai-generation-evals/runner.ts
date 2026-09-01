import {
  DEFAULT_CRITICAL_RECALL_THRESHOLD,
  DEFAULT_MIN_SAMPLE_SIZE,
  EVALUATION_METRICS,
  EVALUATION_PROVIDERS,
  type ConfidenceInterval,
  type EvaluationAttempt,
  type EvaluationFixture,
  type EvaluationMetricName,
  type EvaluationMode,
  type EvaluationProvider,
  type EvaluationReport,
  type EvaluationRunSummary,
  type GateResult,
  type MetricScore,
  type MetricSummary,
  type ProviderSelection,
  type ProviderSummary,
  type ReleaseIdentity,
  type ReportComparison,
  type RunEvaluationOptions,
  type RuntimeMetadata,
} from "./contracts";
import { scoreEvaluationAttempt } from "./scoring";

const MIN_REGRESSION_DELTA = 0.05;

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationReport> {
  const fixtures = options.fixtures;
  const providerSelection = options.providerSelection;
  const providers = selectedProviders(providerSelection);
  const runs: EvaluationRunSummary[] = [];

  if (providerSelection === "chain") {
    for (const fixture of fixtures) {
      runs.push(await runChain(fixture, options));
    }
  } else {
    for (const provider of providers) {
      for (const fixture of fixtures) {
        runs.push(await runIndependent(fixture, provider, options));
      }
    }
  }

  return buildReport({
    mode: options.mode,
    release: options.release ?? defaultRelease(options.mode),
    minSampleSize: options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE,
    runs,
    now: options.now ?? new Date(),
  });
}

async function runIndependent(
  fixture: EvaluationFixture,
  provider: EvaluationProvider,
  options: RunEvaluationOptions,
): Promise<EvaluationRunSummary> {
  const attempt = await executeAttempt(fixture, provider, options);
  return scoreEvaluationAttempt({
    fixture,
    attempt,
    provider,
    attempts: [attempt],
  });
}

async function runChain(
  fixture: EvaluationFixture,
  options: RunEvaluationOptions,
): Promise<EvaluationRunSummary> {
  const attempts: EvaluationAttempt[] = [
    await executeAttempt(fixture, "primary", options),
  ];
  const primary = attempts[0];

  if (!isSuccessfulAttempt(primary) && primary.retryable) {
    attempts.push(await executeAttempt(fixture, "fallback", options));
  }

  return scoreEvaluationAttempt({
    fixture,
    attempt: attempts.at(-1) ?? primary,
    provider: "chain",
    attempts,
  });
}

async function executeAttempt(
  fixture: EvaluationFixture,
  provider: EvaluationProvider,
  options: RunEvaluationOptions,
): Promise<EvaluationAttempt> {
  if (options.mode === "offline-replay") {
    return replayAttempt(fixture, provider);
  }

  const executor = options.executors?.[provider];
  if (!executor) {
    throw new Error(`Live evaluation requires an executor for ${provider}.`);
  }

  try {
    return await executor(fixture, provider);
  } catch (error) {
    return failedLiveAttempt(provider, error);
  }
}

function replayAttempt(
  fixture: EvaluationFixture,
  provider: EvaluationProvider,
): EvaluationAttempt {
  const replay = fixture.replay[provider];
  const success = replay.outcome === "success";
  return {
    provider,
    status: success ? "fixture-success" : "fixture-failure",
    model: replay.model,
    evidence: "fixture-replay",
    retryable: replay.retryable,
    ...(success ? { response: replay.response } : {}),
    ...(replay.errorCode ? { errorCode: replay.errorCode } : {}),
    metadata: replay.metadata,
  };
}

function failedLiveAttempt(
  provider: EvaluationProvider,
  error: unknown,
): EvaluationAttempt {
  const failure = classifyExecutorFailure(error);
  return {
    provider,
    status: "live-failure",
    model: "unavailable",
    evidence: "live-provider",
    retryable: failure.retryable,
    errorCode: failure.errorCode,
    metadata: emptyLiveMetadata(),
  };
}

function classifyExecutorFailure(error: unknown): { retryable: boolean; errorCode: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const values = [record?.status, record?.code];
  const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const transientCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "RATE_LIMITED",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
  ]);
  const retryable = record?.retryable === true || values.some((value) =>
    (typeof value === "number" && transientStatuses.has(value)) ||
    (typeof value === "string" && (
      transientCodes.has(value.toUpperCase()) ||
      transientStatuses.has(Number(value))
    )),
  );
  const status = values.find((value) => typeof value === "number" || typeof value === "string");
  return {
    retryable,
    errorCode: retryable && status !== undefined
      ? `executor-${String(status).toLowerCase().slice(0, 40)}`
      : "executor-error",
  };
}

export function buildReport(input: {
  mode: EvaluationMode;
  release: ReleaseIdentity;
  minSampleSize: number;
  runs: EvaluationRunSummary[];
  now: Date;
}): EvaluationReport {
  const qualityRuns = input.runs.filter(
    (run) => run.expectedDecision === "accept" && run.observedDecision !== "no-response",
  );
  const criticalRuns = input.runs.filter((run) => run.critical);
  const qualitySampleSize = qualityRuns.length;
  const criticalFixtureCount = criticalRuns.length;
  const providers = uniqueProviders(input.runs).map((provider) =>
    buildProviderSummary(provider, input.runs.filter((run) => run.provider === provider), qualityRuns),
  );
  const gates = buildGates({
    runs: input.runs,
    qualityRuns,
    criticalRuns,
    minSampleSize: input.minSampleSize,
  });

  return {
    reportVersion: "ai-generation-eval-v1",
    mode: input.mode,
    createdAt: input.now.toISOString(),
    release: input.release,
    minSampleSize: input.minSampleSize,
    qualitySampleSize,
    criticalFixtureCount,
    evidence: evidenceForSample(qualitySampleSize, input.minSampleSize),
    runs: input.runs,
    providers,
    gates,
    overallVerdict: overallVerdict(gates),
  };
}

export function wilsonInterval(successes: number, trials: number): ConfidenceInterval {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(trials) ||
    successes < 0 ||
    trials <= 0 ||
    successes > trials
  ) {
    throw new Error("Wilson interval requires integer successes between zero and positive trials.");
  }

  const z = 1.959963984540054;
  const rate = successes / trials;
  const denominator = 1 + (z ** 2) / trials;
  const center = (rate + (z ** 2) / (2 * trials)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((rate * (1 - rate)) / trials + (z ** 2) / (4 * trials ** 2));

  return {
    confidenceLevel: 0.95,
    successes,
    trials,
    rate,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    interpretation:
      trials < DEFAULT_MIN_SAMPLE_SIZE
        ? "small sample descriptive only"
        : "descriptive release evidence",
  };
}

export function serializeEvaluationArtifact(report: EvaluationReport): EvaluationReport {
  return JSON.parse(JSON.stringify(report)) as EvaluationReport;
}

export function compareEvaluationReports(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
): ReportComparison {
  const gates: GateResult[] = [];
  const baselineProviders = new Map(baseline.providers.map((summary) => [summary.provider, summary]));
  const candidateProviders = new Map(candidate.providers.map((summary) => [summary.provider, summary]));
  let qualityRegression = false;
  const regressionReasons: string[] = [];

  for (const [provider, candidateSummary] of candidateProviders) {
    const baselineSummary = baselineProviders.get(provider);
    if (!baselineSummary) {
      continue;
    }

    for (const metric of EVALUATION_METRICS) {
      const before = baselineSummary.metrics[metric];
      const after = candidateSummary.metrics[metric];
      if (before.passRate === null || after.passRate === null) {
        continue;
      }
      const passRateDrop = before.passRate - after.passRate;
      const hasEnoughEvidence =
        before.trials >= DEFAULT_MIN_SAMPLE_SIZE &&
        after.trials >= DEFAULT_MIN_SAMPLE_SIZE;
      if (hasEnoughEvidence && passRateDrop >= MIN_REGRESSION_DELTA) {
        qualityRegression = true;
        regressionReasons.push(`${provider} ${metric} fell from ${before.passRate.toFixed(2)} to ${after.passRate.toFixed(2)}.`);
      }
    }
  }

  const candidateQualityGate = candidate.gates.find((gate) => gate.id === "quality-metrics");
  if (candidateQualityGate?.status === "fail") {
    qualityRegression = true;
    regressionReasons.push(candidateQualityGate.reason);
  }

  gates.push({
    id: "quality-regression",
    status: qualityRegression ? "fail" : "pass",
    reason: qualityRegression
      ? regressionReasons.join(" ")
      : "No observed accepted-item metric regressed against the baseline.",
  });

  const baselineCritical = criticalRecall(baseline);
  const candidateCritical = criticalRecall(candidate);
  const criticalRegression =
    candidateCritical !== null &&
    (baselineCritical === null || candidateCritical < baselineCritical || candidateCritical < DEFAULT_CRITICAL_RECALL_THRESHOLD);
  gates.push({
    id: "critical-regression",
    status: criticalRegression ? "fail" : candidateCritical === null ? "insufficient-evidence" : "pass",
    reason: criticalRegression
      ? `Critical-defect recall is ${(candidateCritical * 100).toFixed(1)}%; the release gate requires ${DEFAULT_CRITICAL_RECALL_THRESHOLD * 100}%.`
      : candidateCritical === null
        ? "No critical-fixture recall could be measured."
        : "Critical-fixture recall did not regress and meets the configured threshold.",
  });

  const candidateSampleGate = candidate.gates.find((gate) => gate.id === "minimum-sample");
  if (candidateSampleGate?.status === "insufficient-evidence") {
    gates.push(candidateSampleGate);
  }

  const candidateMetadataGate = candidate.gates.find((gate) => gate.id === "metadata-completeness");
  if (candidateMetadataGate?.status === "insufficient-evidence") {
    gates.push(candidateMetadataGate);
  }

  const hasFailure = gates.some((gate) => gate.status === "fail");
  const hasInsufficientEvidence = gates.some((gate) => gate.status === "insufficient-evidence");

  return {
    baseline: baseline.release,
    candidate: candidate.release,
    gates,
    recommendation: hasFailure ? "rollback" : hasInsufficientEvidence ? "pause" : "proceed",
    rollbackTarget: hasFailure ? baseline.release : null,
  };
}

function buildProviderSummary(
  provider: EvaluationProvider | "chain",
  runs: EvaluationRunSummary[],
  qualityRuns: EvaluationRunSummary[],
): ProviderSummary {
  const providerQualityRuns = qualityRuns.filter((run) => run.provider === provider);
  const criticalRuns = runs.filter((run) => run.critical);
  const detections = criticalRuns.filter((run) => run.criticalDefectDetected).length;
  const metrics = Object.fromEntries(
    EVALUATION_METRICS.map((metric) => [
      metric,
      summarizeMetric(
        metric,
        providerQualityRuns.map((run) => run.metrics[metric]),
      ),
    ]),
  ) as Record<EvaluationMetricName, MetricSummary>;

  return {
    provider,
    runs: runs.length,
    completed: runs.filter((run) => run.observedDecision !== "no-response").length,
    failures: runs.filter((run) => run.observedDecision === "no-response").length,
    accepted: runs.filter((run) => run.observedDecision === "accept").length,
    rejected: runs.filter((run) => run.observedDecision === "reject").length,
    criticalFixtures: criticalRuns.length,
    criticalDefectDetections: detections,
    criticalDefectRecall: criticalRuns.length ? detections / criticalRuns.length : null,
    criticalDefectInterval: criticalRuns.length
      ? wilsonInterval(detections, criticalRuns.length)
      : null,
    metrics,
  };
}

function summarizeMetric(metric: EvaluationMetricName, scores: MetricScore[]): MetricSummary {
  const pass = scores.filter((score) => score.status === "pass").length;
  const fail = scores.filter((score) => score.status === "fail").length;
  const unmeasured = scores.filter((score) => score.status === "unmeasured").length;
  const trials = pass + fail;

  return {
    metric,
    successes: pass,
    trials,
    unmeasured,
    passRate: trials ? pass / trials : null,
    interval: trials ? wilsonInterval(pass, trials) : null,
  };
}

function buildGates(input: {
  runs: EvaluationRunSummary[];
  qualityRuns: EvaluationRunSummary[];
  criticalRuns: EvaluationRunSummary[];
  minSampleSize: number;
}): GateResult[] {
  const criticalFailures = input.criticalRuns.filter((run) => !run.criticalDefectDetected).length;
  const qualityFailures = input.qualityRuns.filter(
    (run) =>
      run.observedDecision !== "accept" ||
      Object.entries(run.metrics).some(
        ([metric, score]) => metric !== "failureFallback" && score.status === "fail",
      ),
  ).length;
  const fallbackRuns = input.runs.filter(
    (run) =>
      run.provider === "fallback" ||
      (run.provider === "chain" &&
        run.attempts.some((attempt) => attempt.provider === "fallback")),
  );
  const fallbackQualityFailures = fallbackRuns.filter(
    (run) =>
      run.expectedDecision === "accept" &&
      (run.observedDecision !== "accept" ||
        Object.entries(run.metrics).some(
          ([metric, score]) => metric !== "failureFallback" && score.status === "fail",
        )),
  ).length;
  const metadataUnmeasured = input.qualityRuns.some((run) =>
    ["latency", "tokenMetadata", "costMetadata"].some(
      (metric) => run.metrics[metric as EvaluationMetricName].status === "unmeasured",
    ),
  );

  return [
    {
      id: "critical-fixture-zero-defect",
      status:
        input.criticalRuns.length === 0
          ? "insufficient-evidence"
          : criticalFailures === 0
            ? "pass"
            : "fail",
      reason:
        input.criticalRuns.length === 0
          ? "No critical fixtures were included in this run."
          : criticalFailures === 0
            ? "Every included critical fixture was rejected for its labeled defect."
            : `${criticalFailures} critical fixture run(s) did not detect all labeled defects.`,
    },
    {
      id: "quality-metrics",
      status:
        input.qualityRuns.length === 0 ? "insufficient-evidence" : qualityFailures === 0 ? "pass" : "fail",
      reason:
        input.qualityRuns.length === 0
          ? "No successful expected-accept fixture provided quality evidence."
          : qualityFailures === 0
            ? "Every expected-accept fixture passed the deterministic quality metrics."
            : `${qualityFailures} expected-accept fixture run(s) failed a quality metric.`,
    },
    {
      id: "fallback-quality",
      status:
        fallbackRuns.length === 0
          ? "insufficient-evidence"
          : fallbackQualityFailures === 0
            ? "pass"
            : "fail",
      reason:
        fallbackRuns.length === 0
          ? "No direct fallback or fallback-invoking provider-chain run was included."
          : fallbackQualityFailures === 0
            ? "Fallback responses met the same quality bar as primary responses."
            : `${fallbackQualityFailures} fallback path run(s) failed the quality bar.`,
    },
    {
      id: "minimum-sample",
      status: input.qualityRuns.length >= input.minSampleSize ? "pass" : "insufficient-evidence",
      reason:
        input.qualityRuns.length >= input.minSampleSize
          ? `The quality sample contains ${input.qualityRuns.length} runs, meeting the minimum of ${input.minSampleSize}.`
          : `The quality sample contains ${input.qualityRuns.length} runs; ${input.minSampleSize} are required for a release-sized claim.`,
    },
    {
      id: "metadata-completeness",
      status: metadataUnmeasured ? "insufficient-evidence" : input.qualityRuns.length ? "pass" : "insufficient-evidence",
      reason: metadataUnmeasured
        ? "At least one accepted-item run lacks latency, token, or cost metadata."
        : input.qualityRuns.length
          ? "Accepted-item runs include latency, token, and cost metadata."
          : "No accepted-item metadata was available.",
    },
  ];
}

function selectedProviders(selection: ProviderSelection): EvaluationProvider[] {
  if (selection === "primary") {
    return ["primary"];
  }
  if (selection === "fallback") {
    return ["fallback"];
  }
  return [...EVALUATION_PROVIDERS];
}

function uniqueProviders(runs: EvaluationRunSummary[]): Array<EvaluationProvider | "chain"> {
  return [...new Set(runs.map((run) => run.provider))];
}

function criticalRecall(report: EvaluationReport): number | null {
  const criticalRuns = report.runs.filter((run) => run.critical);
  if (criticalRuns.length === 0) {
    return null;
  }
  return criticalRuns.filter((run) => run.criticalDefectDetected).length / criticalRuns.length;
}

function evidenceForSample(
  sampleSize: number,
  minSampleSize: number,
): EvaluationReport["evidence"] {
  if (sampleSize === 0) {
    return {
      level: "no-data",
      statement: "No accepted-item evidence was measured; this run cannot support a quality claim.",
    };
  }
  if (sampleSize < minSampleSize) {
    return {
      level: "small-sample",
      statement:
        `This is descriptive small-sample evidence from ${sampleSize} accepted-item run(s); it must not be presented as a production quality rate.`,
    };
  }
  return {
    level: "release-sized",
    statement:
      `This report summarizes ${sampleSize} accepted-item run(s) with 95% intervals; it still describes this evaluated sample rather than proving future behavior.`,
  };
}

function overallVerdict(gates: GateResult[]): EvaluationReport["overallVerdict"] {
  if (gates.some((gate) => gate.status === "fail")) {
    return "rollback";
  }
  if (gates.some((gate) => gate.status === "insufficient-evidence")) {
    return "pause";
  }
  return "proceed";
}

function defaultRelease(mode: EvaluationMode): ReleaseIdentity {
  return {
    label: mode === "offline-replay" ? "offline-replay" : "live-evaluation",
  };
}

function emptyLiveMetadata(): RuntimeMetadata {
  return {
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    skillSpecVersion: null,
    promptVersion: null,
    schemaVersion: null,
  };
}

function isSuccessfulAttempt(attempt: EvaluationAttempt): boolean {
  return attempt.status === "fixture-success" || attempt.status === "live-success";
}
