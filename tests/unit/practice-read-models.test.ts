import { describe, expect, it } from "vitest";

import {
  buildAnswerContract,
  resolveHistoricalAnswerContract,
} from "@/lib/practice/answer-contract";
import {
  decodeExerciseAuditCursor,
  encodeExerciseAuditCursor,
  listExercisesForAudit,
  sanitizeLocator,
  summarizeExerciseProvenance,
  type ExerciseAuditCursor,
} from "@/lib/practice/exercise-audit";
import {
  decodePracticeHistoryCursor,
  encodePracticeHistoryCursor,
  getCompletedPracticeHistoryPage,
  summarizeHistoryCorrection,
  type PracticeHistoryReadModelCursor,
} from "@/lib/practice/history-read-model";

describe("practice read model answer contracts", () => {
  it("projects complete deterministic contracts and explicit accepted variants", () => {
    const textContract = buildAnswerContract({
      kind: "text",
      policyVersion: 2,
      accepted: ["habló", "habló usted"],
      normalizeCase: true,
      normalizeWhitespace: true,
      normalizeDiacritics: false,
    });
    const numericContract = buildAnswerContract({
      kind: "numeric",
      accepted: ["1/2", 0.5],
      tolerance: 0,
    });

    expect(textContract).toMatchObject({
      kind: "text",
      comparisonPolicy: {
        comparison: "normalized-text",
        policyVersion: 2,
        normalizeCase: true,
        normalizeWhitespace: true,
        normalizeDiacritics: false,
      },
      acceptedVariants: [
        { kind: "text", value: "habló" },
        { kind: "text", value: "habló usted" },
      ],
    });
    expect(textContract?.answerSpec).toMatchObject({
      kind: "text",
      accepted: ["habló", "habló usted"],
    });
    expect(numericContract?.acceptedValues).toEqual(["1/2", 0.5]);
  });

  it("labels a missing or invalid saved contract when it falls back", () => {
    const saved = resolveHistoricalAnswerContract({
      savedAnswerPolicySnapshot: {
        kind: "text",
        policyVersion: 2,
        accepted: ["saved"],
        normalizeCase: false,
        normalizeWhitespace: false,
        normalizeDiacritics: false,
      },
      exerciseAnswerSpec: {
        kind: "text",
        policyVersion: 2,
        accepted: ["current"],
        normalizeCase: true,
        normalizeWhitespace: true,
        normalizeDiacritics: false,
      },
    });
    const missing = resolveHistoricalAnswerContract({
      savedAnswerPolicySnapshot: null,
      exerciseAnswerSpec: {
        kind: "text",
        accepted: ["habló"],
        policyVersion: 2,
        normalizeCase: true,
        normalizeWhitespace: true,
        normalizeDiacritics: false,
      },
    });
    const invalid = resolveHistoricalAnswerContract({
      savedAnswerPolicySnapshot: { kind: "text", accepted: [] },
      exerciseAnswerSpec: { kind: "choice", correctChoiceId: "right" },
      choices: [{ id: "right", label: "Right" }],
    });

    expect(saved).toMatchObject({
      source: "attempt",
      fallbackReason: null,
      contract: {
        answerSpec: { accepted: ["saved"], normalizeCase: false },
      },
    });
    expect(missing).toMatchObject({
      source: "exercise-fallback",
      fallbackReason: "missing",
      sourceLabel: "Historical exercise contract fallback (saved attempt contract unavailable)",
    });
    expect(invalid).toMatchObject({
      source: "exercise-fallback",
      fallbackReason: "invalid",
      contract: { kind: "choice", acceptedValues: ["right"] },
    });
  });

  it("keeps choice displays useful even when a stored choice list is malformed", () => {
    const contract = buildAnswerContract(
      { kind: "choice", correctChoiceId: "right" },
      [{ id: "right" }],
    );

    expect(contract).toMatchObject({
      acceptedVariants: [{ kind: "choice", choiceId: "right", display: "right" }],
      acceptedValues: ["right"],
    });
  });
});

describe("practice read model cursors", () => {
  const exerciseCursor: ExerciseAuditCursor = {
    version: 1,
    userId: "user_a",
    skillId: "skill_a",
    answerKind: "TEXT",
    lifecycle: "all",
    snapshotCutoff: "2026-09-17T12:00:00.000Z",
    createdAt: "2026-09-17T11:00:00.000Z",
    id: "exercise_b",
  };
  const historyCursor: PracticeHistoryReadModelCursor = {
    version: 1,
    userId: "user_a",
    skillId: null,
    collectionId: "collection_a",
    result: "incorrect",
    mode: "practice-only",
    snapshotCutoff: "2026-09-17T12:00:00.000Z",
    createdAt: "2026-09-17T11:00:00.000Z",
    id: "attempt_b",
  };

  it("round-trips opaque audit and history cursors with snapshot state", () => {
    expect(decodeExerciseAuditCursor(encodeExerciseAuditCursor(exerciseCursor))).toEqual(
      exerciseCursor,
    );
    expect(decodePracticeHistoryCursor(encodePracticeHistoryCursor(historyCursor))).toEqual(
      historyCursor,
    );
  });

  it("rejects malformed cursors before a database query", () => {
    expect(() => decodeExerciseAuditCursor("not-json")).toThrow(
      "The exercise audit pagination cursor is invalid.",
    );
    expect(() => decodePracticeHistoryCursor("not-json")).toThrow(
      "The completed practice history pagination cursor is invalid.",
    );
  });

  it("rejects cursors bound to different accounts or filters before reading", async () => {
    await expect(
      listExercisesForAudit({
        userId: "user_b",
        skillId: "skill_a",
        answerKind: "TEXT",
        lifecycle: "all",
        cursor: encodeExerciseAuditCursor(exerciseCursor),
      }),
    ).rejects.toThrow("does not match these filters");
    await expect(
      getCompletedPracticeHistoryPage({
        userId: "user_b",
        collectionId: "collection_a",
        result: "INCORRECT",
        mode: "practice_only",
        cursor: encodePracticeHistoryCursor(historyCursor),
      }),
    ).rejects.toThrow("does not match these filters");
  });
});

describe("practice read model safety summaries", () => {
  it("sanitizes locators and never returns storage keys", () => {
    expect(
      sanitizeLocator({
        kind: "page",
        page: 4,
        sectionId: "section_4",
        storageKey: "private/key.pdf",
        metadata: { secret: "do not return" },
      }),
    ).toEqual({ kind: "page", page: 4, sectionId: "section_4" });
  });

  it("summarizes known provenance identities without exposing arbitrary metadata", () => {
    const summary = summarizeExerciseProvenance({
      exerciseProvenance: {
        kind: "SOURCE_DERIVED",
        sourceRevisionIds: ["revision_1"],
        sourceFileIds: ["file_1"],
        evidenceAnchorIds: ["anchor_1"],
        contentHashes: ["A".repeat(64)],
        providerResponse: "private response",
        storageKey: "private/key",
      },
      exerciseSourceRefs: [{ sourceRevisionId: "revision_2", chunkId: "chunk_2" }],
      sourceRefs: [
        {
          id: "ref_1",
          sourceFileId: "file_1",
          label: "Spanish.pdf",
          kind: "PDF",
          status: "READY",
          materialRevisionId: "revision_1",
          locator: null,
          note: null,
          createdAt: new Date("2026-09-17T10:00:00.000Z"),
        },
      ],
    });

    expect(summary).toMatchObject({
      sourceBacked: true,
      kind: "SOURCE_DERIVED",
      sourceRevisionIds: ["revision_1", "revision_2"],
      sourceFileIds: ["file_1"],
      evidenceAnchorIds: ["anchor_1", "chunk_2"],
      contentHashes: ["a".repeat(64)],
    });
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("keeps pending reports separate from confirmed evidence exclusion", () => {
    const pending = summarizeHistoryCorrection([
      {
        adjudicationStatus: "PENDING",
        evidenceCorrectionStatus: "PENDING",
        practiceEvidenceNeedsCorrection: true,
        affectedReviewCount: 4,
      },
    ]);
    const confirmed = summarizeHistoryCorrection([
      {
        adjudicationStatus: "CONFIRMED",
        evidenceCorrectionStatus: "COMPLETE",
        practiceEvidenceNeedsCorrection: false,
        affectedReviewCount: 2,
      },
      {
        adjudicationStatus: "CONFIRMED",
        evidenceCorrectionStatus: "COMPLETE",
        practiceEvidenceNeedsCorrection: false,
        affectedReviewCount: 7,
      },
    ]);

    expect(pending).toMatchObject({
      status: "PENDING",
      evidenceExcluded: false,
      affectedReviewCount: 4,
    });
    expect(confirmed).toMatchObject({
      status: "COMPLETE",
      evidenceExcluded: true,
      flagCount: 2,
      affectedReviewCount: 7,
    });
  });

  it("treats a legacy correction-needed marker as pending work", () => {
    expect(
      summarizeHistoryCorrection([
        {
          adjudicationStatus: "PENDING",
          evidenceCorrectionStatus: "NOT_REQUIRED",
          practiceEvidenceNeedsCorrection: true,
          affectedReviewCount: 1,
        },
      ]),
    ).toMatchObject({
      status: "PENDING",
      evidenceCorrectionStatus: "PENDING",
      evidenceExcluded: false,
    });
  });
});
