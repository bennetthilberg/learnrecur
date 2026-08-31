import { describe, expect, it } from "vitest";

import {
  MAX_BLUEPRINT_SLOTS,
  assessSkillSpecEvolution,
  classifyAttemptEvidence,
  planExerciseBlueprint,
  type AttemptEvidenceInput,
  type GenerationProfile,
  type RecentExercise,
  type SkillGenerationSpec,
  validateCandidateBatchDiversity,
} from "@/lib/skills/exercise-planning";

const now = new Date("2026-08-31T12:00:00.000Z");

function skillSpec(overrides: Partial<SkillGenerationSpec> = {}): SkillGenerationSpec {
  return {
    skillId: "skill-ser-estar",
    specVersion: "skill-spec-v1",
    fingerprint: "spec-fingerprint-1",
    materialFingerprint: "material-fingerprint-1",
    title: "ser versus estar",
    objective: "Choose between ser and estar in short Spanish sentences.",
    observableSuccessCriteria: ["Select the verb that matches the stated rule."],
    scope: {
      included: ["identity", "location", "temporary state"],
      excluded: ["past participle agreement"],
    },
    allowedAnswerModes: ["choice", "text"],
    sourceRequirements: {
      required: false,
      anchors: ["chapter-4"],
    },
    misconceptions: ["location always uses ser"],
    allowedExerciseFamilies: [
      "recognition-choice",
      "cued-recall",
      "exact-recall",
      "application-context",
      "interleaved-choice",
      "delayed-transfer",
    ],
    subjectCapability: "language_form",
    ...overrides,
  };
}

function profile(overrides: Partial<GenerationProfile> = {}): GenerationProfile {
  return {
    fsrsState: "REVIEW",
    dueAt: now,
    now,
    lapses: 0,
    repetitions: 4,
    recentRatings: ["GOOD", "GOOD", "EASY"],
    desiredCount: 5,
    supportedAnswerModes: ["choice", "text"],
    subjectCapability: "language_form",
    stability: 12,
    ...overrides,
  };
}

function recentExercise(overrides: Partial<RecentExercise> = {}): RecentExercise {
  return {
    id: "exercise-1",
    family: "recognition-choice",
    retrievalStage: "recognition",
    answerMode: "choice",
    surfaceFeatures: ["location", "present-tense"],
    freshnessKey: "fresh-1",
    ...overrides,
  };
}

describe("planExerciseBlueprint", () => {
  it("is deterministic, bounded, and progresses a stable review from recall to transfer", () => {
    const input = {
      skillSpec: skillSpec(),
      generationProfile: profile(),
      recentExercises: [recentExercise()],
    };

    const first = planExerciseBlueprint(input);
    const second = planExerciseBlueprint(input);

    expect(first).toEqual(second);
    expect(first.slots).toHaveLength(5);
    expect(first.slots.length).toBeLessThanOrEqual(MAX_BLUEPRINT_SLOTS);
    expect(new Set(first.slots.map((slot) => slot.id)).size).toBe(first.slots.length);
    expect(first.slots.map((slot) => slot.retrievalStage)).toEqual([
      "exact_recall",
      "application",
      "interleaved_discrimination",
      "delayed_transfer",
      "exact_recall",
    ]);
    expect(first.slots.some((slot) => slot.evidenceClass === "independent_retention")).toBe(
      true,
    );
    expect(first.memoryState.dueStatus).toBe("due");
    expect(first.reasonCodes).toContain("due_now");
  });

  it("uses scaffolded progression for a new or lapsed skill and does not claim mastery evidence", () => {
    const result = planExerciseBlueprint({
      skillSpec: skillSpec(),
      generationProfile: profile({
        fsrsState: "NEW",
        dueAt: new Date("2026-09-01T12:00:00.000Z"),
        lapses: 2,
        repetitions: 0,
        recentRatings: ["AGAIN", "HARD"],
        desiredCount: 6,
      }),
      recentExercises: [],
    });

    expect(result.slots.map((slot) => slot.retrievalStage)).toEqual([
      "recognition",
      "recognition",
      "cued_recall",
      "cued_recall",
      "exact_recall",
      "application",
    ]);
    expect(result.slots.slice(0, 4).every((slot) => slot.evidenceClass === "learning")).toBe(
      true,
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["new_or_uncertain", "lapse_recovery", "due_soon"]),
    );
    expect(result.slots[0].assistancePolicy).toBe("optional_scaffold");
  });

  it("clamps excessive counts and keeps unsupported subject capabilities fail-closed", () => {
    const result = planExerciseBlueprint({
      skillSpec: skillSpec({ subjectCapability: "unsupported" }),
      generationProfile: profile({ desiredCount: 100, subjectCapability: "unsupported" }),
      recentExercises: [],
    });

    expect(result.slots).toEqual([]);
    expect(result.requestedCount).toBe(100);
    expect(result.plannedCount).toBe(0);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["count_clamped", "unsupported_subject_capability"]),
    );
    expect(result.status).toBe("manual_review");
  });

  it("selects only the intersection of spec, profile, and subject capability answer modes", () => {
    const result = planExerciseBlueprint({
      skillSpec: skillSpec({ allowedAnswerModes: ["choice", "text", "numeric"] }),
      generationProfile: profile({
        desiredCount: 4,
        supportedAnswerModes: ["numeric", "math"],
        subjectCapability: "symbolic_numeric",
      }),
      recentExercises: [],
    });

    expect(result.slots).toHaveLength(4);
    expect(result.slots.every((slot) => slot.answerMode === "numeric")).toBe(true);
    expect(result.reasonCodes).toContain("answer_mode_intersection");
  });

  it("avoids a recently used family before repeating it when alternatives are available", () => {
    const result = planExerciseBlueprint({
      skillSpec: skillSpec(),
      generationProfile: profile({ desiredCount: 3 }),
      recentExercises: [
        recentExercise({
          family: "exact-recall",
          retrievalStage: "exact_recall",
          answerMode: "text",
        }),
      ],
    });

    expect(result.slots[0].family).not.toBe("exact-recall");
    expect(result.slots[0].noveltyRequirements.avoidFamilies).toContain("exact-recall");
  });
});

describe("classifyAttemptEvidence", () => {
  const cases: Array<{
    name: string;
    input: AttemptEvidenceInput;
    kind: string;
    independent: boolean;
    evidence: string;
  }> = [
    {
      name: "cold correct",
      input: { isCorrect: true, attemptNumber: 1, cold: true },
      kind: "independent_retention",
      independent: true,
      evidence: "retention",
    },
    {
      name: "correct after a hint",
      input: { isCorrect: true, hintsUsed: 1 },
      kind: "assisted_learning",
      independent: false,
      evidence: "learning",
    },
    {
      name: "correct retry",
      input: { isCorrect: true, retryCount: 1 },
      kind: "assisted_learning",
      independent: false,
      evidence: "learning",
    },
    {
      name: "guided completion",
      input: { isCorrect: true, guidedCompletion: true, cueLevel: "guided" },
      kind: "assisted_learning",
      independent: false,
      evidence: "learning",
    },
    {
      name: "worked example",
      input: { isCorrect: true, workedExampleShown: true },
      kind: "assisted_learning",
      independent: false,
      evidence: "learning",
    },
    {
      name: "cold incorrect",
      input: { isCorrect: false, attemptNumber: 1, cold: true },
      kind: "independent_failure",
      independent: false,
      evidence: "none",
    },
    {
      name: "skipped",
      input: { result: "skipped" },
      kind: "skipped",
      independent: false,
      evidence: "none",
    },
  ];

  it.each(cases)("classifies $name without inflating retention", ({ input, kind, independent, evidence }) => {
    const result = classifyAttemptEvidence(input);

    expect(result.kind).toBe(kind);
    expect(result.isIndependentRetention).toBe(independent);
    expect(result.evidence).toBe(evidence);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
  });

  it("requires a cold cue for explicitly guided Demo-Duo-Solo work", () => {
    const guided = classifyAttemptEvidence({
      isCorrect: true,
      guidedCompletion: true,
      cueLevel: "solo",
      cold: false,
    });
    const coldSolo = classifyAttemptEvidence({
      isCorrect: true,
      cueLevel: "solo",
      cold: true,
    });

    expect(guided.isIndependentRetention).toBe(false);
    expect(guided.reasonCodes).toContain("guided_completion");
    expect(coldSolo.isIndependentRetention).toBe(true);
  });

  it("treats answer reveals and non-finite assistance counts conservatively", () => {
    const revealed = classifyAttemptEvidence({
      isCorrect: true,
      answerRevealed: true,
      hintsUsed: Number.NaN,
    });

    expect(revealed.kind).toBe("assisted_learning");
    expect(revealed.isIndependentRetention).toBe(false);
    expect(revealed.reasonCodes).toContain("answer_revealed");
  });
});

describe("assessSkillSpecEvolution", () => {
  it("keeps exercises when the specification and material fingerprints are unchanged", () => {
    const result = assessSkillSpecEvolution({
      previousSpec: skillSpec(),
      nextSpec: skillSpec(),
      materialChanged: false,
    });

    expect(result.decision).toBe("keep");
    expect(result.reasonCodes).toContain("fingerprints_unchanged");
  });

  it("reverifies source evidence when material changes without changing the retrieval target", () => {
    const result = assessSkillSpecEvolution({
      previousSpec: skillSpec(),
      nextSpec: skillSpec({ materialFingerprint: "material-fingerprint-2" }),
      materialChanged: true,
    });

    expect(result.decision).toBe("reverify");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["material_changed", "material_fingerprint_changed"]),
    );
    expect(result.reuseFsrsState).toBe(true);
  });

  it("retires incompatible exercises when scope or retrieval target changes", () => {
    const result = assessSkillSpecEvolution({
      previousSpec: skillSpec(),
      nextSpec: skillSpec({
        fingerprint: "spec-fingerprint-2",
        scope: {
          included: ["past participle agreement"],
          excluded: ["identity", "location", "temporary state"],
        },
      }),
      scopeChanged: true,
    });

    expect(result.decision).toBe("retire");
    expect(result.reuseFsrsState).toBe(false);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["scope_changed", "retrieval_target_changed"]),
    );
  });

  it("reverifies a changed fingerprint by default but does not retire for a policy-only change", () => {
    const result = assessSkillSpecEvolution({
      previousSpec: skillSpec(),
      nextSpec: skillSpec({ fingerprint: "spec-fingerprint-2" }),
    });

    expect(result.decision).toBe("reverify");
    expect(result.reasonCodes).toContain("spec_fingerprint_changed");
    expect(result.reuseFsrsState).toBe(true);
  });
});

describe("validateCandidateBatchDiversity", () => {
  it("accepts meaningful family and surface variation", () => {
    const result = validateCandidateBatchDiversity([
      {
        candidateId: "candidate-1",
        family: "recognition-choice",
        retrievalStage: "recognition",
        answerMode: "choice",
        surfaceFeatures: ["location", "present"],
        prompt: "Choose the correct verb for Madrid.",
      },
      {
        candidateId: "candidate-2",
        family: "cued-recall",
        retrievalStage: "cued_recall",
        answerMode: "text",
        surfaceFeatures: ["identity", "past"],
        prompt: "Complete the sentence with the correct verb.",
      },
      {
        candidateId: "candidate-3",
        family: "application-context",
        retrievalStage: "application",
        answerMode: "text",
        surfaceFeatures: ["temporary-state", "present"],
        prompt: "Write the verb that fits the situation.",
      },
    ]);

    expect(result.valid).toBe(true);
    expect(result.distinctFamilies).toBe(3);
    expect(result.reasonCodes).toEqual([]);
  });

  it("rejects exact duplicates, repeated family surfaces, and family concentration", () => {
    const result = validateCandidateBatchDiversity([
      {
        candidateId: "candidate-1",
        family: "recognition-choice",
        answerMode: "choice",
        surfaceFeatures: ["location"],
        prompt: "Choose estar for the location.",
        freshnessKey: "same",
      },
      {
        candidateId: "candidate-2",
        family: "recognition-choice",
        answerMode: "choice",
        surfaceFeatures: ["location"],
        prompt: "Choose estar for the location.",
        freshnessKey: "same",
      },
      {
        candidateId: "candidate-3",
        family: "recognition-choice",
        answerMode: "choice",
        surfaceFeatures: ["location"],
        prompt: "Choose estar for the location.",
        freshnessKey: "different",
      },
      {
        candidateId: "candidate-4",
        family: "recognition-choice",
        answerMode: "choice",
        surfaceFeatures: ["location"],
        prompt: "Choose estar for the location.",
        freshnessKey: "different-2",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "duplicate_candidate",
        "family_surface_repeat",
        "family_concentration",
      ]),
    );
    expect(result.duplicateCandidateIds).toEqual(expect.arrayContaining(["candidate-2"]));
  });

  it("checks recent exercise history and can be configured for a single-family batch", () => {
    const result = validateCandidateBatchDiversity(
      [
        {
          candidateId: "candidate-1",
          family: "exact-recall",
          answerMode: "text",
          surfaceFeatures: ["location"],
          freshnessKey: "old-key",
          prompt: "Use estar for location.",
        },
        {
          candidateId: "candidate-2",
          family: "exact-recall",
          answerMode: "text",
          surfaceFeatures: ["identity"],
          freshnessKey: "new-key",
          prompt: "Use ser for identity.",
        },
      ],
      {
        recentExercises: [
          recentExercise({
            family: "exact-recall",
            retrievalStage: "exact_recall",
            answerMode: "text",
            surfaceFeatures: ["location"],
            freshnessKey: "old-key",
            prompt: "Use estar for location.",
          }),
        ],
        minDistinctFamilies: 1,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("recent_duplicate");
    expect(result.reasonCodes).not.toContain("family_concentration");
  });

  it("fails closed for malformed candidates instead of treating missing families as diverse", () => {
    const result = validateCandidateBatchDiversity([
      { candidateId: "candidate-1", prompt: "No family" },
      { candidateId: "candidate-2", family: "" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("missing_family");
    expect(result.invalidCandidateIds).toEqual(
      expect.arrayContaining(["candidate-1", "candidate-2"]),
    );
  });
});
