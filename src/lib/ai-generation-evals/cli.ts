import {
  EVALUATION_PROVIDER_SELECTIONS,
  type EvaluationMode,
  type ProviderSelection,
} from "./contracts";

export const LIVE_OPT_IN_ENV = "LEARNRECUR_AI_GENERATION_EVAL_LIVE" as const;

export type EvalCliOptions = {
  mode: EvaluationMode;
  providerSelection: ProviderSelection;
  outputPath: string | null;
  baselinePath: string | null;
  minSampleSize: number;
  help: boolean;
};

export function assertLiveOptIn(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLiveOptedIn(env)) {
    throw new Error(
      `Live mode is disabled by default; offline replay remains active. Set ${LIVE_OPT_IN_ENV}=1 to permit real provider calls.`,
    );
  }
}

export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): EvalCliOptions {
  const liveRequested = argv.includes("--live");
  if (liveRequested || isLiveOptedIn(env)) {
    assertLiveOptIn(env);
  }

  let providerSelection: ProviderSelection = "both";
  let outputPath: string | null = null;
  let baselinePath: string | null = null;
  let minSampleSize = 30;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--live":
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--provider": {
        const value = argv[index + 1];
        if (!value || !EVALUATION_PROVIDER_SELECTIONS.includes(value as ProviderSelection)) {
          throw new Error(
            `--provider must be one of ${EVALUATION_PROVIDER_SELECTIONS.join(", ")}.`,
          );
        }
        providerSelection = value as ProviderSelection;
        index += 1;
        break;
      }
      case "--output":
      case "--artifact": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error(`${argument} requires a file path.`);
        }
        outputPath = value;
        index += 1;
        break;
      }
      case "--baseline": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--baseline requires a report path.");
        }
        baselinePath = value;
        index += 1;
        break;
      }
      case "--min-sample-size": {
        const value = argv[index + 1];
        const parsed = Number(value);
        if (!value || !Number.isInteger(parsed) || parsed < 0) {
          throw new Error("--min-sample-size must be a non-negative integer.");
        }
        minSampleSize = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    mode: isLiveOptedIn(env) ? "live" : "offline-replay",
    providerSelection,
    outputPath,
    baselinePath,
    minSampleSize,
    help,
  };
}

export function cliHelp(): string {
  return [
    "LearnRecur AI generation evaluation",
    "",
    "Default: deterministic fixture replay; no provider calls are made.",
    `Live: ${LIVE_OPT_IN_ENV}=1 npx tsx scripts/ai-generation-eval.ts --provider chain`,
    "",
    "Options:",
    "  --provider primary|fallback|both|chain",
    "  --output <path>         write the redacted report (default: system temp directory)",
    "  --baseline <path>       compare against a previous redacted report",
    "  --min-sample-size <n>   release-evidence threshold (default: 30)",
    "  --live                  explicit convenience flag; still requires the env flag",
    "  --help",
  ].join("\n");
}

function isLiveOptedIn(env: NodeJS.ProcessEnv): boolean {
  return env[LIVE_OPT_IN_ENV] === "1";
}
