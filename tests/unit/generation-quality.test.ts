import { describe, expect, it } from "vitest";

import {
  GENERATION_QUALITY_CONTRACT_VERSION,
  assessChoiceCandidateQuality,
  assessChoiceCandidatesQuality,
  assessPromptNumericConsistency,
  blueprintSlotSchema,
  candidateAcceptanceDecisionSchema,
  contextManifestSchema,
  exerciseBlueprintSchema,
  skillGenerationSpecSchema,
  type ChoiceCandidateInput,
} from "@/lib/skills/generation-quality";

const baseCandidate = (
  overrides: Partial<ChoiceCandidateInput> = {},
): ChoiceCandidateInput => ({
  candidateId: "candidate-1",
  prompt:
    "A survey estimates that 70% of respondents support the proposal. The 95% confidence interval for the population proportion is (0.65, 0.75). Which statement is best supported?",
  choices: [
    { id: "a", label: "The estimate is below the interval." },
    { id: "b", label: "The estimate is inside the interval." },
    { id: "c", label: "The interval proves every respondent supports it." },
  ],
  answerSpec: {
    kind: "choice",
    correctChoiceId: "b",
  },
  correctAnswerDisplay: "The estimate is inside the interval.",
  explanation:
    "The correct answer is option b because 0.70 lies between 0.65 and 0.75.",
  difficulty: 2,
  expectedSeconds: 30,
  ...overrides,
});

const validSkillSpec = () => ({
  contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
  specVersion: "skill-spec-2026-08-31-1",
  objective: "Interpret a sample proportion and its confidence interval.",
  observableSuccessCriteria: [
    "Identify the reported sample proportion.",
    "Determine whether the estimate lies within the stated interval.",
  ],
  prerequisiteAssumptions: ["The learner can compare decimal values."],
  scopeBoundaries: {
    included: ["Percentage estimates and confidence intervals for proportions."],
    excluded: ["Deriving confidence intervals from raw sample data."],
  },
  sourceRequirements: {
    required: true,
    minimumEvidenceAnchors: 1,
    allowedProvenance: ["learner-source"],
  },
  allowedExerciseModes: ["recall", "discrimination", "application", "transfer"],
  difficultyPolicy: {
    min: 1,
    max: 4,
    target: 2,
    progression: "mastery-aware",
    dimensions: ["cueing", "number-complexity", "transfer-distance"],
  },
  explanationPolicy: {
    required: true,
    maxLength: 400,
    includeRule: true,
    includeDistractorRationale: false,
  },
  ambiguityPolicy: {
    action: "reject",
    requireSingleDefensibleAnswer: true,
    disallowUnstatedAssumptions: true,
  },
  materialFingerprint: "material-sha256-abc123",
});

const validBlueprintSlot = () => ({
  slotId: "slot-1",
  mode: "application" as const,
  targetDifficulty: 2,
  misconceptionOrDistractorPurpose: "Confuse the point estimate with the interval width.",
  answerMode: "choice" as const,
  sourceRequirements: {
    required: true,
    evidenceIds: ["evidence-1"],
  },
  noveltyConstraints: {
    avoidPromptFingerprints: ["prompt-sha256-old"],
    avoidCandidateIds: ["candidate-old"],
    minimumSurfaceChange: "change the population context",
  },
  familyConstraints: {
    allowedFamilies: ["proportion-ci-interpretation"],
    excludedFamilies: ["raw-ci-derivation"],
    maxSlotsPerFamily: 2,
  },
  evidenceMode: "retention" as const,
});

describe("versioned generation quality contracts", () => {
  it("exposes the stable contract version and accepts a complete skill specification", () => {
    expect(GENERATION_QUALITY_CONTRACT_VERSION).toBe("generation-quality-v1");
    expect(skillGenerationSpecSchema.safeParse(validSkillSpec()).success).toBe(true);
  });

  it.each([
    ["missing contract version", { ...validSkillSpec(), contractVersion: undefined }],
    ["unknown exercise mode", { ...validSkillSpec(), allowedExerciseModes: ["essay"] }],
    ["reversed difficulty bounds", {
      ...validSkillSpec(),
      difficultyPolicy: { ...validSkillSpec().difficultyPolicy, min: 5, max: 2 },
    }],
    ["empty observable criterion", {
      ...validSkillSpec(),
      observableSuccessCriteria: [""],
    }],
  ])("rejects malformed skill specifications: %s", (_name, value) => {
    expect(skillGenerationSpecSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a blueprint and its individual slot as versioned contracts", () => {
    const slot = validBlueprintSlot();
    const blueprint = {
      contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
      blueprintVersion: "blueprint-2026-08-31-1",
      skillSpecVersion: "skill-spec-2026-08-31-1",
      requestedCount: 1,
      slots: [slot],
    };

    expect(blueprintSlotSchema.safeParse(slot).success).toBe(true);
    expect(exerciseBlueprintSchema.safeParse(blueprint).success).toBe(true);
  });

  it("rejects a blueprint slot with an unsupported mode or impossible difficulty", () => {
    expect(
      blueprintSlotSchema.safeParse({ ...validBlueprintSlot(), mode: "procedure" }).success,
    ).toBe(false);
    expect(
      blueprintSlotSchema.safeParse({ ...validBlueprintSlot(), targetDifficulty: 6 }).success,
    ).toBe(false);
  });

  it("accepts a manifest with included and omitted evidence plus accounting", () => {
    const manifest = {
      contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
      manifestVersion: "context-manifest-1",
      privacyClassification: "private",
      includedSources: [
        {
          sourceId: "source-1",
          revisionId: "revision-1",
          locator: "page 4, paragraph 2",
          fingerprint: "source-sha256-1",
          charactersIncluded: 320,
        },
      ],
      omittedSources: [
        {
          sourceId: "source-2",
          fingerprint: "source-sha256-2",
          reason: "outside-requested-scope",
        },
      ],
      truncationNotices: [
        {
          field: "source-1.extractedText",
          sourceId: "source-1",
          originalCharacters: 500,
          includedCharacters: 320,
          reason: "transport-limit",
        },
      ],
      sourceFingerprints: [
        { sourceId: "source-1", fingerprint: "source-sha256-1" },
        { sourceId: "source-2", fingerprint: "source-sha256-2" },
      ],
      fieldLengthAccounting: {
        "source-1.extractedText": {
          originalCharacters: 500,
          includedCharacters: 320,
          limitCharacters: 320,
          truncated: true,
        },
      },
    };

    expect(contextManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects contradictory or malformed manifest accounting", () => {
    const malformed = {
      contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
      manifestVersion: "context-manifest-1",
      privacyClassification: "private",
      includedSources: [
        {
          sourceId: "source-1",
          fingerprint: "source-sha256-1",
          charactersIncluded: 400,
        },
        {
          sourceId: "source-1",
          fingerprint: "source-sha256-duplicate",
          charactersIncluded: 20,
        },
      ],
      omittedSources: [],
      truncationNotices: [
        {
          field: "source-1.extractedText",
          sourceId: "source-1",
          originalCharacters: 10,
          includedCharacters: 20,
          reason: "field-limit",
        },
      ],
      sourceFingerprints: [{ sourceId: "source-1", fingerprint: "source-sha256-1" }],
      fieldLengthAccounting: {},
    };

    expect(contextManifestSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("deterministic proportion and confidence-interval assessment", () => {
  it.each([
    [
      "percentage estimate against decimal interval",
      "A survey found that 70% of respondents support the proposal. Its 95% confidence interval is (0.65, 0.75).",
    ],
    [
      "decimal proportion against percentage interval",
      "The observed proportion is 0.70 and its 95% confidence interval is [65%, 75%].",
    ],
    [
      "inclusive upper boundary",
      "The estimate is 75%, and the confidence interval is (0.65, 0.75).",
    ],
    [
      "unmarked percentage interval",
      "The sample proportion is 70%, and its confidence interval is (65, 75).",
    ],
    [
      "unrelated mean interval",
      "A 95% confidence interval for the mean number of pages is (65, 75). Select the median.",
    ],
    [
      "estimated mean language",
      "The estimated mean is 105 pages and its 95% confidence interval is (95, 115).",
    ],
  ])("accepts a consistent or unrelated numeric relationship: %s", (_name, prompt) => {
    const result = assessPromptNumericConsistency(prompt);

    expect(result.status).toBe("consistent");
    expect(result.rejectCodes).toEqual([]);
  });

  it.each([
    [
      "percentage estimate outside decimal interval",
      "A survey found that 95% of volunteers support the initiative. Its 95% confidence interval is (0.65, 0.75).",
    ],
    [
      "decimal proportion outside percentage interval",
      "The sample proportion is 0.95, with a 95% confidence interval of (65%, 75%).",
    ],
    [
      "reversed confidence interval bounds",
      "The estimated support is 70%, and the 95% confidence interval is (0.75, 0.65).",
    ],
    [
      "percentage outside percentage interval",
      "The observed rate is 20 percent, while the 95% confidence interval is [65%, 75%].",
    ],
    [
      "invalid proportion",
      "The reported proportion is 105% of respondents, with a confidence interval of (0.65, 0.75).",
    ],
  ])("rejects an invalid numeric relationship: %s", (_name, prompt) => {
    const result = assessPromptNumericConsistency(prompt);

    expect(result.status).toBe("inconsistent");
    expect(result.rejectCodes.length).toBeGreaterThan(0);
  });

  it("does not treat the confidence level or unrelated numbers as a proportion estimate", () => {
    const result = assessPromptNumericConsistency(
      "Use a 95% confidence interval for the mean completion time. The interval is (65, 75) seconds and the sample has 95 volunteers.",
    );

    expect(result.status).toBe("consistent");
    expect(result.rejectCodes).not.toContain("confidence-interval-mismatch");
  });

  it("rejects the known inconsistent candidate even when a model says it is valid", () => {
    const decision = assessChoiceCandidateQuality(
      baseCandidate({
        prompt:
          "A report says 95% of sampled volunteers support the initiative, with a 95% confidence interval of (0.65, 0.75). Which conclusion follows?",
        explanation: "The correct answer is option b because the report provides the estimate.",
      }),
      { modelDecision: { verdict: "verified", note: "model marked valid" } },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes).toContain("confidence-interval-mismatch");
    expect(
      decision.stageOutcomes.find((stage) => stage.stage === "semantic-consistency")?.outcome,
    ).toBe("fail");
  });
});

describe("choice candidate contracts and deterministic quality decisions", () => {
  it.each([
    ["duplicate choice IDs", {
      choices: [
        { id: "a", label: "First" },
        { id: "a", label: "Second" },
      ],
      answerSpec: { kind: "choice" as const, correctChoiceId: "a" },
      correctAnswerDisplay: "First",
    }],
    ["duplicate choice labels", {
      choices: [
        { id: "a", label: "Same answer" },
        { id: "b", label: "  same   answer  " },
      ],
      answerSpec: { kind: "choice" as const, correctChoiceId: "a" },
      correctAnswerDisplay: "Same answer",
    }],
  ])("rejects non-unique answer choices: %s", (_name, override) => {
    const decision = assessChoiceCandidateQuality(baseCandidate(override));

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes.some((code) => code.startsWith("duplicate-choice"))).toBe(true);
  });

  it("accepts a candidate with unique choices and consistent display answer", () => {
    const decision = assessChoiceCandidateQuality(
      baseCandidate({ correctChoiceIndex: 1 }),
    );

    expect(decision.accepted).toBe(true);
    expect(decision.rejectCodes).toEqual([]);
    expect(candidateAcceptanceDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["missing correct choice", {
      answerSpec: { kind: "choice" as const, correctChoiceId: "missing" },
    }],
    ["wrong zero-based index", { correctChoiceIndex: 0 }],
    ["display answer mismatch", { correctAnswerDisplay: "The estimate is below the interval." }],
    ["top-level ID disagrees with answer spec", {
      correctChoiceId: "a",
    }],
  ])("fails closed on correct-answer inconsistency: %s", (_name, override) => {
    const decision = assessChoiceCandidateQuality(baseCandidate(override));

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes.length).toBeGreaterThan(0);
    expect(decision.stageOutcomes.some((stage) => stage.outcome === "fail")).toBe(true);
  });

  it.each([
    ["explicit wrong option", "The correct answer is option a because it is closest."],
    ["explicit wrong label", "The answer is \"The estimate is below the interval.\"."],
  ])("rejects an explanation that explicitly names the wrong answer: %s", (_name, explanation) => {
    const decision = assessChoiceCandidateQuality(baseCandidate({ explanation }));

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes).toContain("explanation-answer-mismatch");
  });

  it("does not infer an explanation contradiction from an unrelated number", () => {
    const decision = assessChoiceCandidateQuality(
      baseCandidate({
        explanation: "The survey included 95 volunteers; option b compares the estimate with the interval.",
      }),
    );

    expect(decision.accepted).toBe(true);
    expect(decision.rejectCodes).toEqual([]);
  });

  it("does not treat a bare article as a choice ID", () => {
    const decision = assessChoiceCandidateQuality(
      baseCandidate({
        explanation: "The answer is a completed action supported by the stated relationship.",
      }),
    );

    expect(decision.accepted).toBe(true);
    expect(decision.rejectCodes).not.toContain("explanation-answer-mismatch");
  });

  it("recognizes a bare choice ID followed by a bounded explanation", () => {
    const decision = assessChoiceCandidateQuality(
      baseCandidate({ explanation: "The answer is a because it follows from the interval." }),
    );

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes).toContain("explanation-answer-mismatch");
  });

  it.each([
    null,
    undefined,
    {},
    { candidateId: "candidate-1", prompt: "too short" },
    { candidateId: "candidate-1", prompt: "A valid prompt", choices: "not-an-array" },
  ])("fails closed for malformed candidate input: %j", (candidate) => {
    const decision = assessChoiceCandidateQuality(candidate);

    expect(decision.accepted).toBe(false);
    expect(decision.rejectCodes).toContain("malformed-candidate");
    expect(() => candidateAcceptanceDecisionSchema.parse(decision)).not.toThrow();
  });

  it("rejects duplicate candidates in a batch without rewriting either candidate", () => {
    const first = baseCandidate();
    const second = { ...first, candidateId: "candidate-2" };
    const result = assessChoiceCandidatesQuality([first, second]);

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]?.accepted).toBe(true);
    expect(result.decisions[1]?.rejectCodes).toContain("duplicate-candidate");
    expect(result.acceptedCandidates).toEqual([first]);
    expect(result.rejectedCandidates).toEqual([second]);
  });
});
