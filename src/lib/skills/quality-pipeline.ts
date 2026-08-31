import { createHash } from "node:crypto";

import { GenerationAuditDecision, SkillFsrsState, type Prisma } from "@/generated/prisma/client";
import { planExerciseBlueprint, type SubjectCapabilityId } from "@/lib/skills/exercise-planning";
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

const SKILL_SPEC_VERSION = "skill-generation-spec-v1";
const BLUEPRINT_VERSION = "exercise-blueprint-v1";
const CONTEXT_MANIFEST_VERSION = "generation-context-v1";
const TRUNCATION_MARKER = "[truncated]";

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
}) {
  const releaseTuple = {
    provider: input.provider,
    model: input.model,
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
      ...releaseTuple,
      fingerprint: sha256(stableJson(releaseTuple)),
    },
    contextManifestHash: sha256(stableJson(input.context.contextManifest)),
  };
}

export function buildGenerationQualityContext(input: {
  skill: GenerationQualitySkill;
  sourceContext: string | null;
  requestedCount: number;
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
  const skillSpec = existingSpec.success
    ? existingSpec.data
    : skillGenerationSpecSchema.parse({
        contractVersion: GENERATION_QUALITY_CONTRACT_VERSION,
        specVersion: SKILL_SPEC_VERSION,
        objective: input.skill.objective?.trim() || `Practice ${input.skill.title}.`,
        observableSuccessCriteria: [
          input.skill.objective?.trim() || `Answer objective exercises about ${input.skill.title}.`,
        ],
        prerequisiteAssumptions: [],
        scopeBoundaries: {
          included: [input.skill.title, ...input.skill.tags].filter(Boolean),
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
  const planned = planExerciseBlueprint({
    skillSpec: {
      ...skillSpec,
      skillId: input.skill.id,
      fingerprint: materialFingerprint,
      allowedAnswerModes: ["choice", "text", "numeric", "math"],
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
      supportedAnswerModes: ["choice", "text", "numeric", "math"],
      subjectCapability,
    },
    recentExercises: [],
  });
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
  const decision = assessChoiceCandidateQuality({
    ...input.exercise,
    candidateId: input.candidateId,
  });
  const slot = input.context.blueprint.slots[input.slotIndex] ?? null;

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
      ? GenerationAuditDecision.PUBLISHED
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
  const truncated = sourceContext.trimEnd().endsWith(TRUNCATION_MARKER);
  const fingerprint = sha256(sourceContext);
  const identities = sourceEvidence.length
    ? sourceEvidence
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
        limitCharacters: 4_000,
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
