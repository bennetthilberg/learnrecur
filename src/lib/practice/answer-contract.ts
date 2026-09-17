import {
  answerSpecSchema,
  choicesSchema,
  type AnswerSpec,
  type Choice,
} from "@/lib/answer-checking";

/**
 * The comparison rules that were stored with an exercise or an attempt.
 * This is deliberately a projection of the deterministic answer checker,
 * rather than a new policy resolver. Historical reads must describe the
 * contract that was saved at submission time.
 */
export type AnswerComparisonPolicy =
  | {
      kind: "choice";
      comparison: "choice-id";
      correctChoiceId: string;
    }
  | {
      kind: "text";
      comparison: "normalized-text";
      policyVersion: 2 | null;
      normalizeCase: boolean;
      normalizeWhitespace: boolean;
      normalizeDiacritics: boolean;
    }
  | {
      kind: "numeric";
      comparison: "numeric-tolerance";
      tolerance: number;
    }
  | {
      kind: "math";
      comparison: "symbolic-equivalence";
      equivalence: "basic-symbolic";
    };

export type AcceptedAnswerVariant =
  | {
      kind: "choice";
      choiceId: string;
      display: string;
    }
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "numeric";
      value: unknown;
    }
  | {
      kind: "math";
      expression: string;
    };

export type AnswerContract = {
  kind: AnswerSpec["kind"];
  /** `spec` is the compact name; `answerSpec` keeps the persisted shape obvious. */
  spec: AnswerSpec;
  answerSpec: AnswerSpec;
  comparisonPolicy: AnswerComparisonPolicy;
  acceptedVariants: AcceptedAnswerVariant[];
  /** Values in the exact order retained by the answer checker. */
  acceptedValues: unknown[];
};

export type AnswerContractSource = "attempt" | "exercise-fallback" | "unavailable";

export type AnswerContractResolution = {
  contract: AnswerContract | null;
  source: AnswerContractSource;
  sourceLabel: string;
  fallbackReason: "missing" | "invalid" | null;
};

const ANSWER_CONTRACT_SOURCE_LABELS: Record<AnswerContractSource, string> = {
  attempt: "Saved attempt comparison contract",
  "exercise-fallback": "Historical exercise contract fallback (saved attempt contract unavailable)",
  unavailable: "Comparison contract unavailable",
};

export function buildAnswerContract(
  answerSpecInput: unknown,
  choicesInput?: unknown,
): AnswerContract | null {
  const parsed = answerSpecSchema.safeParse(answerSpecInput);

  if (!parsed.success) {
    return null;
  }

  const answerSpec = parsed.data;

  switch (answerSpec.kind) {
    case "choice": {
      const choices = choicesSchema.safeParse(choicesInput);
      const choiceById = new Map<string, Choice>(
        choices.success ? choices.data.map((choice) => [choice.id, choice]) : [],
      );
      const correctChoice = choiceById.get(answerSpec.correctChoiceId);
      const comparisonPolicy: AnswerComparisonPolicy = {
        kind: "choice",
        comparison: "choice-id",
        correctChoiceId: answerSpec.correctChoiceId,
      };

      return {
        kind: answerSpec.kind,
        spec: answerSpec,
        answerSpec,
        comparisonPolicy,
        acceptedVariants: [
          {
            kind: "choice",
            choiceId: answerSpec.correctChoiceId,
            display: correctChoice?.label ?? answerSpec.correctChoiceId,
          },
        ],
        acceptedValues: [answerSpec.correctChoiceId],
      };
    }
    case "text": {
      const comparisonPolicy: AnswerComparisonPolicy = {
        kind: "text",
        comparison: "normalized-text",
        policyVersion: answerSpec.policyVersion ?? null,
        normalizeCase: answerSpec.normalizeCase,
        normalizeWhitespace: answerSpec.normalizeWhitespace,
        normalizeDiacritics: answerSpec.normalizeDiacritics,
      };

      return {
        kind: answerSpec.kind,
        spec: answerSpec,
        answerSpec,
        comparisonPolicy,
        acceptedVariants: answerSpec.accepted.map((value) => ({ kind: "text", value })),
        acceptedValues: [...answerSpec.accepted],
      };
    }
    case "numeric": {
      const comparisonPolicy: AnswerComparisonPolicy = {
        kind: "numeric",
        comparison: "numeric-tolerance",
        tolerance: answerSpec.tolerance,
      };

      return {
        kind: answerSpec.kind,
        spec: answerSpec,
        answerSpec,
        comparisonPolicy,
        acceptedVariants: answerSpec.accepted.map((value) => ({ kind: "numeric", value })),
        acceptedValues: [...answerSpec.accepted],
      };
    }
    case "math": {
      const comparisonPolicy: AnswerComparisonPolicy = {
        kind: "math",
        comparison: "symbolic-equivalence",
        equivalence: answerSpec.equivalence,
      };

      return {
        kind: answerSpec.kind,
        spec: answerSpec,
        answerSpec,
        comparisonPolicy,
        acceptedVariants: answerSpec.acceptedExpressions.map((expression) => ({
          kind: "math",
          expression,
        })),
        acceptedValues: [...answerSpec.acceptedExpressions],
      };
    }
  }
}

export function resolveHistoricalAnswerContract(input: {
  savedAnswerPolicySnapshot: unknown;
  exerciseAnswerSpec: unknown;
  choices?: unknown;
}): AnswerContractResolution {
  const savedContract = buildAnswerContract(input.savedAnswerPolicySnapshot, input.choices);

  if (savedContract) {
    return {
      contract: savedContract,
      source: "attempt",
      sourceLabel: ANSWER_CONTRACT_SOURCE_LABELS.attempt,
      fallbackReason: null,
    };
  }

  const fallbackReason = input.savedAnswerPolicySnapshot == null ? "missing" : "invalid";
  const exerciseContract = buildAnswerContract(input.exerciseAnswerSpec, input.choices);

  if (exerciseContract) {
    return {
      contract: exerciseContract,
      source: "exercise-fallback",
      sourceLabel: ANSWER_CONTRACT_SOURCE_LABELS["exercise-fallback"],
      fallbackReason,
    };
  }

  return {
    contract: null,
    source: "unavailable",
    sourceLabel: ANSWER_CONTRACT_SOURCE_LABELS.unavailable,
    fallbackReason,
  };
}
