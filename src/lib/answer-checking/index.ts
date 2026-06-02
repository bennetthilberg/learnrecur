import { z } from "zod";

const DEFAULT_NUMERIC_TOLERANCE = 0.001;

const nonEmptyStringSchema = z.string().trim().min(1);

export const choiceSchema = z.object({
  id: nonEmptyStringSchema,
  label: z.string(),
});

export const choicesSchema = z.array(choiceSchema).min(1);

export const choiceAnswerSpecSchema = z.object({
  kind: z.literal("choice"),
  correctChoiceId: nonEmptyStringSchema,
});

export const textAnswerSpecSchema = z.object({
  kind: z.literal("text"),
  accepted: z.array(nonEmptyStringSchema).min(1),
  normalizeCase: z.boolean().default(true),
  normalizeWhitespace: z.boolean().default(true),
  normalizeDiacritics: z.boolean().default(true),
});

const numericAcceptedValueSchema = z.union([
  z.number().finite(),
  nonEmptyStringSchema,
  z.object({
    type: z.literal("integer"),
    value: z.number().int().finite(),
  }),
  z.object({
    type: z.literal("decimal"),
    value: z.number().finite(),
  }),
  z.object({
    type: z.literal("fraction"),
    numerator: z.number().int().finite(),
    denominator: z.number().int().finite(),
  }),
  z.object({
    type: z.literal("fraction"),
    value: nonEmptyStringSchema,
  }),
]);

export const numericAnswerSpecSchema = z.object({
  kind: z.literal("numeric"),
  accepted: z.array(numericAcceptedValueSchema).min(1),
  tolerance: z.number().nonnegative().finite().default(DEFAULT_NUMERIC_TOLERANCE),
});

export const mathAnswerSpecSchema = z.object({
  kind: z.literal("math"),
  acceptedExpressions: z.array(nonEmptyStringSchema).min(1),
  equivalence: z.string().optional(),
});

export const answerSpecSchema = z.discriminatedUnion("kind", [
  choiceAnswerSpecSchema,
  textAnswerSpecSchema,
  numericAnswerSpecSchema,
  mathAnswerSpecSchema,
]);

export type Choice = z.infer<typeof choiceSchema>;
export type ChoiceAnswerSpec = z.infer<typeof choiceAnswerSpecSchema>;
export type TextAnswerSpec = z.infer<typeof textAnswerSpecSchema>;
export type NumericAnswerSpec = z.infer<typeof numericAnswerSpecSchema>;
export type MathAnswerSpec = z.infer<typeof mathAnswerSpecSchema>;
export type AnswerSpec = z.infer<typeof answerSpecSchema>;

export type CheckAnswerInput = {
  answerSpec: unknown;
  choices?: unknown;
  submittedAnswer: unknown;
};

export type AnswerCheckStatus =
  | "correct"
  | "incorrect"
  | "invalid-input"
  | "invalid-spec"
  | "unsupported";

export type AnswerCheckReason =
  | "duplicate-choice-id"
  | "empty-answer"
  | "invalid-accepted-number"
  | "invalid-answer-spec"
  | "invalid-choices"
  | "malformed-number"
  | "math-not-implemented"
  | "missing-correct-choice"
  | "unknown-choice"
  | "wrong-answer-shape"
  | "zero-denominator";

export type AnswerCheckResult = {
  status: AnswerCheckStatus;
  isCorrect: boolean;
  normalizedAnswer: string | null;
  reason?: AnswerCheckReason;
  message?: string;
};

type NumericParseFailureReason = Extract<
  AnswerCheckReason,
  "empty-answer" | "invalid-accepted-number" | "malformed-number" | "zero-denominator"
>;

type ParsedNumber =
  | {
      ok: true;
      value: number;
      normalized: string;
    }
  | {
      ok: false;
      reason: NumericParseFailureReason;
      message: string;
    };

export function checkAnswer(input: CheckAnswerInput): AnswerCheckResult {
  const specResult = answerSpecSchema.safeParse(input.answerSpec);

  if (!specResult.success) {
    return invalidSpec("invalid-answer-spec", formatZodIssues(specResult.error));
  }

  const answerSpec = specResult.data;

  switch (answerSpec.kind) {
    case "choice":
      return checkChoiceAnswer(answerSpec, input.choices, input.submittedAnswer);
    case "text":
      return checkTextAnswer(answerSpec, input.submittedAnswer);
    case "numeric":
      return checkNumericAnswer(answerSpec, input.submittedAnswer);
    case "math":
      return {
        status: "unsupported",
        isCorrect: false,
        normalizedAnswer: null,
        reason: "math-not-implemented",
        message: "Math equivalence checking is not available yet.",
      };
  }
}

function checkChoiceAnswer(
  answerSpec: ChoiceAnswerSpec,
  choicesInput: unknown,
  submittedAnswer: unknown,
): AnswerCheckResult {
  const choicesResult = choicesSchema.safeParse(choicesInput);

  if (!choicesResult.success) {
    return invalidSpec("invalid-choices", formatZodIssues(choicesResult.error));
  }

  const choices = choicesResult.data;
  const choiceIds = new Set<string>();

  for (const choice of choices) {
    if (choiceIds.has(choice.id)) {
      return invalidSpec("duplicate-choice-id", `Duplicate choice ID: ${choice.id}`);
    }

    choiceIds.add(choice.id);
  }

  if (!choiceIds.has(answerSpec.correctChoiceId)) {
    return invalidSpec(
      "missing-correct-choice",
      `Correct choice ID is not present in choices: ${answerSpec.correctChoiceId}`,
    );
  }

  const selectedChoiceId = parseSelectedChoiceId(submittedAnswer);

  if (selectedChoiceId === null) {
    return invalidInput("wrong-answer-shape", "Choose one of the available answers.");
  }

  if (selectedChoiceId.trim() === "") {
    return invalidInput("empty-answer", "Choose an answer.");
  }

  if (!choiceIds.has(selectedChoiceId)) {
    return invalidInput("unknown-choice", "Choose one of the available answers.");
  }

  return {
    status: selectedChoiceId === answerSpec.correctChoiceId ? "correct" : "incorrect",
    isCorrect: selectedChoiceId === answerSpec.correctChoiceId,
    normalizedAnswer: selectedChoiceId,
  };
}

function checkTextAnswer(answerSpec: TextAnswerSpec, submittedAnswer: unknown): AnswerCheckResult {
  if (typeof submittedAnswer !== "string") {
    return invalidInput("wrong-answer-shape", "Enter a text answer.");
  }

  const normalizedAnswer = normalizeTextAnswer(submittedAnswer, answerSpec);

  if (normalizedAnswer === "") {
    return invalidInput("empty-answer", "Enter an answer.");
  }

  const accepted = new Set(
    answerSpec.accepted.map((acceptedAnswer) => normalizeTextAnswer(acceptedAnswer, answerSpec)),
  );

  return {
    status: accepted.has(normalizedAnswer) ? "correct" : "incorrect",
    isCorrect: accepted.has(normalizedAnswer),
    normalizedAnswer,
  };
}

function checkNumericAnswer(
  answerSpec: NumericAnswerSpec,
  submittedAnswer: unknown,
): AnswerCheckResult {
  const parsedSubmittedAnswer = parseNumericInput(submittedAnswer, "input");

  if (!parsedSubmittedAnswer.ok) {
    return invalidInput(parsedSubmittedAnswer.reason, parsedSubmittedAnswer.message);
  }

  const acceptedValues: number[] = [];

  for (const acceptedValue of answerSpec.accepted) {
    const parsedAcceptedValue = parseAcceptedNumericValue(acceptedValue);

    if (!parsedAcceptedValue.ok) {
      return invalidSpec(parsedAcceptedValue.reason, parsedAcceptedValue.message);
    }

    acceptedValues.push(parsedAcceptedValue.value);
  }

  const isCorrect = acceptedValues.some(
    (acceptedValue) =>
      Math.abs(parsedSubmittedAnswer.value - acceptedValue) <=
      answerSpec.tolerance + Number.EPSILON,
  );

  return {
    status: isCorrect ? "correct" : "incorrect",
    isCorrect,
    normalizedAnswer: parsedSubmittedAnswer.normalized,
  };
}

function parseSelectedChoiceId(submittedAnswer: unknown): string | null {
  if (typeof submittedAnswer === "string") {
    return submittedAnswer.trim();
  }

  if (
    typeof submittedAnswer === "object" &&
    submittedAnswer !== null &&
    "selectedChoiceId" in submittedAnswer &&
    typeof submittedAnswer.selectedChoiceId === "string"
  ) {
    return submittedAnswer.selectedChoiceId.trim();
  }

  return null;
}

function normalizeTextAnswer(answer: string, options: TextAnswerSpec): string {
  let normalized = answer;

  if (options.normalizeWhitespace) {
    normalized = normalized.trim().replace(/\s+/g, " ");
  }

  if (options.normalizeCase) {
    normalized = normalized.toLocaleLowerCase("en-US");
  }

  if (options.normalizeDiacritics) {
    normalized = normalized.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  }

  return normalized;
}

function parseAcceptedNumericValue(acceptedValue: NumericAnswerSpec["accepted"][number]): ParsedNumber {
  if (typeof acceptedValue === "number" || typeof acceptedValue === "string") {
    return parseNumericInput(acceptedValue, "spec");
  }

  if (acceptedValue.type === "integer" || acceptedValue.type === "decimal") {
    return parseNumericInput(acceptedValue.value, "spec");
  }

  if ("numerator" in acceptedValue) {
    if (acceptedValue.denominator === 0) {
      return {
        ok: false,
        reason: "invalid-accepted-number",
        message: "Accepted fractions cannot have a denominator of zero.",
      };
    }

    return {
      ok: true,
      value: acceptedValue.numerator / acceptedValue.denominator,
      normalized: formatCanonicalNumber(acceptedValue.numerator / acceptedValue.denominator),
    };
  }

  return parseNumericInput(acceptedValue.value, "spec");
}

function parseNumericInput(input: unknown, source: "input" | "spec"): ParsedNumber {
  if (typeof input === "number") {
    if (Number.isFinite(input)) {
      return {
        ok: true,
        value: normalizeNegativeZero(input),
        normalized: formatCanonicalNumber(input),
      };
    }

    return invalidNumeric(source, "malformed-number", "Enter a number or fraction.");
  }

  if (typeof input !== "string") {
    return invalidNumeric(source, "malformed-number", "Enter a number or fraction.");
  }

  const trimmed = input.trim();

  if (trimmed === "") {
    return invalidNumeric(source, "empty-answer", "Enter a number or fraction.");
  }

  const fractionParts = trimmed.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);

  if (fractionParts) {
    const numerator = Number(fractionParts[1]);
    const denominator = Number(fractionParts[2]);

    if (denominator === 0) {
      return invalidNumeric(
        source,
        "zero-denominator",
        "Fractions cannot have a denominator of zero.",
      );
    }

    const value = numerator / denominator;

    return {
      ok: true,
      value: normalizeNegativeZero(value),
      normalized: formatCanonicalNumber(value),
    };
  }

  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    const value = Number(trimmed);

    if (Number.isFinite(value)) {
      return {
        ok: true,
        value: normalizeNegativeZero(value),
        normalized: formatCanonicalNumber(value),
      };
    }
  }

  return invalidNumeric(source, "malformed-number", "Enter a number or fraction.");
}

function invalidNumeric(
  source: "input" | "spec",
  reason: NumericParseFailureReason,
  message: string,
): ParsedNumber {
  if (source === "spec") {
    return {
      ok: false,
      reason: "invalid-accepted-number",
      message,
    };
  }

  return {
    ok: false,
    reason,
    message,
  };
}

function formatCanonicalNumber(value: number): string {
  const normalizedValue = normalizeNegativeZero(value);

  if (Number.isInteger(normalizedValue)) {
    return String(normalizedValue);
  }

  return Number(normalizedValue.toPrecision(15)).toString();
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function invalidInput(reason: AnswerCheckReason, message: string): AnswerCheckResult {
  return {
    status: "invalid-input",
    isCorrect: false,
    normalizedAnswer: null,
    reason,
    message,
  };
}

function invalidSpec(reason: AnswerCheckReason, message: string): AnswerCheckResult {
  return {
    status: "invalid-spec",
    isCorrect: false,
    normalizedAnswer: null,
    reason,
    message,
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}
