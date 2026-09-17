import "server-only";

import { withAgentMutation, authorizeAgentRead } from "@/lib/agent-access/access";
import type { AgentAuthContext } from "@/lib/agent-access/auth";
import {
  agentExerciseIssueListSchema,
  agentExerciseIssueResolveSchema,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  ExerciseQualityIncidentError,
  adjudicateExerciseQualityIncident,
} from "@/lib/practice/quality-incidents";
import {
  queueExerciseReplacement,
  type ExerciseReplacementResult,
} from "@/lib/practice/quality-replacements";
import {
  ExerciseQualityIssueCursorError,
  listExerciseQualityIssues,
} from "@/lib/practice/quality-issues";

export async function listAgentExerciseIssues(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentExerciseIssueListSchema.parse(rawInput);
  await authorizeAgentRead(auth, "exercises:audit");

  try {
    const page = await listExerciseQualityIssues({
      userId: auth.userId,
      limit: input.limit,
      cursor: input.cursor,
      includeResolved: input.include_resolved,
    });

    return {
      snapshot_cutoff: page.snapshotCutoff.toISOString(),
      issues: page.issues.map(toPublicIssue),
      next_cursor: page.nextCursor,
    };
  } catch (error) {
    if (error instanceof ExerciseQualityIssueCursorError) {
      throw new AgentOperationError("invalid_input", error.message);
    }
    throw error;
  }
}

export async function resolveAgentExerciseIssue(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentExerciseIssueResolveSchema.parse(rawInput);

  try {
    const now = new Date();
    const result = await withAgentMutation(
      auth,
      "exercises:resolve",
      (transaction) => adjudicateExerciseQualityIncident({
        userId: auth.userId,
        exerciseId: input.exercise_id,
        adjudication: input.resolution,
        adjudicationCode: input.reason,
        expectedUpdatedAt: input.expected_updated_at,
        idempotencyKey: input.idempotency_key,
        now,
        transaction,
      }),
    );

    if (result.status === "not-found") {
      throw new AgentOperationError("exercise_not_found", "The exercise issue was not found.");
    }

    const replacement = result.adjudication === "confirmed"
      ? await queueExerciseReplacement({
          userId: auth.userId,
          exerciseId: input.exercise_id,
          now,
        })
      : null;

    return {
      exercise_id: input.exercise_id,
      resolution: result.adjudication,
      idempotent: result.idempotent,
      incident_key: result.incidentKey,
      affected_attempt_count: result.affectedAttemptCount,
      affected_review_count: result.affectedReviewCount,
      practice_only_attempt_count: result.practiceOnlyAttemptCount,
      replayed_review_count: result.replayedReviewCount,
      quarantined_exercise_count: result.quarantinedExerciseCount,
      correction: {
        status: result.adjudication === "confirmed" ? "complete" : "not_required",
        retained_history: true,
        schedule_replayed: result.replayedReviewCount > 0,
      },
      replacement: toPublicReplacement(replacement),
      schedule: {
        affected_reviews: result.affectedReviewCount,
        replayed_reviews: result.replayedReviewCount,
        excluded_from_schedule: result.adjudication === "confirmed",
      },
    };
  } catch (error) {
    if (error instanceof ExerciseQualityIncidentError) {
      if (error.code === "stale") {
        throw new AgentOperationError("stale_state", error.message);
      }
      throw new AgentOperationError("invalid_input", error.message);
    }
    throw error;
  }
}

function toPublicReplacement(replacement: ExerciseReplacementResult | null) {
  if (!replacement) return null;

  return {
    status: replacement.status,
    generation_job_id: "generationJobId" in replacement ? replacement.generationJobId : undefined,
    requested_count: "requestedCount" in replacement ? replacement.requestedCount : undefined,
    ready_exercise_count: "readyExerciseCount" in replacement ? replacement.readyExerciseCount : undefined,
    target_ready_count: "targetReadyCount" in replacement ? replacement.targetReadyCount : undefined,
    retry_at: "retryAt" in replacement ? replacement.retryAt : undefined,
    reason: "reason" in replacement ? replacement.reason : undefined,
    message: replacement.message,
  };
}

function toPublicIssue(issue: Awaited<ReturnType<typeof listExerciseQualityIssues>>["issues"][number]) {
  return {
    exercise_id: issue.exerciseId,
    skill_id: issue.skillId,
    skill_title: issue.skillTitle,
    collection_name: issue.collectionName,
    prompt: issue.prompt,
    correct_answer_display: issue.correctAnswerDisplay,
    answer_kind: issue.answerKind,
    lifecycle: issue.retiredAt ? "retired" : "active",
    retired_at: issue.retiredAt?.toISOString() ?? null,
    retirement_reason: issue.retirementReason ?? null,
    issue_version: issue.issueVersion.toISOString(),
    flags: issue.flags.map((flag) => ({
      flag_id: flag.id,
      reason: flag.reason,
      note: flag.note,
      status: flag.status,
      adjudication_status: flag.adjudicationStatus,
      adjudicated_at: flag.adjudicatedAt?.toISOString() ?? null,
      adjudication_code: flag.adjudicationCode ?? null,
      resolution_note: flag.resolutionNote ?? null,
      resolved_at: flag.resolvedAt?.toISOString() ?? null,
      evidence_correction_action: flag.evidenceCorrectionAction ?? "NONE",
      evidence_correction_status: flag.evidenceCorrectionStatus,
      practice_evidence_needs_correction: flag.practiceEvidenceNeedsCorrection ?? false,
      affected_review_count: flag.affectedReviewCount ?? 0,
      correction_started_at: flag.correctionStartedAt?.toISOString() ?? null,
      correction_completed_at: flag.correctionCompletedAt?.toISOString() ?? null,
      incident_key: flag.incidentKey ?? null,
      replayed_review_count: flag.replayedReviewCount ?? 0,
      quarantined_exercise_count: flag.quarantinedExerciseCount ?? 0,
      created_at: flag.createdAt.toISOString(),
      updated_at: flag.updatedAt.toISOString(),
    })),
    recent_attempts: issue.attempts.map((attempt) => ({
      attempt_id: attempt.id,
      result: attempt.result,
      submitted_answer: attempt.submittedAnswerDisplay,
      response_ms: attempt.responseMs,
      completed_at: attempt.completedAt.toISOString(),
      practice_only: attempt.practiceOnly,
    })),
  };
}
