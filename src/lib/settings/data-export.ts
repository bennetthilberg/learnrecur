import "server-only";

import type {
  AnswerKind,
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseFlagStatus,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  FsrsRating,
  GenerationJobKind,
  GenerationJobStatus,
  MaterialCleanupStatus,
  MaterialPageTextStatus,
  MaterialRevisionStatus,
  Prisma,
  ReminderSendStatus,
  SkillDraftBatchItemStatus,
  SkillDraftBatchStatus,
  SkillFsrsState,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export const STUDY_DATA_EXPORT_VERSION = 2;
const PRIVATE_SOURCE_METADATA_KEYS = new Set([
  "bucketName",
  "objectKey",
  "publicUrl",
  "storageBucket",
  "storageKey",
]);

export type StudyDataExportResult =
  | {
      status: "ready";
      export: StudyDataExportV2;
      filename: string;
    }
  | {
      status: "not-found";
      message: string;
    };

export type StudyDataExportV2 = {
  exportVersion: typeof STUDY_DATA_EXPORT_VERSION;
  generatedAt: string;
  user: ExportUser;
  collections: ExportCollection[];
  studyMaterials: ExportStudyMaterial[];
  materialRevisions: ExportMaterialRevision[];
  materialSections: ExportMaterialSection[];
  materialChunks: ExportMaterialChunk[];
  materialPages: ExportMaterialPage[];
  materialCleanupJobs: ExportMaterialCleanupJob[];
  sourceFiles: ExportSourceFile[];
  skills: ExportSkill[];
  skillSourceRefs: ExportSkillSourceRef[];
  exercises: ExportExercise[];
  exerciseAttempts: ExportExerciseAttempt[];
  reviewLogs: ExportReviewLog[];
  exerciseFlags: ExportExerciseFlag[];
  generationJobs: ExportGenerationJob[];
  skillDraftBatches: ExportSkillDraftBatch[];
  skillDraftBatchItems: ExportSkillDraftBatchItem[];
  reminderPreference: ExportReminderPreference | null;
  reminderSendLogs: ExportReminderSendLog[];
};

export type ExportUser = {
  id: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportCollection = {
  id: string;
  name: string;
  description: string | null;
  status: CollectionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ExportSourceFile = {
  id: string;
  collectionId: string | null;
  materialRevisionId: string | null;
  kind: SourceFileKind | string;
  status: SourceFileStatus | string;
  originalName: string;
  mimeType: string | null;
  byteSize: number | null;
  extractedText: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportStudyMaterial = {
  id: string;
  collectionId: string | null;
  title: string;
  kind: StudyMaterialKind;
  status: StudyMaterialStatus;
  activeRevisionId: string | null;
  deletionRequestedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportMaterialRevision = {
  id: string;
  materialId: string;
  revisionNumber: number;
  status: MaterialRevisionStatus;
  sourceUrl: string | null;
  contentHash: string | null;
  byteSize: number | null;
  pageCount: number | null;
  fetchedPageCount: number | null;
  summary: string | null;
  processingMetadata: Prisma.JsonValue | null;
  errorCode: string | null;
  errorMessage: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportMaterialSection = {
  id: string;
  materialRevisionId: string;
  parentId: string | null;
  ordinal: number;
  level: number;
  title: string;
  normalizedTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  url: string | null;
  anchor: string | null;
  headingPath: string[];
  metadata: Prisma.JsonValue | null;
  createdAt: string;
};

export type ExportMaterialChunk = {
  id: string;
  materialRevisionId: string;
  materialSectionId: string | null;
  sourceFileId: string | null;
  ordinal: number;
  text: string;
  tokenEstimate: number;
  contentHash: string;
  locator: Prisma.JsonValue;
  headingText: string | null;
  createdAt: string;
};

export type ExportMaterialPage = {
  id: string;
  materialRevisionId: string;
  pageNumber: number;
  embeddedText: string | null;
  ocrText: string | null;
  textStatus: MaterialPageTextStatus;
  contentHash: string;
  tokenEstimate: number;
  metadata: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportMaterialCleanupJob = {
  id: string;
  materialId: string;
  status: MaterialCleanupStatus;
  attemptCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportSkillDraftBatch = {
  id: string;
  materialRevisionId: string;
  instruction: string;
  proposedPlan: Prisma.JsonValue | null;
  confirmedPlan: Prisma.JsonValue | null;
  planningMetadata: Prisma.JsonValue | null;
  status: SkillDraftBatchStatus;
  idempotencyKey: string;
  requestedCount: number;
  readyCount: number;
  failedCount: number;
  excludedCount: number;
  activatedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
};

export type ExportSkillDraftBatchItem = {
  id: string;
  batchId: string;
  skillId: string | null;
  ordinal: number;
  targetKey: string;
  proposedTitle: string;
  proposedObjective: string;
  locator: Prisma.JsonValue;
  status: SkillDraftBatchItemStatus;
  overlapSkillId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  generationAttempts: number;
  generationMetadata: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportSkill = {
  id: string;
  collectionId: string | null;
  title: string;
  objective: string | null;
  rules: Prisma.JsonValue | null;
  examples: Prisma.JsonValue | null;
  exerciseConstraints: Prisma.JsonValue | null;
  tags: string[];
  status: SkillStatus;
  dueAt: string | null;
  stability: number | null;
  difficulty: number | null;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  repetitions: number;
  lapses: number;
  fsrsState: SkillFsrsState;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportSkillSourceRef = {
  id: string;
  skillId: string;
  sourceFileId: string;
  locator: Prisma.JsonValue | null;
  note: string | null;
  createdAt: string;
};

export type ExportExercise = {
  id: string;
  skillId: string;
  type: ExerciseType;
  answerKind: AnswerKind;
  prompt: string;
  choices: Prisma.JsonValue | null;
  answerSpec: Prisma.JsonValue;
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
  verificationStatus: ExerciseVerificationStatus;
  retiredAt: string | null;
  retirementReason: ExerciseRetirementReason | null;
  freshnessKey: string | null;
  sourceRefs: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportExerciseAttempt = {
  id: string;
  skillId: string;
  exerciseId: string;
  answer: Prisma.JsonValue;
  normalizedAnswer: string | null;
  isCorrect: boolean;
  result: ExerciseAttemptResult;
  responseMs: number | null;
  proposedRating: FsrsRating | null;
  finalRating: FsrsRating | null;
  feedbackShownAt: string | null;
  createdAt: string;
};

export type ExportReviewLog = {
  id: string;
  skillId: string;
  exerciseAttemptId: string;
  finalRating: FsrsRating;
  reviewedAt: string;
  previousDueAt: string | null;
  nextDueAt: string | null;
  previousStability: number | null;
  nextStability: number | null;
  previousDifficulty: number | null;
  nextDifficulty: number | null;
  previousElapsedDays: number | null;
  nextElapsedDays: number | null;
  previousScheduledDays: number | null;
  nextScheduledDays: number | null;
  previousLearningSteps: number | null;
  nextLearningSteps: number | null;
  previousRepetitions: number | null;
  nextRepetitions: number | null;
  previousLapses: number | null;
  nextLapses: number | null;
  previousState: SkillFsrsState | null;
  nextState: SkillFsrsState | null;
  schedulerName: string;
  schedulerVersion: string;
  desiredRetention: number;
  schedulerParameters: Prisma.JsonValue;
  createdAt: string;
};

export type ExportExerciseFlag = {
  id: string;
  exerciseId: string;
  reason: ExerciseFlagReason;
  note: string | null;
  status: ExerciseFlagStatus;
  resolvedAt: string | null;
  resolutionNote: string | null;
  retiredExerciseAt: string | null;
  retirementReason: ExerciseRetirementReason | null;
  createdAt: string;
};

export type ExportGenerationJob = {
  id: string;
  skillId: string;
  kind: GenerationJobKind;
  status: GenerationJobStatus;
  provider: string;
  model: string;
  promptVersion: string;
  requestedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExportReminderPreference = {
  id: string;
  enabled: boolean;
  email: string;
  localHour: number;
  timezone: string;
  minimumDueCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportReminderSendLog = {
  id: string;
  localDate: string;
  status: ReminderSendStatus;
  dueCount: number;
  email: string | null;
  provider: string | null;
  providerMessageId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type SourceFileForExport = {
  id: string;
  collectionId: string | null;
  materialRevisionId: string | null;
  kind: SourceFileKind | string;
  status: SourceFileStatus | string;
  originalName: string;
  mimeType: string | null;
  byteSize: number | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  publicUrl?: string | null;
  extractedText: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getUserDataExport(input: {
  userId: string;
  generatedAt: Date;
}): Promise<StudyDataExportResult> {
  assertValidExportDate(input.generatedAt);

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      email: true,
      name: true,
      imageUrl: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
      collections: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      studyMaterials: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          collectionId: true,
          title: true,
          kind: true,
          status: true,
          activeRevisionId: true,
          deletionRequestedAt: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      materialRevisions: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialId: true,
          revisionNumber: true,
          status: true,
          sourceUrl: true,
          contentHash: true,
          byteSize: true,
          pageCount: true,
          fetchedPageCount: true,
          summary: true,
          processingMetadata: true,
          errorCode: true,
          errorMessage: true,
          finalizedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      materialSections: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialRevisionId: true,
          parentId: true,
          ordinal: true,
          level: true,
          title: true,
          normalizedTitle: true,
          pageStart: true,
          pageEnd: true,
          url: true,
          anchor: true,
          headingPath: true,
          metadata: true,
          createdAt: true,
        },
      },
      materialChunks: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialRevisionId: true,
          materialSectionId: true,
          sourceFileId: true,
          ordinal: true,
          text: true,
          tokenEstimate: true,
          contentHash: true,
          locator: true,
          headingText: true,
          createdAt: true,
        },
      },
      materialPages: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialRevisionId: true,
          pageNumber: true,
          embeddedText: true,
          ocrText: true,
          textStatus: true,
          contentHash: true,
          tokenEstimate: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      materialCleanupJobs: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialId: true,
          status: true,
          attemptCount: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      sourceFiles: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          collectionId: true,
          materialRevisionId: true,
          kind: true,
          status: true,
          originalName: true,
          mimeType: true,
          byteSize: true,
          extractedText: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      skills: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          collectionId: true,
          title: true,
          objective: true,
          rules: true,
          examples: true,
          exerciseConstraints: true,
          tags: true,
          status: true,
          dueAt: true,
          stability: true,
          difficulty: true,
          elapsedDays: true,
          scheduledDays: true,
          learningSteps: true,
          repetitions: true,
          lapses: true,
          fsrsState: true,
          lastReviewedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      skillSourceRefs: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          skillId: true,
          sourceFileId: true,
          locator: true,
          note: true,
          createdAt: true,
        },
      },
      exercises: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          skillId: true,
          type: true,
          answerKind: true,
          prompt: true,
          choices: true,
          answerSpec: true,
          correctAnswerDisplay: true,
          explanation: true,
          difficulty: true,
          expectedSeconds: true,
          verificationStatus: true,
          retiredAt: true,
          retirementReason: true,
          freshnessKey: true,
          sourceRefs: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      exerciseAttempts: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          skillId: true,
          exerciseId: true,
          answer: true,
          normalizedAnswer: true,
          isCorrect: true,
          result: true,
          responseMs: true,
          proposedRating: true,
          finalRating: true,
          feedbackShownAt: true,
          createdAt: true,
        },
      },
      reviewLogs: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          skillId: true,
          exerciseAttemptId: true,
          finalRating: true,
          reviewedAt: true,
          previousDueAt: true,
          nextDueAt: true,
          previousStability: true,
          nextStability: true,
          previousDifficulty: true,
          nextDifficulty: true,
          previousElapsedDays: true,
          nextElapsedDays: true,
          previousScheduledDays: true,
          nextScheduledDays: true,
          previousLearningSteps: true,
          nextLearningSteps: true,
          previousRepetitions: true,
          nextRepetitions: true,
          previousLapses: true,
          nextLapses: true,
          previousState: true,
          nextState: true,
          schedulerName: true,
          schedulerVersion: true,
          desiredRetention: true,
          schedulerParameters: true,
          createdAt: true,
        },
      },
      exerciseFlags: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          exerciseId: true,
          reason: true,
          note: true,
          status: true,
          resolvedAt: true,
          resolutionNote: true,
          retiredExerciseAt: true,
          retirementReason: true,
          createdAt: true,
        },
      },
      generationJobs: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          skillId: true,
          kind: true,
          status: true,
          provider: true,
          model: true,
          promptVersion: true,
          requestedCount: true,
          acceptedCount: true,
          rejectedCount: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      skillDraftBatches: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          materialRevisionId: true,
          instruction: true,
          proposedPlan: true,
          confirmedPlan: true,
          planningMetadata: true,
          status: true,
          idempotencyKey: true,
          requestedCount: true,
          readyCount: true,
          failedCount: true,
          excludedCount: true,
          activatedCount: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
          confirmedAt: true,
          completedAt: true,
        },
      },
      skillDraftBatchItems: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          batchId: true,
          skillId: true,
          ordinal: true,
          targetKey: true,
          proposedTitle: true,
          proposedObjective: true,
          locator: true,
          status: true,
          overlapSkillId: true,
          errorCode: true,
          errorMessage: true,
          generationAttempts: true,
          generationMetadata: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      reminderPreference: {
        select: {
          id: true,
          enabled: true,
          email: true,
          localHour: true,
          timezone: true,
          minimumDueCount: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      reminderSendLogs: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          localDate: true,
          status: true,
          dueCount: true,
          email: true,
          provider: true,
          providerMessageId: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!user) {
    return {
      status: "not-found",
      message: "Sign in again before exporting data.",
    };
  }

  const exportData: StudyDataExportV2 = {
    exportVersion: STUDY_DATA_EXPORT_VERSION,
    generatedAt: serializeExportDate(input.generatedAt),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      imageUrl: user.imageUrl,
      lastSeenAt: serializeExportDate(user.lastSeenAt),
      createdAt: serializeExportDate(user.createdAt),
      updatedAt: serializeExportDate(user.updatedAt),
    },
    collections: user.collections.map((collection) => ({
      ...collection,
      createdAt: serializeExportDate(collection.createdAt),
      updatedAt: serializeExportDate(collection.updatedAt),
    })),
    studyMaterials: user.studyMaterials.map((material) => ({
      ...material,
      deletionRequestedAt: serializeExportDate(material.deletionRequestedAt),
      lastUsedAt: serializeExportDate(material.lastUsedAt),
      createdAt: serializeExportDate(material.createdAt),
      updatedAt: serializeExportDate(material.updatedAt),
    })),
    materialRevisions: user.materialRevisions.map((revision) => ({
      ...revision,
      processingMetadata: sanitizeSourceFileMetadata(revision.processingMetadata),
      finalizedAt: serializeExportDate(revision.finalizedAt),
      createdAt: serializeExportDate(revision.createdAt),
      updatedAt: serializeExportDate(revision.updatedAt),
    })),
    materialSections: user.materialSections.map((section) => ({
      ...section,
      metadata: sanitizeSourceFileMetadata(section.metadata),
      createdAt: serializeExportDate(section.createdAt),
    })),
    materialChunks: user.materialChunks.map((chunk) => ({
      ...chunk,
      locator: sanitizeSourceFileMetadata(chunk.locator),
      createdAt: serializeExportDate(chunk.createdAt),
    })),
    materialPages: user.materialPages.map((page) => ({
      ...page,
      metadata: sanitizeSourceFileMetadata(page.metadata),
      createdAt: serializeExportDate(page.createdAt),
      updatedAt: serializeExportDate(page.updatedAt),
    })),
    materialCleanupJobs: user.materialCleanupJobs.map((job) => ({
      ...job,
      startedAt: serializeExportDate(job.startedAt),
      completedAt: serializeExportDate(job.completedAt),
      createdAt: serializeExportDate(job.createdAt),
      updatedAt: serializeExportDate(job.updatedAt),
    })),
    sourceFiles: user.sourceFiles.map(toExportSourceFile),
    skills: user.skills.map((skill) => ({
      ...skill,
      dueAt: serializeExportDate(skill.dueAt),
      lastReviewedAt: serializeExportDate(skill.lastReviewedAt),
      createdAt: serializeExportDate(skill.createdAt),
      updatedAt: serializeExportDate(skill.updatedAt),
    })),
    skillSourceRefs: user.skillSourceRefs.map((ref) => ({
      ...ref,
      createdAt: serializeExportDate(ref.createdAt),
    })),
    exercises: user.exercises.map((exercise) => ({
      ...exercise,
      retiredAt: serializeExportDate(exercise.retiredAt),
      createdAt: serializeExportDate(exercise.createdAt),
      updatedAt: serializeExportDate(exercise.updatedAt),
    })),
    exerciseAttempts: user.exerciseAttempts.map((attempt) => ({
      ...attempt,
      feedbackShownAt: serializeExportDate(attempt.feedbackShownAt),
      createdAt: serializeExportDate(attempt.createdAt),
    })),
    reviewLogs: user.reviewLogs.map((reviewLog) => ({
      ...reviewLog,
      reviewedAt: serializeExportDate(reviewLog.reviewedAt),
      previousDueAt: serializeExportDate(reviewLog.previousDueAt),
      nextDueAt: serializeExportDate(reviewLog.nextDueAt),
      createdAt: serializeExportDate(reviewLog.createdAt),
    })),
    exerciseFlags: user.exerciseFlags.map((flag) => ({
      ...flag,
      resolvedAt: serializeExportDate(flag.resolvedAt),
      retiredExerciseAt: serializeExportDate(flag.retiredExerciseAt),
      createdAt: serializeExportDate(flag.createdAt),
    })),
    generationJobs: user.generationJobs.map((job) => ({
      ...job,
      startedAt: serializeExportDate(job.startedAt),
      completedAt: serializeExportDate(job.completedAt),
      createdAt: serializeExportDate(job.createdAt),
      updatedAt: serializeExportDate(job.updatedAt),
    })),
    skillDraftBatches: user.skillDraftBatches.map((batch) => ({
      ...batch,
      confirmedPlan: sanitizeSourceFileMetadata(batch.confirmedPlan),
      confirmedAt: serializeExportDate(batch.confirmedAt),
      completedAt: serializeExportDate(batch.completedAt),
      createdAt: serializeExportDate(batch.createdAt),
      updatedAt: serializeExportDate(batch.updatedAt),
    })),
    skillDraftBatchItems: user.skillDraftBatchItems.map((item) => ({
      ...item,
      locator: sanitizeSourceFileMetadata(item.locator),
      createdAt: serializeExportDate(item.createdAt),
      updatedAt: serializeExportDate(item.updatedAt),
    })),
    reminderPreference: user.reminderPreference
      ? {
          ...user.reminderPreference,
          createdAt: serializeExportDate(user.reminderPreference.createdAt),
          updatedAt: serializeExportDate(user.reminderPreference.updatedAt),
        }
      : null,
    reminderSendLogs: user.reminderSendLogs.map((log) => ({
      ...log,
      createdAt: serializeExportDate(log.createdAt),
      updatedAt: serializeExportDate(log.updatedAt),
    })),
  };

  return {
    status: "ready",
    export: exportData,
    filename: buildUserDataExportFilename(input.generatedAt),
  };
}

export function buildUserDataExportFilename(generatedAt: Date): string {
  return `learnrecur-export-${serializeExportDate(generatedAt).slice(0, 10)}.json`;
}

export function serializeExportDate(value: Date): string;
export function serializeExportDate(value: Date | null): string | null;
export function serializeExportDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }

  return value.toISOString();
}

export function toExportSourceFile(sourceFile: SourceFileForExport): ExportSourceFile {
  return {
    id: sourceFile.id,
    collectionId: sourceFile.collectionId,
    materialRevisionId: sourceFile.materialRevisionId,
    kind: sourceFile.kind,
    status: sourceFile.status,
    originalName: sourceFile.originalName,
    mimeType: sourceFile.mimeType,
    byteSize: sourceFile.byteSize,
    extractedText: sourceFile.extractedText,
    metadata: sanitizeSourceFileMetadata(sourceFile.metadata),
    createdAt: serializeExportDate(sourceFile.createdAt),
    updatedAt: serializeExportDate(sourceFile.updatedAt),
  };
}

function sanitizeSourceFileMetadata(metadata: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (metadata === null) {
    return null;
  }

  if (Array.isArray(metadata)) {
    return metadata.map((item) => sanitizeSourceFileMetadata(item));
  }

  if (typeof metadata === "object") {
    const sanitized: Record<string, Prisma.JsonValue> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (PRIVATE_SOURCE_METADATA_KEYS.has(key)) {
        continue;
      }

      if (value === undefined) {
        continue;
      }

      sanitized[key] = sanitizeSourceFileMetadata(value);
    }

    return sanitized;
  }

  return metadata;
}

function assertValidExportDate(generatedAt: Date) {
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new Error("getUserDataExport requires a valid generatedAt Date.");
  }
}
