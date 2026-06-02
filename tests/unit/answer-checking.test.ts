import { describe, expect, it } from "vitest";

import { checkAnswer } from "@/lib/answer-checking";

const choices = [
  { id: "ser", label: "ser" },
  { id: "estar", label: "estar" },
];

describe("checkAnswer choice answers", () => {
  it("grades multiple choice by stable choice ID", () => {
    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices,
        submittedAnswer: " ser ",
      }),
    ).toEqual({
      status: "correct",
      isCorrect: true,
      normalizedAnswer: "ser",
    });

    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices,
        submittedAnswer: { selectedChoiceId: "estar" },
      }),
    ).toEqual({
      status: "incorrect",
      isCorrect: false,
      normalizedAnswer: "estar",
    });
  });

  it("rejects unknown selected choices as invalid input", () => {
    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices,
        submittedAnswer: "haber",
      }),
    ).toEqual({
      status: "invalid-input",
      isCorrect: false,
      normalizedAnswer: null,
      reason: "unknown-choice",
      message: "Choose one of the available answers.",
    });
  });

  it("rejects duplicate choice IDs and missing correct choice IDs as invalid specs", () => {
    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices: [
          { id: "ser", label: "ser" },
          { id: "ser", label: "duplicate" },
        ],
        submittedAnswer: "ser",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "duplicate-choice-id",
    });

    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices: [{ id: "estar", label: "estar" }],
        submittedAnswer: "estar",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "missing-correct-choice",
    });
  });

  it("rejects unknown fields in choices and choice answer specs", () => {
    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser", typo: true },
        choices,
        submittedAnswer: "ser",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });

    expect(
      checkAnswer({
        answerSpec: { kind: "choice", correctChoiceId: "ser" },
        choices: [{ id: "ser", label: "ser", typo: true }],
        submittedAnswer: "ser",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-choices",
    });
  });
});

describe("checkAnswer text answers", () => {
  it("normalizes case, repeated spaces, and accents by default", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: ["Año Nuevo"],
        },
        submittedAnswer: "  ano   nuevo ",
      }),
    ).toEqual({
      status: "correct",
      isCorrect: true,
      normalizedAnswer: "ano nuevo",
    });
  });

  it("allows text normalization defaults to be overridden", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: ["año"],
          normalizeDiacritics: false,
        },
        submittedAnswer: "ano",
      }),
    ).toEqual({
      status: "incorrect",
      isCorrect: false,
      normalizedAnswer: "ano",
    });
  });

  it("matches accepted variants only, not contains-style answers", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: ["ser"],
        },
        submittedAnswer: "ser and estar",
      }),
    ).toEqual({
      status: "incorrect",
      isCorrect: false,
      normalizedAnswer: "ser and estar",
    });
  });
});

describe("checkAnswer numeric answers", () => {
  it("parses integers, decimals, signed values, and simple fractions", () => {
    const answerSpec = {
      kind: "numeric",
      accepted: [
        { type: "decimal", value: 0.75 },
        { type: "fraction", numerator: -3, denominator: 4 },
      ],
    };

    expect(
      checkAnswer({
        answerSpec,
        submittedAnswer: "3/4",
      }),
    ).toEqual({
      status: "correct",
      isCorrect: true,
      normalizedAnswer: "0.75",
    });

    expect(
      checkAnswer({
        answerSpec,
        submittedAnswer: "-0.75",
      }),
    ).toEqual({
      status: "correct",
      isCorrect: true,
      normalizedAnswer: "-0.75",
    });
  });

  it("uses default absolute tolerance of 0.001", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [1.234],
        },
        submittedAnswer: "1.2349",
      }),
    ).toMatchObject({ status: "correct", normalizedAnswer: "1.2349" });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [1.234],
        },
        submittedAnswer: "1.2351",
      }),
    ).toMatchObject({ status: "incorrect", normalizedAnswer: "1.2351" });
  });

  it("allows explicit tolerance overrides, including exact checks", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [0.75],
          tolerance: 0,
        },
        submittedAnswer: "0.7505",
      }),
    ).toEqual({
      status: "incorrect",
      isCorrect: false,
      normalizedAnswer: "0.7505",
    });
  });

  it("returns structured invalid input for malformed numeric answers", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [0.75],
        },
        submittedAnswer: "3//4",
      }),
    ).toEqual({
      status: "invalid-input",
      isCorrect: false,
      normalizedAnswer: null,
      reason: "malformed-number",
      message: "Enter a number or fraction.",
    });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [0.75],
        },
        submittedAnswer: "3/0",
      }),
    ).toEqual({
      status: "invalid-input",
      isCorrect: false,
      normalizedAnswer: null,
      reason: "zero-denominator",
      message: "Fractions cannot have a denominator of zero.",
    });
  });

  it("rejects invalid numeric specs instead of silently grading", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [{ type: "fraction", numerator: 1, denominator: 0 }],
        },
        submittedAnswer: "1",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-accepted-number",
    });
  });
});

describe("checkAnswer unsupported and invalid specs", () => {
  it("returns unsupported for math answer specs until symbolic equivalence exists", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["6x", "6*x"],
          equivalence: "basic-symbolic",
        },
        submittedAnswer: "6*x",
      }),
    ).toEqual({
      status: "unsupported",
      isCorrect: false,
      normalizedAnswer: null,
      reason: "math-not-implemented",
      message: "Math equivalence checking is not available yet.",
    });
  });

  it("rejects invalid answer specs before grading", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: [],
        },
        submittedAnswer: "anything",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });
  });

  it("rejects whitespace-only accepted text answers", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: ["   "],
        },
        submittedAnswer: "anything",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });
  });

  it("rejects non-finite numbers and non-integer integer specs", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [{ type: "integer", value: 1.5 }],
        },
        submittedAnswer: "1.5",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [Number.POSITIVE_INFINITY],
        },
        submittedAnswer: "1",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [1],
          tolerance: Number.POSITIVE_INFINITY,
        },
        submittedAnswer: "1",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });
  });

  it("rejects unknown fields in text, numeric, math, and numeric accepted-value specs", () => {
    expect(
      checkAnswer({
        answerSpec: {
          kind: "text",
          accepted: ["ser"],
          typo: true,
        },
        submittedAnswer: "ser",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "numeric",
          accepted: [{ type: "decimal", value: 1, typo: true }],
        },
        submittedAnswer: "1",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });

    expect(
      checkAnswer({
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["6x"],
          typo: true,
        },
        submittedAnswer: "6x",
      }),
    ).toMatchObject({
      status: "invalid-spec",
      isCorrect: false,
      reason: "invalid-answer-spec",
    });
  });
});
