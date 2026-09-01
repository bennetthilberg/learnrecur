import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const geminiGenerateContentMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: geminiGenerateContentMock,
    };
  },
}));

import {
  SKILL_MCQ_PROMPT_VERSION,
  createGeminiChoiceExerciseGenerator,
  createGeminiChoiceExerciseVerifier,
  validateChoiceExerciseVerification,
  type ChoiceExerciseGeneratorInput,
  type ChoiceExerciseVerifierInput,
} from "@/lib/skills";

type SolveDecision = {
  candidateId: string;
  selectedChoiceId: string | null;
  not_objectively_answerable: boolean;
  premisesConsistent: boolean;
  confidence: number;
  evidence: string;
};

type AuditDimension = {
  pass: boolean;
  evidence: string;
};

type AuditDecision = {
  candidateId: string;
  verdict: "verified" | "rejected";
  confidence: number;
  answerMatch: AuditDimension;
  premisesConsistent: AuditDimension;
  sourceAlignment: AuditDimension;
  scope: AuditDimension;
  explanation: AuditDimension;
  ambiguity: AuditDimension;
  distractorQuality: AuditDimension;
  reason: string;
  note: string | null;
};

const gemini = {
  apiMode: "enterprise-agent-platform" as const,
  endpoint: "https://aiplatform.googleapis.com/",
  model: "gemini-test",
  clientOptions: {
    vertexai: true,
    apiKey: "test-gemini-key",
    httpOptions: { apiVersion: "v1" },
  },
};

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-1",
    prompt: "A hard item asks which conclusion follows from the stated data.",
    choices: [
      { id: "a", label: "The supported conclusion" },
      { id: "b", label: "A tempting but unsupported conclusion" },
      { id: "c", label: "A conclusion that reverses the relationship" },
      { id: "d", label: "A conclusion outside the stated scope" },
    ],
    answerSpec: {
      kind: "choice" as const,
      correctChoiceId: "a",
    },
    correctAnswerDisplay: "The supported conclusion",
    explanation: "The first choice follows from the relationship in the prompt.",
    difficulty: 5,
    expectedSeconds: 120,
    ...overrides,
  };
}

function makeVerifierInput(
  candidate = makeCandidate(),
): ChoiceExerciseVerifierInput {
  return {
    skill: {
      id: "skill-1",
      title: "Interpreting a source-backed relationship",
      objective: "Choose the supported conclusion from a stated relationship.",
      rules: ["Use only the relationship stated in the prompt."],
      examples: ["Compare the given relationship before choosing an option."],
      exerciseConstraints: "Keep the item concise and objectively gradable.",
      tags: ["statistics"],
    },
    sourceContext: "The source defines the relationship and its scope.",
    sourceMedia: [],
    existingExerciseContext: null,
    candidates: [candidate],
  };
}

function makeGeneratorInput(): ChoiceExerciseGeneratorInput {
  const input = makeVerifierInput();
  return {
    skill: input.skill,
    sourceContext: input.sourceContext,
    sourceMedia: input.sourceMedia,
    existingExerciseContext: input.existingExerciseContext,
    requestedCount: 1,
  };
}

function makeSolve(
  candidate = makeCandidate(),
  overrides: Partial<SolveDecision> = {},
) {
  return {
    decisions: [
      {
        candidateId: candidate.candidateId,
        selectedChoiceId: "a",
        not_objectively_answerable: false,
        premisesConsistent: true,
        confidence: 0.86,
        evidence: "Choice a is the only option supported by the stated relationship.",
        ...overrides,
      },
    ],
  };
}

function passingDimension(evidence: string): AuditDimension {
  return { pass: true, evidence };
}

function makeAudit(
  candidate = makeCandidate(),
  overrides: Partial<AuditDecision> = {},
) {
  return {
    audits: [
      {
        candidateId: candidate.candidateId,
        verdict: "verified" as const,
        confidence: 0.88,
        answerMatch: passingDimension("The proposed answer matches the independent decision."),
        premisesConsistent: passingDimension("The quantities and relationship are consistent."),
        sourceAlignment: passingDimension("The source supports the tested relationship."),
        scope: passingDimension("The item stays within the requested skill scope."),
        explanation: passingDimension("The explanation agrees with the answer and prompt."),
        ambiguity: passingDimension("Only one choice is defensible from the prompt."),
        distractorQuality: passingDimension("Each distractor represents a plausible error."),
        reason: "other",
        note: null,
        ...overrides,
      },
    ],
  };
}

function geminiResponse(value: unknown) {
  return {
    text: JSON.stringify(value),
    candidates: [],
  };
}

function retryableGeminiError() {
  return new Error(
    JSON.stringify({
      error: {
        code: 503,
        status: "UNAVAILABLE",
        message: "The provider is temporarily unavailable.",
      },
    }),
  );
}

function metaMuseResponse(value: unknown) {
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "muse-test",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("production multiple-choice solve-first verification", () => {
  beforeEach(() => {
    geminiGenerateContentMock.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    geminiGenerateContentMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hides proposed answer fields from the independent solve call", async () => {
    const candidate = makeCandidate();
    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse(makeSolve(candidate)))
      .mockResolvedValueOnce(geminiResponse(makeAudit(candidate)));

    const rawVerification = await createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: null,
    })(makeVerifierInput(candidate));

    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);
    const solveRequest = JSON.stringify(geminiGenerateContentMock.mock.calls[0]?.[0]);
    const auditRequest = JSON.stringify(geminiGenerateContentMock.mock.calls[1]?.[0]);

    expect(solveRequest).toContain(candidate.prompt);
    expect(solveRequest).toContain("The supported conclusion");
    expect(solveRequest).not.toContain("correctChoiceId");
    expect(solveRequest).not.toContain(candidate.explanation);
    expect(auditRequest).toContain(candidate.correctAnswerDisplay);
    expect(auditRequest).toContain(candidate.explanation);

    expect(
      validateChoiceExerciseVerification({
        candidates: [candidate],
        rawVerification,
      }, { minVerifiedExercises: 1 }),
    ).toMatchObject({ status: "ready" });
  });

  it("rejects an inconsistent premise even when the audit verdict says verified", async () => {
    const candidate = makeCandidate({
      prompt:
        "A survey reports 95% support, but its confidence interval is (0.65, 0.75). Which conclusion is supported?",
    });
    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse(makeSolve(candidate)))
      .mockResolvedValueOnce(
        geminiResponse(
          makeAudit(candidate, {
            verdict: "verified",
            premisesConsistent: {
              pass: false,
              evidence: "The interval midpoint is 0.70, not the reported 0.95 estimate.",
            },
          }),
        ),
      );

    const rawVerification = await createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: null,
    })(makeVerifierInput(candidate));
    const result = validateChoiceExerciseVerification(
      { candidates: [candidate], rawVerification },
      { minVerifiedExercises: 0 },
    );

    expect(result).toMatchObject({
      status: "ready",
      exercises: [],
      decisions: [
        {
          candidateId: candidate.candidateId,
          verdict: "rejected",
          reason: "unclear_prompt",
        },
      ],
    });
  });

  it("rejects an independent answer mismatch even when the audit says verified", async () => {
    const candidate = makeCandidate();
    geminiGenerateContentMock
      .mockResolvedValueOnce(
        geminiResponse(makeSolve(candidate, { selectedChoiceId: "b" })),
      )
      .mockResolvedValueOnce(geminiResponse(makeAudit(candidate)));

    const rawVerification = await createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: null,
    })(makeVerifierInput(candidate));
    const result = validateChoiceExerciseVerification(
      { candidates: [candidate], rawVerification },
      { minVerifiedExercises: 0 },
    );

    expect(result).toMatchObject({
      status: "ready",
      exercises: [],
      decisions: [
        {
          candidateId: candidate.candidateId,
          verdict: "rejected",
          reason: "answer_mismatch",
        },
      ],
    });
  });

  it("fails closed for missing decisions, unknown selected IDs, and missing audit evidence", async () => {
    const candidate = makeCandidate();
    const verifier = createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: null,
    });

    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse({ decisions: [] }))
      .mockResolvedValueOnce(geminiResponse(makeAudit(candidate)));
    const missingDecision = await verifier(makeVerifierInput(candidate));
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);
    geminiGenerateContentMock.mockReset();

    geminiGenerateContentMock
      .mockResolvedValueOnce(
        geminiResponse(makeSolve(candidate, { selectedChoiceId: "unknown" })),
      )
      .mockResolvedValueOnce(geminiResponse(makeAudit(candidate)));
    const unknownSelectedId = await verifier(makeVerifierInput(candidate));
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);
    geminiGenerateContentMock.mockReset();

    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse(makeSolve(candidate)))
      .mockResolvedValueOnce(
        geminiResponse(
          makeAudit(candidate, {
            explanation: { pass: true } as AuditDimension,
          }),
        ),
      );
    const missingEvidence = await verifier(makeVerifierInput(candidate));
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);

    for (const rawVerification of [missingDecision, unknownSelectedId, missingEvidence]) {
      expect(
        validateChoiceExerciseVerification({
          candidates: [candidate],
          rawVerification,
        }, { minVerifiedExercises: 0 }),
      ).toMatchObject({ status: "invalid", reason: expect.any(String) });
    }
  });

  it("runs both Meta Muse stages after a retryable Gemini failure", async () => {
    const candidate = makeCandidate();
    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse(makeSolve(candidate)))
      .mockRejectedValueOnce(retryableGeminiError());
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const stage = body.text.format.name === "choiceExerciseSolve" ? "solve" : "audit";
      return metaMuseResponse(
        stage === "solve" ? makeSolve(candidate) : makeAudit(candidate),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rawVerification = await createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: {
        apiKey: "test-meta-key",
        baseUrl: "https://meta.example.test/v1",
        model: "muse-test",
      },
    })(makeVerifierInput(candidate));

    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => {
        const body = JSON.parse(String(init?.body));
        return body.text.format.name;
      }),
    ).toEqual(["choiceExerciseSolve", "choiceExerciseAudit"]);

    const metaSolveRequest = JSON.stringify(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    );
    expect(metaSolveRequest).not.toContain("correctAnswerDisplay");
    expect(metaSolveRequest).not.toContain(candidate.explanation);

    expect(
      validateChoiceExerciseVerification({
        candidates: [candidate],
        rawVerification,
      }, { minVerifiedExercises: 1 }),
    ).toMatchObject({ status: "ready" });
  });

  it("accepts a valid hard item only after both stages provide complete evidence", async () => {
    const candidate = makeCandidate({ difficulty: 5, expectedSeconds: 180 });
    geminiGenerateContentMock
      .mockResolvedValueOnce(geminiResponse(makeSolve(candidate)))
      .mockResolvedValueOnce(geminiResponse(makeAudit(candidate)));

    const rawVerification = await createGeminiChoiceExerciseVerifier({
      gemini,
      metaMuseFallback: null,
    })(makeVerifierInput(candidate));
    const result = validateChoiceExerciseVerification(
      { candidates: [candidate], rawVerification },
      { minVerifiedExercises: 1 },
    );

    expect(result).toMatchObject({
      status: "ready",
      exercises: [
        expect.objectContaining({
          prompt: candidate.prompt,
          difficulty: 5,
          expectedSeconds: 180,
        }),
      ],
    });
  });

  it("uses prompt version v1 and carries repair context into generation", async () => {
    const repairContext = "Repair the interval midpoint after the prior candidate was rejected.";
    geminiGenerateContentMock.mockResolvedValueOnce(
      geminiResponse({
        exercises: [
          {
            prompt: "Which conclusion follows from the stated relationship?",
            choices: [
              { id: "a", label: "The supported conclusion" },
              { id: "b", label: "A tempting alternative" },
              { id: "c", label: "An unrelated conclusion" },
            ],
            correctChoiceId: "a",
            explanation: "The first choice follows from the stated relationship.",
            difficulty: 5,
            expectedSeconds: 120,
          },
        ],
      }),
    );

    await createGeminiChoiceExerciseGenerator({ gemini, metaMuseFallback: null })({
      ...makeGeneratorInput(),
      repairContext,
    });

    expect(SKILL_MCQ_PROMPT_VERSION).toBe("skill-mcq-v1");
    const generationRequest = JSON.stringify(geminiGenerateContentMock.mock.calls[0]?.[0]);
    expect(generationRequest).toContain("internally consistent");
    expect(generationRequest).toContain("explanation must agree");
    expect(generationRequest).toContain(repairContext);
  });
});
