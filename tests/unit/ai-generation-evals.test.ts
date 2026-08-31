import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MIN_SAMPLE_SIZE,
  compareEvaluationReports,
  parseEvaluationFixtures,
  runEvaluation,
  serializeEvaluationArtifact,
  wilsonInterval,
  type EvaluationAttempt,
  type EvaluationFixture,
} from "@/lib/ai-generation-evals";
import {
  assertLiveOptIn,
  parseCliArgs,
  shouldFailEvaluationRun,
} from "@/lib/ai-generation-evals/cli";
import { seedFixtures } from "../../tests/fixtures/ai-generation";

describe("AI generation evaluation fixtures", () => {
  it("loads typed adversarial and hard-control fixtures, including the exact interval contradiction", () => {
    const fixtureIds = seedFixtures.map((fixture) => fixture.id);

    expect(fixtureIds).toContain("statistics-95-percent-interval-contradiction");
    expect(fixtureIds).toContain("source-conflict-unsupported-claim");
    expect(fixtureIds).toContain("ambiguous-mcq");
    expect(fixtureIds).toContain("duplicate-paraphrase-leakage");
    expect(fixtureIds).toContain("source-prompt-injection");
    expect(fixtureIds).toContain("stale-specification");
    expect(fixtureIds).toContain("statistics-hard-control");
    expect(fixtureIds).toContain("spanish-hard-control");

    const contradiction = seedFixtures.find(
      (fixture) => fixture.id === "statistics-95-percent-interval-contradiction",
    );

    expect(contradiction?.job.sourceContext).toContain("95% supported");
    expect(contradiction?.job.sourceContext).toContain("(0.65, 0.75)");
  });

  it("rejects malformed fixture contracts before a run can hide missing labels", () => {
    expect(() =>
      parseEvaluationFixtures([
        {
          schemaVersion: "ai-generation-eval-v1",
          id: "missing-required-fields",
        },
      ]),
    ).toThrow(/invalid evaluation fixture/i);
  });

  it("scores primary and fallback replay separately without treating replay as live provider evidence", async () => {
    const report = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "both",
      minSampleSize: DEFAULT_MIN_SAMPLE_SIZE,
      release: {
        label: "seed-replay",
        model: "fixture-model",
        promptVersion: "skill-mcq-v0",
        schemaVersion: "ai-generation-eval-v1",
        validatorVersion: "ai-generation-eval-v1",
      },
    });

    expect(report.mode).toBe("offline-replay");
    expect(report.runs).toHaveLength(seedFixtures.length * 2);
    expect(report.runs.every((run) => run.evidence === "fixture-replay")).toBe(true);
    expect(report.runs.some((run) => run.evidence === "live-provider")).toBe(false);

    const contradiction = report.runs.find(
      (run) =>
        run.fixtureId === "statistics-95-percent-interval-contradiction" &&
        run.provider === "primary",
    );

    expect(contradiction?.observedDecision).toBe("reject");
    expect(contradiction?.decisionMatched).toBe(true);
    expect(contradiction?.criticalDefectDetected).toBe(true);
    expect(contradiction?.detectedDefectCodes).toContain("premise-inconsistent");
    expect(contradiction?.metrics.semanticCorrectness.status).toBe("fail");

    const statisticsControl = report.runs.find(
      (run) =>
        run.fixtureId === "statistics-hard-control" &&
        run.provider === "fallback",
    );

    expect(statisticsControl?.observedDecision).toBe("accept");
    expect(statisticsControl?.metrics.schemaValidity.status).toBe("pass");
    expect(statisticsControl?.metrics.answerDeterminism.status).toBe("pass");
    expect(statisticsControl?.metrics.sourceFidelity.status).toBe("pass");
    expect(statisticsControl?.metrics.explanationCorrectness.status).toBe("pass");
    expect(statisticsControl?.metrics.diversity.status).toBe("pass");
    expect(statisticsControl?.metrics.latency.status).toBe("pass");
    expect(statisticsControl?.metrics.tokenMetadata.status).toBe("pass");
    expect(statisticsControl?.metrics.costMetadata.status).toBe("pass");
    expect(statisticsControl?.metrics.failureFallback.status).toBe("pass");
  });

  it("detects every seeded critical defect while preserving the accepted hard controls", async () => {
    const report = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "both",
      minSampleSize: 0,
    });

    const criticalRuns = report.runs.filter((run) => run.critical);
    expect(criticalRuns.length).toBeGreaterThan(0);
    expect(criticalRuns.every((run) => run.decisionMatched)).toBe(true);
    expect(criticalRuns.every((run) => run.criticalDefectDetected)).toBe(true);

    const expectedDefects = new Map([
      ["statistics-95-percent-interval-contradiction", "premise-inconsistent"],
      ["source-conflict-unsupported-claim", "unsupported-claim"],
      ["ambiguous-mcq", "ambiguous-choice"],
      ["duplicate-paraphrase-leakage", "duplicate-paraphrase"],
      ["source-prompt-injection", "prompt-injection"],
      ["stale-specification", "stale-spec"],
    ]);

    for (const [fixtureId, defectCode] of expectedDefects) {
      const run = report.runs.find(
        (candidate) => candidate.fixtureId === fixtureId && candidate.provider === "primary",
      );
      expect(run?.detectedDefectCodes).toContain(defectCode);
    }

    expect(
      report.runs
        .filter((run) => run.fixtureId === "statistics-hard-control" || run.fixtureId === "spanish-hard-control")
        .every((run) => run.observedDecision === "accept"),
    ).toBe(true);
  });

  it("checks the real fallback handoff shape and keeps fallback quality subject to the same gates", async () => {
    const report = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "chain",
      minSampleSize: 0,
    });

    const recovery = report.runs.find(
      (run) => run.fixtureId === "fallback-recovery-control",
    );

    expect(recovery?.attempts.map((attempt) => attempt.status)).toEqual([
      "fixture-failure",
      "fixture-success",
    ]);
    expect(recovery?.attempts.map((attempt) => attempt.provider)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(recovery?.observedDecision).toBe("accept");
    expect(recovery?.metrics.failureFallback.status).toBe("pass");
    expect(recovery?.criticalDefectDetected).toBe(false);
  });

  it("fails fallback quality when an accepted response fails a deterministic quality metric", async () => {
    const source = seedFixtures.find((item) => item.id === "fallback-recovery-control");
    if (!source) throw new Error("missing fallback recovery fixture");
    const fixture = structuredClone(source);
    const response = fixture.replay.fallback.response as { exercises: Array<{ prompt: string }> };
    fixture.job.existingExerciseContext = `Prompt: ${response.exercises[0]?.prompt ?? ""}`;
    fixture.expected.diversity = { maxSimilarity: 0, compareAgainstExisting: true };

    const report = await runEvaluation({
      fixtures: [fixture],
      mode: "offline-replay",
      providerSelection: "fallback",
      minSampleSize: 0,
    });

    expect(report.runs[0]?.observedDecision).toBe("reject");
    expect(report.runs[0]?.metrics.diversity.status).toBe("fail");
    expect(report.gates.find((gate) => gate.id === "fallback-quality")?.status).toBe("fail");
  });

  it("accepts similarity exactly equal to the configured maximum", async () => {
    const source = seedFixtures.find((item) => item.id === "fallback-recovery-control");
    if (!source) throw new Error("missing fallback recovery fixture");
    const fixture = structuredClone(source);
    const response = fixture.replay.fallback.response as { exercises: Array<{ prompt: string }> };
    fixture.job.existingExerciseContext = `Prompt: ${response.exercises[0]?.prompt ?? ""}`;
    fixture.expected.diversity = { maxSimilarity: 1, compareAgainstExisting: true };

    const report = await runEvaluation({
      fixtures: [fixture],
      mode: "offline-replay",
      providerSelection: "fallback",
      minSampleSize: 0,
    });

    expect(report.runs[0]?.metrics.diversity.status).toBe("pass");
  });

  it("attempts live fallback after an executor exception and fails the gate if fallback returns no response", async () => {
    const fixture = seedFixtures.find((item) => item.id === "fallback-recovery-control");
    if (!fixture) throw new Error("missing fallback recovery fixture");
    const successfulFallback: EvaluationAttempt = {
      provider: "fallback",
      status: "live-success",
      model: fixture.replay.fallback.model,
      evidence: "live-provider",
      retryable: false,
      response: fixture.replay.fallback.response,
      metadata: fixture.replay.fallback.metadata,
    };
    const recovered = await runEvaluation({
      fixtures: [fixture],
      mode: "live",
      providerSelection: "chain",
      minSampleSize: 0,
      executors: {
        primary: async () => { throw Object.assign(new Error("primary unavailable"), { code: 503 }); },
        fallback: async () => successfulFallback,
      },
    });

    expect(recovered.runs[0]?.attempts.map((attempt) => attempt.status)).toEqual([
      "live-failure",
      "live-success",
    ]);
    expect(recovered.gates.find((gate) => gate.id === "fallback-quality")?.status).toBe("pass");

    const failed = await runEvaluation({
      fixtures: [fixture],
      mode: "live",
      providerSelection: "chain",
      minSampleSize: 0,
      executors: {
        primary: async () => { throw Object.assign(new Error("primary unavailable"), { code: 503 }); },
        fallback: async () => { throw new Error("fallback unavailable"); },
      },
    });

    expect(failed.runs[0]?.observedDecision).toBe("no-response");
    expect(failed.gates.find((gate) => gate.id === "fallback-quality")?.status).toBe("fail");
    expect(failed.overallVerdict).not.toBe("proceed");
  });

  it("does not hand permanent executor failures to the fallback provider", async () => {
    const fixture = seedFixtures.find((item) => item.id === "fallback-recovery-control");
    if (!fixture) throw new Error("missing fallback recovery fixture");
    const fallback = vi.fn();
    const report = await runEvaluation({
      fixtures: [fixture],
      mode: "live",
      providerSelection: "chain",
      minSampleSize: 0,
      executors: {
        primary: async () => { throw Object.assign(new Error("invalid credentials"), { status: 401 }); },
        fallback,
      },
    });

    expect(fallback).not.toHaveBeenCalled();
    expect(report.runs[0]?.attempts).toHaveLength(1);
    expect(report.runs[0]?.observedDecision).toBe("no-response");
  });

  it("reports Wilson intervals as descriptive evidence and does not overclaim two successes", () => {
    const interval = wilsonInterval(2, 2);

    expect(interval.rate).toBe(1);
    expect(interval.lower).toBeCloseTo(0.342, 2);
    expect(interval.upper).toBe(1);
    expect(interval.interpretation).toMatch(/small sample/i);
  });

  it("pauses a seed report with insufficient sample evidence even when its critical fixtures pass", async () => {
    const report = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "both",
      minSampleSize: DEFAULT_MIN_SAMPLE_SIZE,
    });

    expect(report.evidence.level).toBe("small-sample");
    expect(report.evidence.statement).toMatch(/descriptive/i);
    expect(report.gates.find((gate) => gate.id === "critical-fixture-zero-defect")?.status).toBe("pass");
    expect(report.gates.find((gate) => gate.id === "minimum-sample")?.status).toBe(
      "insufficient-evidence",
    );
    expect(report.overallVerdict).toBe("pause");
  });

  it("blocks a candidate release when an accepted control regresses", async () => {
    const baseline = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "primary",
      minSampleSize: 0,
      release: { label: "baseline", model: "model-a" },
    });
    const changedFixtures = JSON.parse(JSON.stringify(seedFixtures)) as EvaluationFixture[];
    const control = changedFixtures.find((fixture) => fixture.id === "statistics-hard-control");
    const response = control?.replay.primary.response as { exercises: Array<Record<string, unknown>> };
    response.exercises[0].correctChoiceId = "missing-choice";

    const candidate = await runEvaluation({
      fixtures: parseEvaluationFixtures(changedFixtures),
      mode: "offline-replay",
      providerSelection: "primary",
      minSampleSize: 0,
      release: { label: "candidate", model: "model-b" },
    });
    const comparison = compareEvaluationReports(baseline, candidate);

    expect(comparison.gates.some((gate) => gate.id === "quality-regression" && gate.status === "fail")).toBe(
      true,
    );
    expect(comparison.recommendation).toBe("rollback");
    expect(comparison.rollbackTarget?.label).toBe("baseline");
  });

  it("does not claim a rate regression from fewer than 30 metric trials", async () => {
    const baseline = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "primary",
      minSampleSize: 0,
    });
    const candidate = structuredClone(baseline);
    const baselineMetric = baseline.providers[0]?.metrics.semanticCorrectness;
    const candidateMetric = candidate.providers[0]?.metrics.semanticCorrectness;
    if (!baselineMetric || !candidateMetric) throw new Error("missing semantic metric");
    Object.assign(baselineMetric, { successes: 10, trials: 10, passRate: 1 });
    Object.assign(candidateMetric, { successes: 8, trials: 10, passRate: 0.8 });

    const comparison = compareEvaluationReports(baseline, candidate);
    expect(comparison.gates.find((gate) => gate.id === "quality-regression")?.status).toBe("pass");
  });

  it("serializes a report without source text, prompts, injected instructions, or provider secrets", async () => {
    const report = await runEvaluation({
      fixtures: seedFixtures,
      mode: "offline-replay",
      providerSelection: "both",
      minSampleSize: 0,
    });
    const artifact = serializeEvaluationArtifact(report);
    const serialized = JSON.stringify(artifact);

    expect(serialized).not.toContain("95% supported");
    expect(serialized).not.toContain("IGNORE ALL PRIOR INSTRUCTIONS");
    expect(serialized).not.toContain("What planet is nearest");
    expect(serialized).not.toContain("api-key");
    expect(artifact.runs.every((run) => !("response" in run))).toBe(true);
  });
});

describe("AI generation eval CLI contract", () => {
  it("defaults to offline replay and requires the explicit live opt-in flag", () => {
    expect(parseCliArgs([], {} as NodeJS.ProcessEnv).mode).toBe("offline-replay");
    expect(() => parseCliArgs(["--live"], {} as NodeJS.ProcessEnv)).toThrow(
      /LEARNRECUR_AI_GENERATION_EVAL_LIVE=1/i,
    );
    expect(
      parseCliArgs(["--live", "--provider", "chain"], {
        LEARNRECUR_AI_GENERATION_EVAL_LIVE: "1",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ mode: "live", providerSelection: "chain" });
    expect(() => assertLiveOptIn({ LEARNRECUR_AI_GENERATION_EVAL_LIVE: "0" })).toThrow(
      /offline replay/i,
    );
  });

  it("returns a failing exit decision for pause, rollback, or a failed live smoke", () => {
    expect(shouldFailEvaluationRun({ offlineVerdict: "pause", livePassed: [] })).toBe(true);
    expect(shouldFailEvaluationRun({
      offlineVerdict: "proceed",
      livePassed: [true],
      comparisonRecommendation: "rollback",
    })).toBe(true);
    expect(shouldFailEvaluationRun({
      offlineVerdict: "proceed",
      livePassed: [true],
      comparisonRecommendation: "pause",
    })).toBe(true);
    expect(shouldFailEvaluationRun({ offlineVerdict: "proceed", livePassed: [true, false] })).toBe(true);
    expect(shouldFailEvaluationRun({ offlineVerdict: "proceed", livePassed: [true] })).toBe(false);
  });
});
