import "server-only";

import {
  AnswerKind,
  type ExerciseRetirementReason,
  type ExerciseType,
  type ExerciseVerificationStatus,
  type GenerationAuditDecision,
  type Prisma,
  type SkillStatus,
  type SourceFileKind,
  type SourceFileStatus,
} from "@/generated/prisma/client";
import {
  choicesSchema,
  type AnswerSpec,
  type Choice,
} from "@/lib/answer-checking";
import { getPrisma } from "@/lib/prisma";
import { readStoredPromptLayout, type StructuredPrompt } from "./structured-prompt";
import {
  buildAnswerContract,
  type AcceptedAnswerVariant,
  type AnswerComparisonPolicy,
  type AnswerContract,
} from "./answer-contract";

const DEFAULT_EXERCISE_AUDIT_LIMIT = 10;
const MAX_EXERCISE_AUDIT_LIMIT = 25;
const CURSOR_VERSION = 1 as const;
const MAX_CURSOR_LENGTH = 8_000;
const IDENTIFIER_MAX_LENGTH = 200;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const exerciseAuditSelect = {
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
  skillSpecVersion: true,
  skillSpecFingerprint: true,
  exerciseSpecVersion: true,
  blueprintVersion: true,
  blueprintSlot: true,
  exerciseFamily: true,
  qualityVersion: true,
  provenance: true,
  sourceRefs: true,
  acceptanceDecision: true,
  generationMetadata: true,
  createdAt: true,
  updatedAt: true,
  skill: {
    select: {
      id: true,
      title: true,
      status: true,
      sourceRefs: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sourceFileId: true,
          locator: true,
          note: true,
          createdAt: true,
          sourceFile: {
            select: {
              id: true,
              originalName: true,
              kind: true,
              status: true,
              materialRevisionId: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ExerciseSelect;

type ExerciseAuditRow = Prisma.ExerciseGetPayload<{
  select: typeof exerciseAuditSelect;
}>;

export type ExerciseAuditLifecycle = "all" | "active" | "retired";

export type SanitizedExerciseSourceRef = {
  id: string;
  sourceFileId: string;
  label: string;
  kind: SourceFileKind;
  status: SourceFileStatus;
  materialRevisionId: string | null;
  locator: Record<string, string | number> | null;
  note: string | null;
  createdAt: Date;
};

export type SanitizedExerciseSourceIdentity = {
  sourceFileId: string | null;
  sourceRevisionId: string | null;
  materialRevisionId: string | null;
  sectionId: string | null;
  evidenceChunkId: string | null;
  locator: Record<string, string | number> | null;
};

export type ExerciseProvenanceSummary = {
  sourceBacked: boolean;
  kind: string | null;
  sourceRevisionIds: string[];
  sourceFileIds: string[];
  evidenceAnchorIds: string[];
  contentHashes: string[];
  summary: string;
};

export type ExerciseVerificationSummary = {
  status: ExerciseVerificationStatus;
  acceptanceDecision: GenerationAuditDecision | null;
  note: "Pipeline status only; it does not guarantee linguistic correctness.";
};

export type ExerciseAuditRecord = {
  id: string;
  exerciseId: string;
  skillId: string;
  skillTitle: string;
  skillStatus: SkillStatus;
  type: ExerciseType;
  answerKind: AnswerKind;
  prompt: string;
  instruction: string | null;
  content: string;
  promptLayout: StructuredPrompt | null;
  choices: Choice[] | null;
  answerSpec: AnswerSpec | null;
  answerContract: AnswerContract | null;
  comparisonPolicy: AnswerComparisonPolicy | null;
  acceptedVariants: AcceptedAnswerVariant[];
  acceptedValues: unknown[];
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
  verificationStatus: ExerciseVerificationStatus;
  verificationSummary: ExerciseVerificationSummary;
  acceptanceDecision: GenerationAuditDecision | null;
  lifecycle: Exclude<ExerciseAuditLifecycle, "all">;
  retiredAt: Date | null;
  retirementReason: ExerciseRetirementReason | null;
  retirement: {
    isRetired: boolean;
    retiredAt: Date | null;
    reason: ExerciseRetirementReason | null;
  };
  createdAt: Date;
  updatedAt: Date;
  revision: string;
  recordRevision: string;
  skillSpecVersion: string | null;
  skillSpecFingerprint: string | null;
  exerciseSpecVersion: string | null;
  blueprintVersion: string | null;
  blueprintSlot: string | null;
  exerciseFamily: string | null;
  qualityVersion: string | null;
  sourceRefs: SanitizedExerciseSourceRef[];
  exerciseSourceRefs: SanitizedExerciseSourceIdentity[];
  provenance: ExerciseProvenanceSummary;
};

export type ExerciseAuditCursor = {
  version: typeof CURSOR_VERSION;
  userId: string;
  skillId: string;
  answerKind: AnswerKind | null;
  lifecycle: ExerciseAuditLifecycle;
  snapshotCutoff: string;
  createdAt: string;
  id: string;
};

export type ListExercisesForAuditInput = {
  userId: string;
  skillId: string;
  answerKind?: AnswerKind;
  lifecycle?: ExerciseAuditLifecycle;
  limit?: number;
  cursor?: string;
  now?: Date;
};

export type ExerciseAuditPage = {
  status: "ready";
  exercises: ExerciseAuditRecord[];
  nextCursor: string | null;
  snapshotCutoff: Date;
};

export type GetExerciseForAuditInput = {
  userId: string;
  exerciseId: string;
};

export type ExerciseAuditLookupResult =
  | {
      status: "ready";
      exercise: ExerciseAuditRecord;
    }
  | {
      status: "not-found";
      message: "Exercise not found.";
    };

export class ExerciseAuditCursorError extends Error {
  constructor(message = "The exercise audit pagination cursor is invalid.") {
    super(message);
    this.name = "ExerciseAuditCursorError";
  }
}

export function encodeExerciseAuditCursor(cursor: ExerciseAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeExerciseAuditCursor(value: string): ExerciseAuditCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) {
    throw new ExerciseAuditCursorError();
  }

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);

    if (!isExerciseAuditCursor(parsed)) {
      throw new ExerciseAuditCursorError();
    }

    return parsed;
  } catch (error) {
    if (error instanceof ExerciseAuditCursorError) {
      throw error;
    }

    throw new ExerciseAuditCursorError();
  }
}

export async function listExercisesForAudit(
  input: ListExercisesForAuditInput,
): Promise<ExerciseAuditPage> {
  const skillId = requireIdentifier(input.skillId, "skillId");
  const lifecycle = normalizeLifecycle(input.lifecycle);
  const limit = normalizeExerciseAuditLimit(input.limit);
  const now = input.now ?? new Date();
  assertValidDate(now, "listExercisesForAudit");

  const cursor = input.cursor ? decodeExerciseAuditCursor(input.cursor) : null;
  if (cursor) {
    assertMatchingCursor(cursor, {
      userId: input.userId,
      skillId,
      answerKind: input.answerKind ?? null,
      lifecycle,
    });
  }

  const snapshotCutoff = cursor ? new Date(cursor.snapshotCutoff) : now;
  const prisma = getPrisma();
  const rows = await prisma.exercise.findMany({
    where: {
      AND: [
        {
          userId: input.userId,
          skillId,
          skill: {
            userId: input.userId,
          },
          answerKind: input.answerKind,
          ...(lifecycle === "active"
            ? { OR: [{ retiredAt: null }, { retiredAt: { gt: snapshotCutoff } }] }
            : {}),
          ...(lifecycle === "retired" ? { retiredAt: { not: null, lte: snapshotCutoff } } : {}),
          createdAt: { lte: snapshotCutoff },
        },
        ...(cursor
          ? [
              {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: exerciseAuditSelect,
  });

  const exercises = rows.slice(0, limit).map(mapExerciseAuditRecord);
  const last = exercises.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeExerciseAuditCursor({
        version: CURSOR_VERSION,
        userId: input.userId,
        skillId,
        answerKind: input.answerKind ?? null,
        lifecycle,
        snapshotCutoff: snapshotCutoff.toISOString(),
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      })
    : null;

  return {
    status: "ready",
    exercises,
    nextCursor,
    snapshotCutoff,
  };
}

export const getExerciseAuditPage = listExercisesForAudit;

export async function getExerciseForAudit(
  input: GetExerciseForAuditInput,
): Promise<ExerciseAuditLookupResult> {
  const prisma = getPrisma();
  const row = await prisma.exercise.findFirst({
    where: {
      id: input.exerciseId,
      userId: input.userId,
      skill: {
        userId: input.userId,
      },
    },
    select: exerciseAuditSelect,
  });

  if (!row) {
    return {
      status: "not-found",
      message: "Exercise not found.",
    };
  }

  return {
    status: "ready",
    exercise: mapExerciseAuditRecord(row),
  };
}

export const getExerciseAudit = getExerciseForAudit;

export async function findExerciseAudit(
  input: GetExerciseForAuditInput,
): Promise<ExerciseAuditRecord | null> {
  const result = await getExerciseForAudit(input);
  return result.status === "ready" ? result.exercise : null;
}

export function mapExerciseAuditRecord(row: ExerciseAuditRow): ExerciseAuditRecord {
  const choicesResult = choicesSchema.safeParse(row.choices);
  const choices = choicesResult.success ? choicesResult.data : null;
  const answerContract = buildAnswerContract(row.answerSpec, choices);
  const promptLayout = readStoredPromptLayout(row.prompt, row.generationMetadata);
  const isRetired = row.retiredAt !== null;
  const sourceRefs = row.skill.sourceRefs.map(mapSourceRef);
  const exerciseSourceRefs = sanitizeExerciseSourceIdentities(row.sourceRefs);

  return {
    id: row.id,
    exerciseId: row.id,
    skillId: row.skillId,
    skillTitle: row.skill.title,
    skillStatus: row.skill.status,
    type: row.type,
    answerKind: row.answerKind,
    prompt: row.prompt,
    instruction: promptLayout?.instruction ?? null,
    content: promptLayout?.content ?? row.prompt,
    promptLayout,
    choices,
    answerSpec: answerContract?.answerSpec ?? null,
    answerContract,
    comparisonPolicy: answerContract?.comparisonPolicy ?? null,
    acceptedVariants: answerContract?.acceptedVariants ?? [],
    acceptedValues: answerContract?.acceptedValues ?? [],
    correctAnswerDisplay: row.correctAnswerDisplay,
    explanation: row.explanation,
    difficulty: row.difficulty,
    expectedSeconds: row.expectedSeconds,
    verificationStatus: row.verificationStatus,
    verificationSummary: {
      status: row.verificationStatus,
      acceptanceDecision: row.acceptanceDecision,
      note: "Pipeline status only; it does not guarantee linguistic correctness.",
    },
    acceptanceDecision: row.acceptanceDecision,
    lifecycle: isRetired ? "retired" : "active",
    retiredAt: row.retiredAt,
    retirementReason: row.retirementReason,
    retirement: {
      isRetired,
      retiredAt: row.retiredAt,
      reason: row.retirementReason,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.updatedAt.toISOString(),
    recordRevision: row.updatedAt.toISOString(),
    skillSpecVersion: row.skillSpecVersion,
    skillSpecFingerprint: row.skillSpecFingerprint,
    exerciseSpecVersion: row.exerciseSpecVersion,
    blueprintVersion: row.blueprintVersion,
    blueprintSlot: row.blueprintSlot,
    exerciseFamily: row.exerciseFamily,
    qualityVersion: row.qualityVersion,
    sourceRefs,
    exerciseSourceRefs,
    provenance: summarizeExerciseProvenance({
      exerciseProvenance: row.provenance,
      generationMetadata: row.generationMetadata,
      exerciseSourceRefs: row.sourceRefs,
      sourceRefs,
    }),
  };
}

export function summarizeExerciseProvenance(input: {
  exerciseProvenance: unknown;
  generationMetadata: unknown;
  exerciseSourceRefs: unknown;
  sourceRefs: readonly SanitizedExerciseSourceRef[];
}): ExerciseProvenanceSummary {
  const sourceRevisionIds = new Set<string>();
  const sourceFileIds = new Set<string>(input.sourceRefs.map((sourceRef) => sourceRef.sourceFileId));
  const evidenceAnchorIds = new Set<string>();
  const contentHashes = new Set<string>();
  let kind: string | null = null;

  const addIdentifiers = (target: Set<string>, value: unknown) => {
    for (const candidate of readSafeStringList(value)) {
      target.add(candidate);
    }
  };

  const readProvenanceObject = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }

    const candidateKind = readSafeIdentifier(value.kind);
    if (candidateKind) {
      kind = candidateKind;
    }
    addIdentifiers(sourceRevisionIds, value.sourceRevisionIds);
    addIdentifiers(sourceFileIds, value.sourceFileIds);
    addIdentifiers(sourceFileIds, value.sourceIds);
    addIdentifiers(evidenceAnchorIds, value.evidenceAnchorIds);
    addIdentifiers(evidenceAnchorIds, value.evidenceIds);
    addHashes(contentHashes, value.contentHashes);
    addHashes(contentHashes, value.sourceFingerprints);
    addHashes(contentHashes, value.sourceHashes);

    const contextManifest = value.contextManifest;
    if (isRecord(contextManifest)) {
      addIdentifiers(sourceRevisionIds, contextManifest.sourceRevisionIds);
      addIdentifiers(sourceFileIds, contextManifest.sourceFileIds);
      addIdentifiers(evidenceAnchorIds, contextManifest.sectionIds);
      addIdentifiers(evidenceAnchorIds, contextManifest.chunkIds);
      addHashes(contentHashes, contextManifest.contentHashes);

      if (Array.isArray(contextManifest.includedSources)) {
        for (const source of contextManifest.includedSources) {
          if (!isRecord(source)) {
            continue;
          }
          addIdentifiers(sourceFileIds, source.sourceId);
          addIdentifiers(sourceFileIds, source.sourceFileId);
          addIdentifiers(sourceRevisionIds, source.revisionId);
          addIdentifiers(sourceRevisionIds, source.sourceRevisionId);
          addIdentifiers(evidenceAnchorIds, source.evidenceId);
          addIdentifiers(evidenceAnchorIds, source.chunkId);
          addHashes(contentHashes, source.fingerprint);
        }
      }
    }
  };

  readProvenanceObject(input.generationMetadata);
  readProvenanceObject(input.exerciseProvenance);

  if (Array.isArray(input.exerciseSourceRefs)) {
    for (const sourceRef of input.exerciseSourceRefs) {
      if (!isRecord(sourceRef)) {
        continue;
      }
      addIdentifiers(sourceFileIds, sourceRef.sourceFileId);
      addIdentifiers(sourceFileIds, sourceRef.source_file_id);
      addIdentifiers(sourceRevisionIds, sourceRef.sourceRevisionId);
      addIdentifiers(sourceRevisionIds, sourceRef.revisionId);
      addIdentifiers(sourceRevisionIds, sourceRef.source_revision_id);
      addIdentifiers(sourceRevisionIds, sourceRef.materialRevisionId);
      addIdentifiers(sourceRevisionIds, sourceRef.material_revision_id);
      addIdentifiers(evidenceAnchorIds, sourceRef.evidenceChunkId);
      addIdentifiers(evidenceAnchorIds, sourceRef.evidence_chunk_id);
      addIdentifiers(evidenceAnchorIds, sourceRef.chunkId);
      addIdentifiers(evidenceAnchorIds, sourceRef.sectionId);
      addIdentifiers(evidenceAnchorIds, sourceRef.section_id);
    }
  }

  const sourceBacked =
    sourceRevisionIds.size > 0 ||
    sourceFileIds.size > 0 ||
    evidenceAnchorIds.size > 0 ||
    contentHashes.size > 0;

  return {
    sourceBacked,
    kind,
    sourceRevisionIds: [...sourceRevisionIds],
    sourceFileIds: [...sourceFileIds],
    evidenceAnchorIds: [...evidenceAnchorIds],
    contentHashes: [...contentHashes],
    summary: sourceBacked
      ? "Stored source references and provenance identities are available for this exercise."
      : "No source provenance is recorded for this exercise.",
  };
}

function mapSourceRef(
  sourceRef: ExerciseAuditRow["skill"]["sourceRefs"][number],
): SanitizedExerciseSourceRef {
  return {
    id: sourceRef.id,
    sourceFileId: sourceRef.sourceFileId,
    label: cleanDisplayText(sourceRef.sourceFile.originalName, 300),
    kind: sourceRef.sourceFile.kind,
    status: sourceRef.sourceFile.status,
    materialRevisionId: sourceRef.sourceFile.materialRevisionId,
    locator: sanitizeLocator(sourceRef.locator),
    note: sourceRef.note ? cleanDisplayText(sourceRef.note, 1_000) : null,
    createdAt: sourceRef.createdAt,
  };
}

function sanitizeExerciseSourceIdentities(value: unknown): SanitizedExerciseSourceIdentity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const identities: SanitizedExerciseSourceIdentity[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, 16)) {
    if (!isRecord(entry)) {
      continue;
    }

    const identity: SanitizedExerciseSourceIdentity = {
      sourceFileId: readSafeIdentifier(entry.sourceFileId ?? entry.source_file_id),
      sourceRevisionId: readSafeIdentifier(
        entry.sourceRevisionId ?? entry.source_revision_id ?? entry.revisionId,
      ),
      materialRevisionId: readSafeIdentifier(
        entry.materialRevisionId ?? entry.material_revision_id,
      ),
      sectionId: readSafeIdentifier(entry.sectionId ?? entry.section_id),
      evidenceChunkId: readSafeIdentifier(
        entry.evidenceChunkId ?? entry.evidence_chunk_id ?? entry.chunkId,
      ),
      locator: sanitizeLocator(entry.locator),
    };
    const key = JSON.stringify(identity);

    if (
      !identity.sourceFileId &&
      !identity.sourceRevisionId &&
      !identity.materialRevisionId &&
      !identity.sectionId &&
      !identity.evidenceChunkId &&
      !identity.locator
    ) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    identities.push(identity);
  }

  return identities;
}

export function sanitizeLocator(value: unknown): Record<string, string | number> | null {
  if (!isRecord(value)) {
    return null;
  }

  const safe: Record<string, string | number> = {};
  const stringKeys = [
    "kind",
    "sourceFileId",
    "materialRevisionId",
    "materialSectionId",
    "sectionId",
    "evidenceChunkId",
    "chunkId",
    "sectionTitle",
    "heading",
    "label",
    "anchor",
    "url",
  ];
  const numericKeys = [
    "page",
    "pageStart",
    "pageEnd",
    "lineStart",
    "lineEnd",
    "charStart",
    "charEnd",
    "start",
    "end",
  ];

  for (const key of stringKeys) {
    const child = value[key];
    if (typeof child !== "string" || CONTROL_CHARACTER_PATTERN.test(child)) {
      continue;
    }

    const maximum = key === "url" ? 2_048 : 300;
    const cleaned = child.trim();
    if (key === "url" && !isSafeHttpsUrl(cleaned)) {
      continue;
    }
    if (cleaned && cleaned.length <= maximum) {
      safe[key] = cleaned;
    }
  }

  for (const key of numericKeys) {
    const child = value[key];
    if (typeof child === "number" && Number.isFinite(child)) {
      safe[key] = child;
    }
  }

  return Object.keys(safe).length > 0 ? safe : null;
}

function normalizeLifecycle(value: ExerciseAuditLifecycle | undefined): ExerciseAuditLifecycle {
  if (value === undefined) {
    return "all";
  }
  if (value === "all" || value === "active" || value === "retired") {
    return value;
  }
  throw new Error("listExercisesForAudit received an invalid lifecycle filter.");
}

function normalizeExerciseAuditLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_EXERCISE_AUDIT_LIMIT;
  }
  return Math.min(MAX_EXERCISE_AUDIT_LIMIT, Math.max(1, Math.trunc(limit)));
}

function assertValidDate(value: Date, caller: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${caller} requires a valid now Date.`);
  }
}

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > IDENTIFIER_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new Error(`listExercisesForAudit requires a valid ${name}.`);
  }
  return normalized;
}

function assertMatchingCursor(
  cursor: ExerciseAuditCursor,
  expected: Pick<ExerciseAuditCursor, "userId" | "skillId" | "answerKind" | "lifecycle">,
) {
  if (
    cursor.userId !== expected.userId ||
    cursor.skillId !== expected.skillId ||
    cursor.answerKind !== expected.answerKind ||
    cursor.lifecycle !== expected.lifecycle
  ) {
    throw new ExerciseAuditCursorError("The exercise audit cursor does not match these filters.");
  }
}

function isExerciseAuditCursor(value: unknown): value is ExerciseAuditCursor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === CURSOR_VERSION &&
    isNonEmptyString(value.userId) &&
    isNonEmptyString(value.skillId) &&
    (value.answerKind === null || Object.values(AnswerKind).includes(value.answerKind as AnswerKind)) &&
    (value.lifecycle === "all" || value.lifecycle === "active" || value.lifecycle === "retired") &&
    isValidIsoDate(value.snapshotCutoff) &&
    isValidIsoDate(value.createdAt) &&
    isNonEmptyString(value.id)
  );
}

function isValidIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSafeIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function readSafeStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const identifier = readSafeIdentifier(value);
    return identifier ? [identifier] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(readSafeIdentifier).filter((item): item is string => item !== null))];
}

function addHashes(target: Set<string>, value: unknown) {
  if (typeof value === "string") {
    if (HASH_PATTERN.test(value)) {
      target.add(value.toLowerCase());
    }
    return;
  }

  if (isRecord(value)) {
    addHashes(target, value.fingerprint);
    addHashes(target, value.contentHash);
    addHashes(target, value.hash);
    return;
  }

  if (!Array.isArray(value)) {
    return;
  }

  for (const candidate of value) {
    if (typeof candidate === "string" && HASH_PATTERN.test(candidate)) {
      target.add(candidate.toLowerCase());
    } else if (isRecord(candidate)) {
      addHashes(target, candidate);
    }
  }
}

function cleanDisplayText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, maximum);
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
