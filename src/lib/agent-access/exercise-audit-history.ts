import "server-only";

import { authorizeAgentRead } from "@/lib/agent-access/access";
import type { AgentAuthContext } from "@/lib/agent-access/auth";
import {
  agentExerciseAuditGetSchema,
  agentExerciseAuditListSchema,
  agentPracticeHistorySchema,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  ExerciseAuditCursorError,
  getExerciseForAudit,
  listExercisesForAudit,
  type ExerciseAuditRecord,
} from "@/lib/practice/exercise-audit";
import {
  getCompletedPracticeHistoryPage,
  PracticeHistoryCursorError,
  type CompletedPracticeHistoryAttempt,
} from "@/lib/practice/history-read-model";

/**
 * MCP adapters for the deliberate, answer-bearing audit/history surfaces.
 * These adapters keep consent, ownership, pagination, and public naming at
 * the transport boundary while the read models remain reusable by the app.
 */
export async function listAgentExerciseAudit(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentExerciseAuditListSchema.parse(rawInput);
  await authorizeAgentRead(auth, "exercises:audit");

  try {
    const page = await listExercisesForAudit({
      userId: auth.userId,
      skillId: input.skill_id,
      answerKind: input.answer_kind,
      lifecycle: input.lifecycle,
      limit: input.limit,
      cursor: input.cursor,
    });

    return {
      skill_id: input.skill_id,
      lifecycle: input.lifecycle,
      snapshot_cutoff: page.snapshotCutoff.toISOString(),
      exercises: page.exercises.map(toPublicAuditRecord),
      next_cursor: page.nextCursor,
    };
  } catch (error) {
    throw mapReadModelError(error, "The exercise audit request could not be read.");
  }
}

export async function getAgentExerciseAudit(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentExerciseAuditGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "exercises:audit");

  const result = await getExerciseForAudit({
    userId: auth.userId,
    exerciseId: input.exercise_id,
  });
  if (result.status === "not-found") {
    throw new AgentOperationError("exercise_not_found", result.message);
  }

  return toPublicAuditRecord(result.exercise);
}

export async function getAgentPracticeHistory(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentPracticeHistorySchema.parse(rawInput);
  await authorizeAgentRead(auth, "practice:history");

  try {
    const page = await getCompletedPracticeHistoryPage({
      userId: auth.userId,
      skillId: input.skill_id,
      collectionId: input.collection_id,
      result: input.result,
      mode: input.mode,
      limit: input.limit,
      cursor: input.cursor,
    });

    return {
      history: page.attempts.map(toPublicHistoryAttempt),
      snapshot_cutoff: page.snapshotCutoff.toISOString(),
      next_cursor: page.nextCursor,
    };
  } catch (error) {
    throw mapReadModelError(error, "The completed practice history could not be read.");
  }
}

function toPublicAuditRecord(record: ExerciseAuditRecord): Record<string, unknown> {
  return {
    exercise_id: record.exerciseId,
    skill_id: record.skillId,
    skill_title: record.skillTitle,
    skill_status: record.skillStatus,
    type: record.type,
    answer_kind: record.answerKind,
    prompt: record.prompt,
    instruction: record.instruction,
    content: record.content,
    prompt_layout: toPublicValue(record.promptLayout),
    choices: toPublicValue(record.choices),
    answer_spec: toPublicValue(record.answerSpec),
    answer_contract: toPublicValue(record.answerContract),
    comparison_policy: toPublicValue(record.comparisonPolicy),
    accepted_variants: toPublicValue(record.acceptedVariants),
    accepted_values: toPublicValue(record.acceptedValues),
    correct_answer_display: record.correctAnswerDisplay,
    explanation: record.explanation,
    difficulty: record.difficulty,
    expected_seconds: record.expectedSeconds,
    verification_status: record.verificationStatus,
    verification: toPublicValue(record.verificationSummary),
    acceptance_decision: record.acceptanceDecision,
    lifecycle: record.lifecycle,
    retired_at: record.retiredAt?.toISOString() ?? null,
    retirement_reason: record.retirementReason,
    retirement: toPublicValue(record.retirement),
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    revision: record.revision,
    record_revision: record.recordRevision,
    skill_spec_version: record.skillSpecVersion,
    skill_spec_fingerprint: record.skillSpecFingerprint,
    exercise_spec_version: record.exerciseSpecVersion,
    blueprint: {
      version: record.blueprintVersion,
      slot: record.blueprintSlot,
      family: record.exerciseFamily,
    },
    quality_version: record.qualityVersion,
    source_refs: record.sourceRefs.map((sourceRef) => ({
      source_ref_id: sourceRef.id,
      source_file_id: sourceRef.sourceFileId,
      label: sourceRef.label,
      kind: sourceRef.kind,
      status: sourceRef.status,
      material_revision_id: sourceRef.materialRevisionId,
      locator: toPublicValue(sourceRef.locator),
      note: sourceRef.note,
      created_at: sourceRef.createdAt.toISOString(),
    })),
    provenance: toPublicValue(record.provenance),
  };
}

function toPublicHistoryAttempt(
  attempt: CompletedPracticeHistoryAttempt,
): Record<string, unknown> {
  return {
    attempt_id: attempt.exerciseAttemptId,
    exercise_attempt_id: attempt.exerciseAttemptId,
    review_log_id: attempt.reviewLogId,
    exercise_id: attempt.exerciseId,
    skill_id: attempt.skillId,
    skill_title: attempt.skillTitle,
    skill_status: attempt.skillStatus,
    collection_id: attempt.collectionId,
    collection_name: attempt.collectionName,
    type: attempt.type,
    answer_kind: attempt.answerKind,
    answer_mode: attempt.answerMode,
    answer_mode_source: attempt.answerModeSource,
    prompt: attempt.prompt,
    instruction: attempt.instruction,
    content: attempt.content,
    prompt_layout: toPublicValue(attempt.promptLayout),
    choices: toPublicValue(attempt.choices),
    submitted_answer: toPublicValue(attempt.submittedAnswer),
    submitted_answer_storage: toPublicValue(attempt.submittedAnswerStorage),
    submitted_answer_display: attempt.submittedAnswerDisplay,
    normalized_answer: attempt.normalizedAnswer,
    result: attempt.result,
    is_correct: attempt.isCorrect,
    response_ms: attempt.responseMs,
    completed_at: attempt.completedAt.toISOString(),
    created_at: attempt.createdAt.toISOString(),
    feedback_shown_at: attempt.feedbackShownAt?.toISOString() ?? null,
    reviewed_at: attempt.reviewedAt?.toISOString() ?? null,
    final_rating: attempt.finalRating,
    proposed_rating: attempt.proposedRating,
    rating_policy_version: attempt.ratingPolicyVersion,
    correct_answer_display: attempt.correctAnswerDisplay,
    explanation: attempt.explanation,
    answer_contract: toPublicValue(attempt.answerContract),
    answer_contract_source: attempt.answerContractSource,
    answer_contract_source_label: attempt.answerContractSourceLabel,
    answer_contract_fallback: attempt.answerContractFallback,
    answer_contract_fallback_reason: attempt.answerContractFallbackReason,
    comparison_policy: toPublicValue(attempt.comparisonPolicy),
    accepted_variants: toPublicValue(attempt.acceptedVariants),
    mode: attempt.mode,
    submission_type: attempt.submissionType,
    scheduled: attempt.scheduled,
    practice_only: attempt.practiceOnly,
    practice_context: toPublicValue(attempt.practiceContext),
    mixed_review: attempt.mixedReview,
    reduced_rule_cues: attempt.reducedRuleCues,
    schedule: {
      previous_due_at: attempt.previousDueAt?.toISOString() ?? null,
      next_due_at: attempt.nextDueAt?.toISOString() ?? null,
      previous_state: attempt.previousState,
      next_state: attempt.nextState,
    },
    correction: toPublicValue(attempt.correction),
    quality_correction: toPublicValue(attempt.qualityCorrection),
    correction_status: attempt.correctionStatus,
    evidence_excluded: attempt.evidenceExcluded,
    original: toPublicValue(attempt.original),
  };
}

function mapReadModelError(error: unknown, message: string): Error {
  if (error instanceof ExerciseAuditCursorError || error instanceof PracticeHistoryCursorError) {
    return new AgentOperationError("invalid_input", error.message);
  }
  return error instanceof Error ? error : new Error(message);
}

function toPublicValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toPublicValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toPublicValue(child)]),
    );
  }
  return value;
}
