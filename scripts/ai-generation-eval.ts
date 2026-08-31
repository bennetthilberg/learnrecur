import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import {
  cliHelp,
  parseCliArgs,
  shouldFailEvaluationRun,
} from "../src/lib/ai-generation-evals/cli";
import {
  compareEvaluationReports,
  runEvaluation,
  serializeEvaluationArtifact,
  type EvaluationReport,
} from "../src/lib/ai-generation-evals";
import { runLiveProviderSmoke } from "../src/lib/ai-generation-evals/live-smoke";
import { getGeminiEnv } from "../src/lib/env";
import { resolveGeminiRuntimeConfig, runWithGeminiProviderFallback } from "../src/lib/gemini";
import { resolveMetaMuseFallbackConfig } from "../src/lib/meta-muse-fallback";
import {
  createGeminiChoiceExerciseGenerator,
  createGeminiChoiceExerciseVerifier,
  createMetaMuseChoiceExerciseGenerator,
  createMetaMuseChoiceExerciseVerifier,
} from "../src/lib/skills";
import { seedFixtures } from "../tests/fixtures/ai-generation";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

void main();

async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    console.log(cliHelp());
    return;
  }

  const createdAt = new Date();
  const outputPath = resolve(
    options.outputPath ??
      `${tmpdir()}/learnrecur-ai-generation-eval-${createdAt.toISOString().replaceAll(":", "-")}.json`,
  );

  const offlineReport = await runEvaluation({
    fixtures: seedFixtures,
    mode: "offline-replay",
    providerSelection: options.mode === "offline-replay" ? options.providerSelection : "both",
    minSampleSize: options.minSampleSize,
    release: {
      label: "generation-quality-v1",
      promptVersion: "skill-mcq-v1",
      schemaVersion: "choice-exercise-response-v1",
      validatorVersion: "generation-quality-v1",
    },
    now: createdAt,
  });

  const liveResults = options.mode === "live" ? await runLiveSmokes(options.providerSelection) : [];
  const baseline = options.baselinePath ? await readReport(options.baselinePath) : null;
  const comparison = baseline ? compareEvaluationReports(baseline, offlineReport) : null;
  const artifact = {
    artifactVersion: "ai-generation-evidence-v1",
    createdAt: createdAt.toISOString(),
    offline: serializeEvaluationArtifact(offlineReport),
    live: liveResults,
    comparison,
    evidenceBoundary:
      "Synthetic fixture and live contract evidence only; this does not replace blind human review or delayed-retention evidence.",
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    outputPath,
    offlineVerdict: offlineReport.overallVerdict,
    live: liveResults,
    comparisonRecommendation: comparison?.recommendation ?? null,
  }, null, 2));

  if (shouldFailEvaluationRun({
    offlineVerdict: offlineReport.overallVerdict,
    livePassed: liveResults.map((result) => result.passed),
    comparisonRecommendation: comparison?.recommendation,
  })) {
    process.exitCode = 1;
  }
}

async function runLiveSmokes(selection: "primary" | "fallback" | "both" | "chain") {
  const results = [];
  if (selection === "chain") {
    const gemini = resolveGeminiRuntimeConfig(getGeminiEnv());
    const muse = resolveMetaMuseFallbackConfig();
    if (!muse) throw new Error("META_API_KEY is required for a live provider-handoff evaluation.");
    const fallbackGenerate = createMetaMuseChoiceExerciseGenerator(muse);
    const fallbackVerify = createMetaMuseChoiceExerciseVerifier(muse);
    const retryableOutage = () => Object.assign(new Error("synthetic primary capacity failure"), { code: 503 });
    results.push(await runLiveProviderSmoke({
      provider: "fallback",
      model: `${gemini.model}->${muse.model}`,
      handoffExercised: true,
      generate: (input) => runWithGeminiProviderFallback({
        operation: "live generation handoff smoke",
        primaryModel: gemini.model,
        runPrimary: async () => { throw retryableOutage(); },
        fallback: { provider: "meta", model: muse.model, run: () => fallbackGenerate(input) },
      }),
      verify: (input) => runWithGeminiProviderFallback({
        operation: "live verification handoff smoke",
        primaryModel: gemini.model,
        runPrimary: async () => { throw retryableOutage(); },
        fallback: { provider: "meta", model: muse.model, run: () => fallbackVerify(input) },
      }),
    }));
    return results;
  }
  const runPrimary = selection === "primary" || selection === "both";
  const runFallback = selection === "fallback" || selection === "both";

  if (runPrimary) {
    const gemini = resolveGeminiRuntimeConfig(getGeminiEnv());
    results.push(await runLiveProviderSmoke({
      provider: "primary",
      model: gemini.model,
      generate: createGeminiChoiceExerciseGenerator({ gemini, metaMuseFallback: null }),
      verify: createGeminiChoiceExerciseVerifier({ gemini, metaMuseFallback: null }),
    }));
  }

  if (runFallback) {
    const muse = resolveMetaMuseFallbackConfig();
    if (!muse) {
      throw new Error("META_API_KEY is required for a live fallback evaluation.");
    }
    results.push(await runLiveProviderSmoke({
      provider: "fallback",
      model: muse.model,
      generate: createMetaMuseChoiceExerciseGenerator(muse),
      verify: createMetaMuseChoiceExerciseVerifier(muse),
    }));
  }

  return results;
}

async function readReport(path: string): Promise<EvaluationReport> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as
    | EvaluationReport
    | { offline?: EvaluationReport };
  if ("offline" in parsed && parsed.offline) {
    return parsed.offline;
  }
  return parsed as EvaluationReport;
}
