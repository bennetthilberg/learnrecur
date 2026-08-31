import { choicesSchema } from "@/lib/answer-checking";
import { z } from "zod";
import type { GeneratedChoiceExercise } from "@/lib/skills";
import {
  DEFAULT_MAX_SIMILARITY,
  EVALUATION_METRICS,
  type EvaluationAttempt,
  type EvaluationDefectCode,
  type EvaluationFixture,
  type EvaluationMetricName,
  type EvaluationProvider,
  type EvaluationRunSummary,
  type MetricScore,
  type RuntimeMetadata,
} from "./contracts";

type Inspection = {
  exercises: ValidatedChoiceExercise[];
  rawCount: number;
  schemaValid: boolean;
};

type ScoreResponseInput = {
  fixture: EvaluationFixture;
  attempt: EvaluationAttempt;
  provider: EvaluationProvider | "chain";
  attempts: EvaluationAttempt[];
};

type ValidatedChoiceExercise = {
  prompt: string;
  choices: Array<{ id: string; label: string }>;
  answerSpec: { kind: "choice"; correctChoiceId: string };
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

const generatedChoiceExerciseSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1_200),
  choices: choicesSchema.min(2).max(6),
  correctChoiceId: z.string().trim().min(1),
  explanation: z.string().trim().min(1).max(1_200).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  expectedSeconds: z.number().int().min(5).max(180).optional(),
});

export function scoreEvaluationAttempt({
  fixture,
  attempt,
  provider,
  attempts,
}: ScoreResponseInput): EvaluationRunSummary {
  const successful = isSuccessfulAttempt(attempt);
  const detectedDefectCodes = new Set<EvaluationDefectCode>();
  const metrics = createUnmeasuredMetrics();
  let observedDecision: EvaluationRunSummary["observedDecision"] = "no-response";

  if (!successful) {
    detectedDefectCodes.add("provider-failure");
    metrics.failureFallback = scoreFailureFallback(fixture, provider, attempts);
  } else {
    const responseScore = scoreSuccessfulResponse(fixture, attempt, detectedDefectCodes);
    Object.assign(metrics, responseScore.metrics);
    metrics.failureFallback = scoreFailureFallback(fixture, provider, attempts);
    for (const code of responseScore.defectCodes) {
      detectedDefectCodes.add(code);
    }

    const qualityPassed = Object.entries(metrics)
      .filter(([name]) => name !== "failureFallback")
      .every(([, metric]) => metric.status === "pass");
    observedDecision = qualityPassed ? "accept" : "reject";

    if (
      provider === "chain" &&
      fixture.expected.chain.fallbackOutcome === "success" &&
      attempts.at(-1)?.provider === "fallback" &&
      observedDecision !== "accept"
    ) {
      detectedDefectCodes.add("fallback-quality");
    }
  }

  const decisionMatched = successful
    ? observedDecision === fixture.expected.publication
    : expectedFailureMatches(fixture, provider, attempts);
  const criticalDefectDetected = evaluateCriticalDefectDetection({
    fixture,
    observedDecision,
    decisionMatched,
    detectedDefectCodes,
    successful,
  });

  return {
    fixtureId: fixture.id,
    provider,
    evidence: attempt.evidence,
    critical: fixture.expected.critical,
    expectedDecision: fixture.expected.publication,
    observedDecision,
    decisionMatched,
    criticalDefectDetected,
    detectedDefectCodes: [...detectedDefectCodes],
    metrics,
    attempts: attempts.map((candidate) => ({
      provider: candidate.provider,
      status: candidate.status,
      model: candidate.model,
      evidence: candidate.evidence,
      retryable: candidate.retryable,
      ...(candidate.errorCode ? { errorCode: candidate.errorCode } : {}),
    })),
  };
}

function scoreSuccessfulResponse(
  fixture: EvaluationFixture,
  attempt: EvaluationAttempt,
  detectedDefectCodes: Set<EvaluationDefectCode>,
): { metrics: Omit<Record<EvaluationMetricName, MetricScore>, "failureFallback">; defectCodes: EvaluationDefectCode[] } {
  const inspection = inspectResponse(attempt.response, fixture.job.requestedCount);
  const defectCodes = new Set<EvaluationDefectCode>();
  const metrics = createUnmeasuredMetrics();

  metrics.schemaValidity = scoreSchemaValidity(inspection, defectCodes);

  if (inspection.exercises.length > 0) {
    metrics.semanticCorrectness = scoreSemanticCorrectness(fixture, inspection.exercises, defectCodes);
    metrics.sourceFidelity = scoreSourceFidelity(fixture, inspection.exercises, defectCodes);
    metrics.answerDeterminism = scoreAnswerDeterminism(fixture, inspection.exercises, defectCodes);
    metrics.explanationCorrectness = scoreExplanationCorrectness(
      fixture,
      inspection.exercises,
      defectCodes,
    );
    metrics.diversity = scoreDiversity(fixture, inspection.exercises, defectCodes);
    metrics.staleSpec = scoreStaleSpec(fixture, attempt.metadata, defectCodes);
  }

  metrics.latency = scoreLatency(fixture, attempt.metadata, defectCodes);
  metrics.tokenMetadata = scoreTokens(fixture, attempt.metadata, defectCodes);
  metrics.costMetadata = scoreCost(fixture, attempt.metadata, defectCodes);

  for (const code of defectCodes) {
    detectedDefectCodes.add(code);
  }

  const { failureFallback: _failureFallback, ...qualityMetrics } = metrics;
  void _failureFallback;
  return { metrics: qualityMetrics, defectCodes: [...defectCodes] };
}

function inspectResponse(response: unknown, requestedCount: number): Inspection {
  const envelope = z
    .strictObject({
      exercises: z.array(z.unknown()).min(1).max(Math.max(1, requestedCount)),
    })
    .safeParse(response);
  const exercises: ValidatedChoiceExercise[] = [];
  const rawCandidates = envelope.success ? envelope.data.exercises : [];

  for (const candidate of rawCandidates) {
    const parsed = generatedChoiceExerciseSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }

    const choiceIds = new Set<string>();
    const choices = parsed.data.choices.map((choice) => ({
      id: choice.id,
      label: choice.label.trim(),
    }));
    let hasInvalidChoice = false;
    for (const choice of choices) {
      if (!choice.label || choiceIds.has(choice.id)) {
        hasInvalidChoice = true;
        break;
      }
      choiceIds.add(choice.id);
    }
    if (hasInvalidChoice || !choiceIds.has(parsed.data.correctChoiceId)) {
      continue;
    }

    const correctChoice = choices.find((choice) => choice.id === parsed.data.correctChoiceId);
    if (!correctChoice) {
      continue;
    }
    exercises.push({
      prompt: parsed.data.prompt,
      choices,
      answerSpec: { kind: "choice", correctChoiceId: parsed.data.correctChoiceId },
      correctAnswerDisplay: correctChoice.label,
      explanation: parsed.data.explanation ?? null,
      difficulty: parsed.data.difficulty ?? null,
      expectedSeconds: parsed.data.expectedSeconds ?? null,
    });
  }

  return {
    exercises,
    rawCount: rawCandidates.length,
    schemaValid:
      envelope.success && rawCandidates.length > 0 && exercises.length === rawCandidates.length,
  };
}

function createUnmeasuredMetrics(): Record<EvaluationMetricName, MetricScore> {
  return Object.fromEntries(
    EVALUATION_METRICS.map((metric) => [metric, unmeasuredMetric()]),
  ) as Record<EvaluationMetricName, MetricScore>;
}

function scoreSchemaValidity(
  inspection: Inspection,
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  if (inspection.schemaValid) {
    return passMetric(1, "Every replayed candidate passed the production shape validator.");
  }

  defectCodes.add("schema-invalid");
  return failMetric(
    inspection.rawCount > 0 ? inspection.exercises.length / inspection.rawCount : 0,
    "At least one candidate failed the production shape or answer-contract validator.",
    ["schema-invalid"],
  );
}

function scoreSemanticCorrectness(
  fixture: EvaluationFixture,
  exercises: GeneratedChoiceExercise[],
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const results = exercises.map((exercise) => evaluateSemanticOracle(fixture, exercise));
  const failed = results.filter((result) => !result.ok);

  for (const result of failed) {
    for (const code of result.defectCodes) {
      defectCodes.add(code);
    }
  }

  if (failed.length === 0) {
    return passMetric(1, "Every candidate satisfied its deterministic semantic oracle.");
  }

  return failMetric(
    (results.length - failed.length) / results.length,
    failed.map((result) => result.reason).join(" "),
    failed.flatMap((result) => result.defectCodes),
  );
}

function evaluateSemanticOracle(
  fixture: EvaluationFixture,
  exercise: GeneratedChoiceExercise,
): { ok: boolean; reason: string; defectCodes: EvaluationDefectCode[] } {
  const oracle = fixture.expected.semantic;
  const candidateText = exerciseText(exercise).toLowerCase();
  const failures: string[] = [];
  const defects: EvaluationDefectCode[] = [];

  if (oracle.expectedChoiceId && exercise.answerSpec.correctChoiceId !== oracle.expectedChoiceId) {
    failures.push(
      `Expected correct choice ${oracle.expectedChoiceId}, received ${exercise.answerSpec.correctChoiceId}.`,
    );
    defects.push("answer-mismatch");
  }

  if (oracle.defensibleChoiceIds && oracle.defensibleChoiceIds.length > 1) {
    const available = new Set(exercise.choices.map((choice) => choice.id));
    const defensible = oracle.defensibleChoiceIds.filter((id) => available.has(id));
    if (defensible.length > 1) {
      failures.push(`The fixture marks multiple choices as defensible: ${defensible.join(", ")}.`);
      defects.push("ambiguous-choice");
    }
  }

  if (oracle.premiseRule === "confidence-interval-consistency") {
    const consistency = checkConfidenceIntervalConsistency(
      `${fixture.job.sourceContext ?? ""}\n${candidateText}`,
    );
    if (!consistency.ok) {
      failures.push(consistency.reason);
      defects.push("premise-inconsistent");
    }
  }

  for (const term of oracle.requiredTerms) {
    if (!candidateText.includes(term.toLowerCase())) {
      failures.push(`Missing semantic term: ${term}.`);
      defects.push("answer-mismatch");
    }
  }

  for (const term of oracle.forbiddenTerms) {
    if (candidateText.includes(term.toLowerCase())) {
      failures.push(`Forbidden semantic term present: ${term}.`);
      defects.push("unsupported-claim");
    }
  }

  return {
    ok: failures.length === 0,
    reason: failures.join(" "),
    defectCodes: uniqueDefectCodes(defects),
  };
}

function scoreSourceFidelity(
  fixture: EvaluationFixture,
  exercises: GeneratedChoiceExercise[],
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const oracle = fixture.expected.source;
  const results = exercises.map((exercise) => {
    const text = exerciseText(exercise).toLowerCase();
    const failures: string[] = [];
    const defects: EvaluationDefectCode[] = [];

    for (const term of oracle.requiredTerms) {
      if (!text.includes(term.toLowerCase())) {
        failures.push(`Missing source term: ${term}.`);
        defects.push(oracle.requiresConflictLanguage ? "source-conflict" : "unsupported-claim");
      }
    }

    for (const term of oracle.forbiddenTerms) {
      if (text.includes(term.toLowerCase())) {
        failures.push(`Unsupported source claim: ${term}.`);
        defects.push("unsupported-claim");
      }
    }

    if (oracle.requiresConflictLanguage && !containsConflictLanguage(text)) {
      failures.push("The candidate does not preserve the unresolved source conflict.");
      defects.push("source-conflict");
    }

    if (
      oracle.promptInjectionRule === "reject-if-output-repeats-directive" &&
      containsPromptInjectionDirective(text)
    ) {
      failures.push("The candidate repeated an instruction embedded in untrusted source text.");
      defects.push("prompt-injection");
    }

    return { ok: failures.length === 0, reason: failures.join(" "), defectCodes: defects };
  });
  const failed = results.filter((result) => !result.ok);

  for (const result of failed) {
    for (const code of result.defectCodes) {
      defectCodes.add(code);
    }
  }

  if (failed.length === 0) {
    return passMetric(1, "Candidate claims stayed within the fixture source boundary.");
  }

  return failMetric(
    (results.length - failed.length) / results.length,
    failed.map((result) => result.reason).join(" "),
    failed.flatMap((result) => result.defectCodes),
  );
}

function scoreAnswerDeterminism(
  fixture: EvaluationFixture,
  exercises: GeneratedChoiceExercise[],
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const failures: string[] = [];
  const defects: EvaluationDefectCode[] = [];

  for (const exercise of exercises) {
    const ids = exercise.choices.map((choice) => choice.id);
    const uniqueIds = new Set(ids);
    const correct = exercise.choices.find(
      (choice) => choice.id === exercise.answerSpec.correctChoiceId,
    );

    if (uniqueIds.size !== ids.length || !correct) {
      failures.push("The answer contract does not identify exactly one available choice.");
      defects.push("answer-mismatch");
    }
  }

  if (fixture.expected.semantic.defensibleChoiceIds?.length && fixture.expected.semantic.defensibleChoiceIds.length > 1) {
    failures.push("More than one choice is defensible under the fixture label.");
    defects.push("ambiguous-choice");
  }

  for (const code of defects) {
    defectCodes.add(code);
  }

  return failures.length === 0
    ? passMetric(1, "Each candidate has one stable answer choice ID.")
    : failMetric(0, failures.join(" "), defects);
}

function scoreExplanationCorrectness(
  fixture: EvaluationFixture,
  exercises: GeneratedChoiceExercise[],
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const oracle = fixture.expected.explanation;
  const results = exercises.map((exercise) => {
    const explanation = exercise.explanation?.trim().toLowerCase() ?? "";
    const failures: string[] = [];
    const defects: EvaluationDefectCode[] = [];

    if (!explanation) {
      failures.push("The candidate has no explanation.");
      defects.push("explanation-mismatch");
    }

    for (const term of oracle.requiredTerms) {
      if (!explanation.includes(term.toLowerCase())) {
        failures.push(`Missing explanation term: ${term}.`);
        defects.push("explanation-mismatch");
      }
    }

    for (const term of oracle.forbiddenTerms) {
      if (explanation.includes(term.toLowerCase())) {
        failures.push(`Forbidden explanation term present: ${term}.`);
        defects.push("explanation-mismatch");
      }
    }

    return { ok: failures.length === 0, reason: failures.join(" "), defectCodes: defects };
  });
  const failed = results.filter((result) => !result.ok);

  for (const result of failed) {
    for (const code of result.defectCodes) {
      defectCodes.add(code);
    }
  }

  return failed.length === 0
    ? passMetric(1, "Every candidate explanation satisfied its evidence terms.")
    : failMetric(
        (results.length - failed.length) / results.length,
        failed.map((result) => result.reason).join(" "),
        failed.flatMap((result) => result.defectCodes),
      );
}

function scoreDiversity(
  fixture: EvaluationFixture,
  exercises: GeneratedChoiceExercise[],
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const oracle = fixture.expected.diversity;
  const existingPrompts = oracle.compareAgainstExisting
    ? extractExistingPrompts(fixture.job.existingExerciseContext)
    : [];
  const prompts = exercises.map((exercise) => exercise.prompt);
  const comparisons: Array<{ similarity: number; left: string; right: string }> = [];

  for (let index = 0; index < prompts.length; index += 1) {
    for (const existing of existingPrompts) {
      comparisons.push({
        similarity: promptSimilarity(prompts[index], existing),
        left: prompts[index],
        right: existing,
      });
    }
    for (let otherIndex = index + 1; otherIndex < prompts.length; otherIndex += 1) {
      comparisons.push({
        similarity: promptSimilarity(prompts[index], prompts[otherIndex]),
        left: prompts[index],
        right: prompts[otherIndex],
      });
    }
  }

  const threshold = oracle.maxSimilarity ?? DEFAULT_MAX_SIMILARITY;
  const leakage = comparisons.filter((comparison) => comparison.similarity > threshold);

  if (leakage.length === 0) {
    return passMetric(1, "No exact or near-duplicate prompt exceeded the fixture threshold.");
  }

  defectCodes.add("duplicate-paraphrase");
  return failMetric(
    0,
    `Prompt similarity ${leakage[0].similarity.toFixed(2)} exceeded ${threshold.toFixed(2)}.`,
    ["duplicate-paraphrase"],
  );
}

function scoreStaleSpec(
  fixture: EvaluationFixture,
  metadata: RuntimeMetadata,
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  const expectedVersion = fixture.expected.expectedSkillSpecVersion;

  if (!expectedVersion) {
    return passMetric(1, "The fixture has no stale-spec expectation.");
  }

  if (metadata.skillSpecVersion === expectedVersion) {
    return passMetric(1, "The response carried the current skill specification version.");
  }

  defectCodes.add("stale-spec");
  return failMetric(0, "The response was produced with a stale or missing skill specification version.", [
    "stale-spec",
  ]);
}

function scoreLatency(
  fixture: EvaluationFixture,
  metadata: RuntimeMetadata,
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  if (metadata.latencyMs === null) {
    defectCodes.add("metadata-missing");
    return unmeasuredMetric("Latency was not returned by the execution adapter.", ["metadata-missing"]);
  }

  if (metadata.latencyMs > fixture.job.budgets.maxLatencyMs) {
    defectCodes.add("latency-regression");
    return failMetric(0, "Latency exceeded the fixture job budget.", ["latency-regression"]);
  }

  return passMetric(1, "Latency metadata was present and within the fixture job budget.");
}

function scoreTokens(
  fixture: EvaluationFixture,
  metadata: RuntimeMetadata,
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  if (metadata.inputTokens === null || metadata.outputTokens === null) {
    defectCodes.add("metadata-missing");
    return unmeasuredMetric("Input or output token metadata was not returned.", ["metadata-missing"]);
  }

  if (
    metadata.inputTokens > fixture.job.budgets.maxInputTokens ||
    metadata.outputTokens > fixture.job.budgets.maxOutputTokens
  ) {
    defectCodes.add("token-regression");
    return failMetric(0, "Token metadata exceeded the fixture job budget.", ["token-regression"]);
  }

  return passMetric(1, "Input and output token metadata was present and within budget.");
}

function scoreCost(
  fixture: EvaluationFixture,
  metadata: RuntimeMetadata,
  defectCodes: Set<EvaluationDefectCode>,
): MetricScore {
  if (metadata.estimatedCostUsd === null) {
    defectCodes.add("metadata-missing");
    return unmeasuredMetric("Estimated cost metadata was not returned.", ["metadata-missing"]);
  }

  if (metadata.estimatedCostUsd > fixture.job.budgets.maxCostUsd) {
    defectCodes.add("cost-regression");
    return failMetric(0, "Estimated cost exceeded the fixture job budget.", ["cost-regression"]);
  }

  return passMetric(1, "Estimated cost metadata was present and within budget.");
}

export function scoreFailureFallback(
  fixture: EvaluationFixture,
  provider: EvaluationProvider | "chain",
  attempts: EvaluationAttempt[],
): MetricScore {
  if (provider === "chain") {
    const primary = attempts.find((attempt) => attempt.provider === "primary");
    const fallback = attempts.find((attempt) => attempt.provider === "fallback");
    const expected = fixture.expected.chain;
    const actualPrimary = primary && isSuccessfulAttempt(primary) ? "success" : "failure";
    const actualFallback = fallback
      ? isSuccessfulAttempt(fallback)
        ? "success"
        : "failure"
      : "not-run";

    if (
      actualPrimary === expected.primaryOutcome &&
      actualFallback === expected.fallbackOutcome &&
      (expected.fallbackRequired === Boolean(fallback))
    ) {
      return passMetric(1, "Provider handoff matched the expected retryable failure behavior.");
    }

    return failMetric(
      0,
      `Expected chain ${expected.primaryOutcome} then ${expected.fallbackOutcome}; observed ${actualPrimary} then ${actualFallback}.`,
      expected.fallbackRequired ? ["fallback-not-used"] : ["provider-failure"],
    );
  }

  const expectedOutcome = provider === "primary"
    ? fixture.expected.primaryOutcome
    : fixture.expected.fallbackOutcome;
  const actualOutcome = attempts.some(isSuccessfulAttempt) ? "success" : "failure";

  return actualOutcome === expectedOutcome
    ? passMetric(1, "Provider outcome matched the fixture's expected failure behavior.")
    : failMetric(0, `Expected provider ${expectedOutcome}; observed ${actualOutcome}.`, [
        actualOutcome === "failure" ? "provider-failure" : "fallback-not-used",
      ]);
}

function expectedFailureMatches(
  fixture: EvaluationFixture,
  provider: EvaluationProvider | "chain",
  attempts: EvaluationAttempt[],
): boolean {
  return scoreFailureFallback(fixture, provider, attempts).status === "pass";
}

function evaluateCriticalDefectDetection(input: {
  fixture: EvaluationFixture;
  observedDecision: EvaluationRunSummary["observedDecision"];
  decisionMatched: boolean;
  detectedDefectCodes: Set<EvaluationDefectCode>;
  successful: boolean;
}): boolean {
  if (!input.fixture.expected.critical) {
    return false;
  }

  if (!input.decisionMatched) {
    return false;
  }

  if (input.fixture.expected.defectCodes.length === 0) {
    return input.observedDecision === "accept" && input.detectedDefectCodes.size === 0;
  }

  return input.fixture.expected.defectCodes.every((code) =>
    input.detectedDefectCodes.has(code),
  );
}

function checkConfidenceIntervalConsistency(text: string): { ok: boolean; reason: string } {
  const estimates = [
    ...[...text.matchAll(/(\d+(?:\.\d+)?)%\s+(?:of\s+[^.]{0,80}\s+)?(?:supported|estimated|reported)/gi)].map(
      (match) => Number(match[1]) / 100,
    ),
    ...[...text.matchAll(/(?:sample\s+)?(?:estimate|proportion)\s+(?:is|was)\s+(\d+(?:\.\d+)?)%/gi)].map(
      (match) => Number(match[1]) / 100,
    ),
  ];
  const intervals = [...text.matchAll(/\(\s*(0?\.\d+|\d+(?:\.\d+)?)\s*,\s*(0?\.\d+|\d+(?:\.\d+)?)\s*\)/g)].map(
    (match) => ({ lower: Number(match[1]), upper: Number(match[2]) }),
  );

  if (estimates.length === 0 || intervals.length === 0) {
    return { ok: false, reason: "The confidence-interval consistency rule could not be checked." };
  }

  for (const estimate of estimates) {
    for (const interval of intervals) {
      const midpoint = (interval.lower + interval.upper) / 2;
      if (
        interval.lower > interval.upper ||
        estimate < interval.lower ||
        estimate > interval.upper ||
        Math.abs(estimate - midpoint) > 0.02
      ) {
        return {
          ok: false,
          reason: `The reported estimate ${estimate} is inconsistent with interval midpoint ${midpoint.toFixed(2)}.`,
        };
      }
    }
  }

  return { ok: true, reason: "The reported estimate agrees with the interval midpoint." };
}

function containsConflictLanguage(text: string): boolean {
  return /\b(conflict|conflicting|disagree|unresolved|does not resolve|depends on)\b/i.test(text);
}

function containsPromptInjectionDirective(text: string): boolean {
  return (
    /ignore\s+(?:all\s+)?(?:prior|previous)\s+instructions/i.test(text) ||
    /reveal\s+(?:the\s+)?system\s+prompt/i.test(text) ||
    /mark\s+option\s+[a-z]\s+correct/i.test(text)
  );
}

function extractExistingPrompts(context: string | null): string[] {
  if (!context) {
    return [];
  }

  return [...context.matchAll(/prompt:\s*([^\n]+)/gi)].map((match) => match[1].trim());
}

function promptSimilarity(left: string, right: string): number {
  const leftTokens = new Set(similarityTokens(left));
  const rightTokens = new Set(similarityTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function similarityTokens(value: string): string[] {
  const aliases: Record<string, string> = {
    nearest: "closest",
    nearestto: "closest",
    choose: "select",
    indicate: "show",
    indicates: "show",
    what: "which",
  };
  const stopWords = new Set([
    "a",
    "an",
    "are",
    "is",
    "the",
    "to",
    "of",
    "for",
    "in",
    "on",
    "does",
    "do",
    "which",
    "that",
  ]);

  return value
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .map((token) => aliases[token] ?? token)
    .filter((token) => token && !stopWords.has(token));
}

function exerciseText(exercise: GeneratedChoiceExercise): string {
  return [
    exercise.prompt,
    ...exercise.choices.map((choice) => choice.label),
    exercise.correctAnswerDisplay,
    exercise.explanation ?? "",
  ].join("\n");
}

function isSuccessfulAttempt(attempt: EvaluationAttempt): boolean {
  return attempt.status === "fixture-success" || attempt.status === "live-success";
}

function passMetric(score: number, reason: string): MetricScore {
  return { status: "pass", score, reason, defectCodes: [] };
}

function failMetric(
  score: number,
  reason: string,
  defectCodes: EvaluationDefectCode[],
): MetricScore {
  return { status: "fail", score, reason, defectCodes: uniqueDefectCodes(defectCodes) };
}

function unmeasuredMetric(
  reason = "This metric was not applicable or was not returned.",
  defectCodes: EvaluationDefectCode[] = [],
): MetricScore {
  return { status: "unmeasured", score: null, reason, defectCodes: uniqueDefectCodes(defectCodes) };
}

function uniqueDefectCodes(codes: EvaluationDefectCode[]): EvaluationDefectCode[] {
  return [...new Set(codes)];
}
