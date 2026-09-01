import { createHash } from "node:crypto";

import { ZodError } from "zod";

import {
  GenerationAuditDecision,
  GenerationFailureCategory,
  SkillFsrsState,
  type Prisma,
} from "@/generated/prisma/client";
import {
  planExerciseBlueprint,
  type AnswerMode,
  type SubjectCapabilityId,
} from "@/lib/skills/exercise-planning";
import {
  CONTEXT_MANIFEST_VERSION as AUDIT_CONTEXT_MANIFEST_VERSION,
  MAX_GENERATION_AUDIT_LIST_ENTRIES,
  MAX_GENERATION_AUDIT_MEDIA_ITEMS,
  MAX_GENERATION_AUDIT_SELECTED_EVIDENCE,
  contextManifestSchema as auditContextManifestSchema,
} from "@/lib/skills/generation-audit";
import {
  GENERATION_QUALITY_CONTRACT_VERSION,
  assessChoiceCandidateQuality,
  contextManifestSchema,
  exerciseBlueprintSchema,
  skillGenerationSpecSchema,
  type ContextManifest,
  type ExerciseBlueprint,
  type SkillGenerationSpec,
} from "@/lib/skills/generation-quality";
import {
  SOURCE_CONTEXT_CHAR_LIMIT,
  SOURCE_CONTEXT_TRUNCATION_MARKER,
} from "@/lib/skills/source-context";

const SKILL_SPEC_VERSION = "skill-generation-spec-v1";
const BLUEPRINT_VERSION = "exercise-blueprint-v1";
export const CONTEXT_MANIFEST_VERSION = "generation-context-v1" as const;

export type GenerationQualitySkill = {
  id: string;
  title: string;
  objective: string | null;
  rules: Prisma.JsonValue | null;
  examples: Prisma.JsonValue | null;
  exerciseConstraints: Prisma.JsonValue | null;
  tags: string[];
  generationSpec?: Prisma.JsonValue | null;
  fsrsState?: SkillFsrsState | null;
  dueAt?: Date | null;
  repetitions?: number;
  lapses?: number;
  stability?: number | null;
};

export type GenerationQualityContext = {
  skillSpec: SkillGenerationSpec;
  blueprint: ExerciseBlueprint;
  contextManifest: ContextManifest;
  subjectCapability: SubjectCapabilityId;
};

export type GenerationSourceIdentity = {
  sourceFileId: string;
  revisionId: string | null;
  locator: Prisma.JsonValue | null;
};

export function buildGenerationRuntimeMetadata(input: {
  provider: string;
  model: string;
  promptVersion: string;
  context: GenerationQualityContext;
  sourceMedia?: readonly { sourceFileId: string | null; mimeType: string }[];
  endpointMode?: string;
}) {
  const sourceMedia = input.sourceMedia ?? [];
  const allSourceRevisionIds = normalizeAuditIdentifiers(
    input.context.contextManifest.includedSources.flatMap((source) =>
      source.revisionId ? [source.revisionId] : [],
    ),
    "source-revision",
  );
  const allSourceFileIds = normalizeAuditIdentifiers([
    ...input.context.contextManifest.includedSources.map((source) => source.sourceId),
    ...sourceMedia.map((media, index) => media.sourceFileId ?? `attached-media-${index + 1}`),
  ], "source-file");
  const sourceRevisionIds = allSourceRevisionIds.slice(0, MAX_GENERATION_AUDIT_LIST_ENTRIES);
  const sourceFileIds = allSourceFileIds.slice(0, MAX_GENERATION_AUDIT_LIST_ENTRIES);
  const contentHashes = uniqueStrings(
    input.context.contextManifest.sourceFingerprints
      .map((source) => source.fingerprint)
      .filter((fingerprint) => /^[a-f0-9]{64}$/i.test(fingerprint)),
  ).slice(0, MAX_GENERATION_AUDIT_LIST_ENTRIES);
  const selectedEvidenceCount =
    input.context.contextManifest.includedSources.length + sourceMedia.length;
  const contextManifestHash = sha256(stableJson({
    contextManifest: input.context.contextManifest,
    sourceMedia: sourceMedia.map((media) => ({
      sourceFileId: media.sourceFileId,
      mimeType: media.mimeType,
    })),
  }));
  const auditContextManifest = auditContextManifestSchema.parse({
    version: AUDIT_CONTEXT_MANIFEST_VERSION,
    manifestHash: contextManifestHash,
    sourceRevisionIds,
    sourceFileIds,
    sectionIds: [],
    chunkIds: [],
    pageNumbers: [],
    contentHashes,
    sourceKind: sourceKind(input.context.contextManifest.includedSources.length > 0, sourceMedia),
    mediaCount: Math.min(sourceMedia.length, MAX_GENERATION_AUDIT_MEDIA_ITEMS),
    selectedEvidenceCount: Math.min(
      selectedEvidenceCount,
      MAX_GENERATION_AUDIT_SELECTED_EVIDENCE,
    ),
    evidenceOmitted:
      input.context.contextManifest.omittedSources.length > 0 ||
      input.context.contextManifest.truncationNotices.length > 0 ||
      sourceRevisionIds.length < allSourceRevisionIds.length ||
      sourceFileIds.length < allSourceFileIds.length ||
      sourceMedia.length > MAX_GENERATION_AUDIT_MEDIA_ITEMS,
  });
  const releaseTupleWithoutFingerprint = {
    provider: input.provider,
    model: input.model,
    endpointMode: input.endpointMode ?? endpointModeForProvider(input.provider),
    generationPromptVersion: input.promptVersion,
    verificationPromptVersion: `${input.promptVersion}-solve-first-v1`,
    responseSchemaVersion: "choice-exercise-response-v1",
    validatorVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    contextBuilderVersion: input.context.contextManifest.manifestVersion,
    skillSpecSchemaVersion: input.context.skillSpec.contractVersion,
    blueprintVersion: input.context.blueprint.blueprintVersion,
    qualityVersion: GENERATION_QUALITY_CONTRACT_VERSION,
  };
  return {
    releaseTuple: {
      ...releaseTupleWithoutFingerprint,
      fingerprint: sha256(stableJson(releaseTupleWithoutFingerprint)),
    },
    contextManifest: auditContextManifest,
    contextManifestHash,
  };
}

export type GenerationQualityContextBuildResult =
  | { status: "ready"; context: GenerationQualityContext }
  | {
      status: "invalid";
      failureCategory: GenerationFailureCategory;
      message: string;
    };

export function safeBuildGenerationQualityContext(
  input: Parameters<typeof buildGenerationQualityContext>[0],
): GenerationQualityContextBuildResult {
  try {
    return { status: "ready", context: buildGenerationQualityContext(input) };
  } catch (error) {
    const diagnostic = formatQualityContextError(error);
    console.error("[ai] generation quality context build failed", { diagnostic });
    return {
      status: "invalid",
      failureCategory: GenerationFailureCategory.SCHEMA,
      message:
        `Generation quality context failed deterministic contract validation: ${diagnostic}`,
    };
  }
}

export function buildGenerationQualityContext(input: {
  skill: GenerationQualitySkill;
  sourceContext: string | null;
  requestedCount: number;
  answerModes?: readonly AnswerMode[];
  now?: Date;
  sourceEvidence?: readonly GenerationSourceIdentity[];
}): GenerationQualityContext {
  const existingSpec = skillGenerationSpecSchema.safeParse(input.skill.generationSpec);
  const subjectCapability = inferSubjectCapability(input.skill);
  const materialFingerprint = sha256(
    stableJson({
      skill: {
        title: input.skill.title,
        objective: input.skill.objective,
        rules: input.skill.rules,
        examples: input.skill.examples,
        exerciseConstraints: input.skill.exerciseConstraints,
        tags: input.skill.tags,
      },
      sourceFingerprint: input.sourceContext ? sha256(input.sourceContext) : null,
    }),
  );
  const objective = boundedText(
    input.skill.objective?.trim() || `Practice ${input.skill.title.trim() || "this skill"}.`,
    1_200,
  );
  const includedScope = normalizeTextList(
    [input.skill.title, ...input.skill.tags],
    240,
    32,
    "The approved skill objective.",
  );
  const skillSpec = existingSpec.success
    ? existingSpec.data
    : skillGenerationSpecSchema.parse({
        contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
        specVersion: SKILL_SPEC_VERSION,
        objective,
        observableSuccessCriteria: [
          boundedText(
            input.skill.objective?.trim() ||
              `Answer objective exercises about ${input.skill.title.trim() || "this skill"}.`,
            500,
          ),
        ],
        prerequisiteAssumptions: [],
        scopeBoundaries: {
          included: includedScope,
          excluded: ["Claims not supported by the skill definition or linked source evidence."],
        },
        sourceRequirements: {
          required: Boolean(input.sourceContext),
          minimumEvidenceAnchors: input.sourceContext ? 1 : 0,
          allowedProvenance: input.sourceContext
            ? ["learner-source", "pedagogical-transformation"]
            : ["pedagogical-transformation"],
        },
        allowedExerciseModes: ["recall", "application", "discrimination", "transfer"],
        difficultyPolicy: {
          min: 1,
          max: 5,
          target: targetDifficulty(input.skill),
          progression: "mastery-aware",
          dimensions: ["cueing", "surface-complexity", "transfer-distance", "response-production"],
        },
        explanationPolicy: {
          required: true,
          maxLength: 1_200,
          includeRule: true,
          includeDistractorRationale: false,
        },
        ambiguityPolicy: {
          action: "reject",
          requireSingleDefensibleAnswer: true,
          disallowUnstatedAssumptions: true,
        },
        materialFingerprint,
      });
  const answerModes = input.answerModes?.length ? [...input.answerModes] : ["choice" as const];
  const planned = planExerciseBlueprint({
    skillSpec: {
      ...skillSpec,
      skillId: input.skill.id,
      fingerprint: materialFingerprint,
      allowedAnswerModes: answerModes,
      sourceRequirements: {
        ...skillSpec.sourceRequirements,
        evidenceIds: input.sourceContext ? ["source-context"] : [],
      },
      subjectCapability,
    },
    generationProfile: {
      fsrsState: input.skill.fsrsState ?? SkillFsrsState.NEW,
      dueAt: input.skill.dueAt ?? null,
      now: input.now ?? new Date(0),
      lapses: input.skill.lapses ?? 0,
      repetitions: input.skill.repetitions ?? 0,
      stability: input.skill.stability ?? null,
      desiredCount: Math.max(1, Math.min(10, Math.trunc(input.requestedCount))),
      supportedAnswerModes: answerModes,
      subjectCapability,
    },
    recentExercises: [],
  });
  if (planned.slots.length === 0 && planned.reasonCodes.includes("no_supported_answer_mode")) {
    throw new Error(
      `Skill capability ${subjectCapability} does not support the requested answer modes: ${answerModes.join(", ")}.`,
    );
  }
  const blueprint = exerciseBlueprintSchema.parse({
    contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    blueprintVersion: BLUEPRINT_VERSION,
    skillSpecVersion: skillSpec.specVersion,
    requestedCount: planned.slots.length,
    slots: planned.slots.map((slot) => ({
      slotId: slot.slotId,
      mode: slot.mode,
      targetDifficulty: slot.targetDifficulty,
      misconceptionOrDistractorPurpose: slot.misconceptionOrDistractorPurpose,
      answerMode: slot.answerMode,
      sourceRequirements: slot.sourceRequirements,
      noveltyConstraints: slot.noveltyConstraints,
      familyConstraints: slot.familyConstraints,
      evidenceMode: slot.evidenceMode,
    })),
  });

  return {
    skillSpec,
    blueprint,
    contextManifest: buildContextManifest(input.sourceContext, input.sourceEvidence ?? []),
    subjectCapability,
  };
}

export function toPersistedChoiceQuality(input: {
  context: GenerationQualityContext;
  candidateId: string;
  slotIndex: number;
  exercise: {
    prompt: string;
    choices: Array<{ id: string; label: string }>;
    answerSpec: { kind: "choice"; correctChoiceId: string };
    correctAnswerDisplay: string;
    explanation: string | null;
    difficulty: number | null;
    expectedSeconds: number | null;
  };
}) {
  const slot = input.context.blueprint.slots[input.slotIndex] ?? null;
  const decision = assessChoiceCandidateQuality({
    ...input.exercise,
    candidateId: input.candidateId,
  }, {
    blueprintSlot: slot ?? undefined,
  });

  return {
    skillSpecVersion: input.context.skillSpec.specVersion,
    skillSpecFingerprint: input.context.skillSpec.materialFingerprint,
    exerciseSpecVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    blueprintVersion: input.context.blueprint.blueprintVersion,
    blueprintSlot: slot?.slotId ?? null,
    exerciseFamily: slot?.familyConstraints.allowedFamilies[0] ?? slot?.mode ?? null,
    qualityVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    provenance: {
      sourceIds: input.context.contextManifest.includedSources.map((source) => source.sourceId),
      sourceFingerprints: input.context.contextManifest.sourceFingerprints,
    },
    acceptanceDecision: decision.accepted
      ? GenerationAuditDecision.ACCEPTED
      : GenerationAuditDecision.REJECTED,
    acceptanceMetadata: decision,
    generationMetadata: {
      subjectCapability: input.context.subjectCapability,
      contextManifest: input.context.contextManifest,
    },
  };
}

function buildContextManifest(
  sourceContext: string | null,
  sourceEvidence: readonly GenerationSourceIdentity[],
): ContextManifest {
  if (!sourceContext) {
    return contextManifestSchema.parse({
      contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
      manifestVersion: CONTEXT_MANIFEST_VERSION,
      privacyClassification: "private",
      includedSources: [],
      omittedSources: [],
      truncationNotices: [],
      sourceFingerprints: [],
      fieldLengthAccounting: {},
    });
  }

  const includedCharacters = Array.from(sourceContext).length;
  const truncated = sourceContext.endsWith(SOURCE_CONTEXT_TRUNCATION_MARKER);
  const fingerprint = sha256(sourceContext);
  const identities = sourceEvidence.length
    ? deduplicateSourceEvidence(sourceEvidence)
    : [{ sourceFileId: "source-context", revisionId: null, locator: "linked source excerpt" }];
  return contextManifestSchema.parse({
    contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
    manifestVersion: CONTEXT_MANIFEST_VERSION,
    privacyClassification: "private",
    includedSources: identities.map((identity) => ({
      sourceId: identity.sourceFileId,
      revisionId: identity.revisionId,
      locator: formatLocator(identity.locator),
      fingerprint: sha256(`${identity.sourceFileId}:${fingerprint}`),
      charactersIncluded: includedCharacters,
    })),
    omittedSources: [],
    truncationNotices: truncated
      ? [
          {
            field: "sourceContext",
            sourceId: "source-context",
            originalCharacters: includedCharacters + 1,
            includedCharacters,
            reason: "provider-limit",
          },
        ]
      : [],
    sourceFingerprints: identities.map((identity) => ({
      sourceId: identity.sourceFileId,
      fingerprint: sha256(`${identity.sourceFileId}:${fingerprint}`),
    })),
    fieldLengthAccounting: {
      sourceContext: {
        originalCharacters: truncated ? includedCharacters + 1 : includedCharacters,
        includedCharacters,
        limitCharacters: SOURCE_CONTEXT_CHAR_LIMIT,
        truncated,
      },
    },
  });
}

function formatLocator(locator: Prisma.JsonValue | null): string {
  if (locator === null) return "linked source excerpt";
  return stableJson(locator).slice(0, 600) || "linked source excerpt";
}

function inferSubjectCapability(skill: GenerationQualitySkill): SubjectCapabilityId {
  const terms = `${skill.title} ${skill.tags.join(" ")}`.toLowerCase();
  if (/\b(math|algebra|arithmetic|calculus|geometry|statistics|probability)\b/u.test(terms)) {
    return "symbolic_numeric";
  }
  if (/\b(language|grammar|spanish|french|german|vocabulary|conjugation)\b/u.test(terms)) {
    return "language_form";
  }
  return "conceptual_source_grounded";
}

function targetDifficulty(skill: GenerationQualitySkill): number {
  if ((skill.lapses ?? 0) > 1 || skill.fsrsState === SkillFsrsState.RELEARNING) {
    return 2;
  }
  if ((skill.repetitions ?? 0) >= 5 && (skill.stability ?? 0) >= 10) {
    return 4;
  }
  return 3;
}

function endpointModeForProvider(provider: string): string {
  return provider.toLowerCase() === "meta" ? "responses" : "enterprise-agent-platform";
}

function sourceKind(
  hasText: boolean,
  media: readonly { mimeType: string }[],
): "none" | "pdf" | "image" | "text" | "mixed" {
  if (media.length === 0) return hasText ? "text" : "none";
  const kinds = new Set([
    ...(hasText ? ["text"] : []),
    ...media.map((item) =>
    item.mimeType === "application/pdf"
      ? "pdf"
      : item.mimeType.startsWith("image/")
        ? "image"
        : "other",
    ),
  ]);
  if (kinds.size === 1 && kinds.has("pdf")) return "pdf";
  if (kinds.size === 1 && kinds.has("image")) return "image";
  return "mixed";
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim();
  return Array.from(normalized || "Unspecified skill.").slice(0, maximum).join("");
}

function normalizeTextList(
  values: readonly string[],
  maximumLength: number,
  maximumItems: number,
  fallback: string,
): string[] {
  const normalized = uniqueStrings(
    values
      .map((value) => boundedText(value, maximumLength))
      .filter(Boolean),
  ).slice(0, maximumItems);
  return normalized.length ? normalized : [fallback];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeAuditIdentifiers(values: readonly string[], namespace: string): string[] {
  return uniqueStrings(
    values.map((value) => {
      const normalized = value.trim();
      if (
        normalized.length <= 200 &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
      ) {
        return normalized;
      }
      return `${namespace}:${sha256(value)}`;
    }),
  );
}

function formatQualityContextError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error
    ? Array.from(error.message.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 500).join("")
    : "unknown schema error";
}

function deduplicateSourceEvidence(
  sourceEvidence: readonly GenerationSourceIdentity[],
): GenerationSourceIdentity[] {
  const bySourceFileId = new Map<string, GenerationSourceIdentity>();
  for (const identity of sourceEvidence) {
    const sourceFileId = identity.sourceFileId.trim();
    if (!sourceFileId || bySourceFileId.has(sourceFileId)) continue;
    bySourceFileId.set(sourceFileId, { ...identity, sourceFileId });
  }
  return [...bySourceFileId.values()];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
