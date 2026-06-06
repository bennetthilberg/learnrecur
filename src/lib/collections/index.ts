import "server-only";

import { z } from "zod";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseVerificationStatus,
  SkillStatus,
  type Collection,
  type Prisma,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

const collectionInputSchema = z.strictObject({
  name: z
    .string()
    .transform(normalizeCollectionName)
    .pipe(
      z
        .string()
        .min(1, "Collection name is required.")
        .max(80, "Keep the collection name to 80 characters or fewer."),
    ),
  description: optionalTrimmedString().pipe(
    z.string().max(500, "Keep the description to 500 characters or fewer.").nullable(),
  ),
});

export type NormalizedCollectionInput = {
  name: string;
  description: string | null;
  nameKey: string;
};

export type CollectionInputResult =
  | {
      status: "ready";
      value: NormalizedCollectionInput;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    };

export type CollectionSkillCounts = {
  active: number;
  draft: number;
  paused: number;
  archived: number;
};

export type CollectionSummary = {
  id: string;
  name: string;
  description: string | null;
  status: CollectionStatus;
  skillCounts: CollectionSkillCounts;
  readyNowCount: number;
  sourceCount: number;
  updatedAt: Date;
};

export type CollectionsHome = {
  activeCollections: CollectionSummary[];
  archivedCollections: CollectionSummary[];
};

export type GetCollectionsHomeInput = {
  userId: string;
  now: Date;
};

export type CreateCollectionResult =
  | {
      status: "created";
      collection: Collection;
    }
  | Extract<CollectionInputResult, { status: "invalid" }>;

export type UpdateCollectionResult =
  | {
      status: "updated";
      collection: Collection;
    }
  | Extract<CollectionInputResult, { status: "invalid" }>
  | CollectionNotFoundResult;

export type CollectionLifecycleResult =
  | {
      status: "updated";
      previousStatus: CollectionStatus;
      collection: Collection;
      message: string;
    }
  | Extract<CollectionInputResult, { status: "invalid" }>
  | CollectionNotFoundResult
  | {
      status: "not-updated";
      reason: "already-active" | "already-archived";
      message: string;
    };

type CollectionNotFoundResult = {
  status: "not-found";
  reason: "collection-not-found";
  message: string;
};

type CollectionRecord = {
  id: string;
  name: string;
  description: string | null;
  status: CollectionStatus;
  updatedAt: Date;
  sourceFiles: Array<{ id: string }>;
  skills: Array<{
    id: string;
    status: SkillStatus;
    dueAt: Date | null;
    stability: number | null;
    difficulty: number | null;
    repetitions: number;
    exercises: Array<{
      answerKind: AnswerKind;
      verificationStatus: ExerciseVerificationStatus;
      retiredAt: Date | null;
      choices: Prisma.JsonValue | null;
      answerSpec: Prisma.JsonValue;
    }>;
  }>;
};

export function normalizeCollectionName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeCollectionInput(input: unknown): CollectionInputResult {
  const result = collectionInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Collection details need a little attention.",
      fieldErrors: z.flattenError(result.error).fieldErrors,
    };
  }

  return {
    status: "ready",
    value: {
      name: result.data.name,
      description: result.data.description,
      nameKey: toCollectionNameKey(result.data.name),
    },
  };
}

export async function getCollectionsHome(
  input: GetCollectionsHomeInput,
): Promise<CollectionsHome> {
  const prisma = getPrisma();
  const collections = await prisma.collection.findMany({
    where: {
      userId: input.userId,
    },
    orderBy: [{ status: "asc" }, { name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      updatedAt: true,
      sourceFiles: {
        select: {
          id: true,
        },
      },
      skills: {
        select: {
          id: true,
          status: true,
          dueAt: true,
          stability: true,
          difficulty: true,
          repetitions: true,
          exercises: {
            select: {
              answerKind: true,
              verificationStatus: true,
              retiredAt: true,
              choices: true,
              answerSpec: true,
            },
          },
        },
      },
    },
  });
  const summaries = collections.map((collection) => toCollectionSummary(collection, input.now));

  return {
    activeCollections: summaries
      .filter((collection) => collection.status === CollectionStatus.ACTIVE)
      .toSorted(compareCollectionSummaries),
    archivedCollections: summaries
      .filter((collection) => collection.status === CollectionStatus.ARCHIVED)
      .toSorted(compareCollectionSummaries),
  };
}

export async function createCollection(input: {
  userId: string;
  input: unknown;
}): Promise<CreateCollectionResult> {
  const normalized = normalizeCollectionInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const prisma = getPrisma();
  const duplicate = await findActiveCollectionNameConflict(prisma, {
    userId: input.userId,
    nameKey: normalized.value.nameKey,
  });

  if (duplicate) {
    return duplicateCollectionName();
  }

  const collection = await prisma.collection.create({
    data: {
      userId: input.userId,
      name: normalized.value.name,
      description: normalized.value.description,
      status: CollectionStatus.ACTIVE,
    },
  });

  return {
    status: "created",
    collection,
  };
}

export async function updateCollection(input: {
  userId: string;
  collectionId: string;
  input: unknown;
}): Promise<UpdateCollectionResult> {
  const normalized = normalizeCollectionInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const prisma = getPrisma();
  const collection = await prisma.collection.findFirst({
    where: {
      id: input.collectionId,
      userId: input.userId,
    },
  });

  if (!collection) {
    return collectionNotFound();
  }

  if (collection.status === CollectionStatus.ACTIVE) {
    const duplicate = await findActiveCollectionNameConflict(prisma, {
      userId: input.userId,
      nameKey: normalized.value.nameKey,
      excludeCollectionId: collection.id,
    });

    if (duplicate) {
      return duplicateCollectionName();
    }
  }

  const updated = await prisma.collection.update({
    where: {
      id_userId: {
        id: collection.id,
        userId: input.userId,
      },
    },
    data: {
      name: normalized.value.name,
      description: normalized.value.description,
    },
  });

  return {
    status: "updated",
    collection: updated,
  };
}

export async function archiveCollection(input: {
  userId: string;
  collectionId: string;
}): Promise<CollectionLifecycleResult> {
  const prisma = getPrisma();
  const collection = await prisma.collection.findFirst({
    where: {
      id: input.collectionId,
      userId: input.userId,
    },
  });

  if (!collection) {
    return collectionNotFound();
  }

  if (collection.status === CollectionStatus.ARCHIVED) {
    return {
      status: "not-updated",
      reason: "already-archived",
      message: "This collection is already archived.",
    };
  }

  const updated = await prisma.collection.update({
    where: {
      id_userId: {
        id: collection.id,
        userId: input.userId,
      },
    },
    data: {
      status: CollectionStatus.ARCHIVED,
    },
  });

  return {
    status: "updated",
    previousStatus: collection.status,
    collection: updated,
    message: "Collection archived.",
  };
}

export async function restoreCollection(input: {
  userId: string;
  collectionId: string;
}): Promise<CollectionLifecycleResult> {
  const prisma = getPrisma();
  const collection = await prisma.collection.findFirst({
    where: {
      id: input.collectionId,
      userId: input.userId,
    },
  });

  if (!collection) {
    return collectionNotFound();
  }

  if (collection.status === CollectionStatus.ACTIVE) {
    return {
      status: "not-updated",
      reason: "already-active",
      message: "This collection is already active.",
    };
  }

  const duplicate = await findActiveCollectionNameConflict(prisma, {
    userId: input.userId,
    nameKey: toCollectionNameKey(collection.name),
    excludeCollectionId: collection.id,
  });

  if (duplicate) {
    return duplicateCollectionName();
  }

  const updated = await prisma.collection.update({
    where: {
      id_userId: {
        id: collection.id,
        userId: input.userId,
      },
    },
    data: {
      status: CollectionStatus.ACTIVE,
    },
  });

  return {
    status: "updated",
    previousStatus: collection.status,
    collection: updated,
    message: "Collection restored.",
  };
}

async function findActiveCollectionNameConflict(
  prisma: ReturnType<typeof getPrisma>,
  input: {
    userId: string;
    nameKey: string;
    excludeCollectionId?: string;
  },
) {
  const activeCollections = await prisma.collection.findMany({
    where: {
      userId: input.userId,
      status: CollectionStatus.ACTIVE,
      ...(input.excludeCollectionId
        ? {
            id: {
              not: input.excludeCollectionId,
            },
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
    },
  });

  return activeCollections.find(
    (collection) => toCollectionNameKey(collection.name) === input.nameKey,
  );
}

function toCollectionSummary(collection: CollectionRecord, now: Date): CollectionSummary {
  const skillCounts: CollectionSkillCounts = {
    active: 0,
    draft: 0,
    paused: 0,
    archived: 0,
  };
  let readyNowCount = 0;

  for (const skill of collection.skills) {
    switch (skill.status) {
      case SkillStatus.ACTIVE:
        skillCounts.active += 1;

        if (isSkillReadyNow(skill, now)) {
          readyNowCount += 1;
        }

        break;
      case SkillStatus.DRAFT:
        skillCounts.draft += 1;
        break;
      case SkillStatus.PAUSED:
        skillCounts.paused += 1;
        break;
      case SkillStatus.ARCHIVED:
        skillCounts.archived += 1;
        break;
    }
  }

  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    status: collection.status,
    skillCounts,
    readyNowCount,
    sourceCount: collection.sourceFiles.length,
    updatedAt: collection.updatedAt,
  };
}

function isSkillReadyNow(skill: CollectionRecord["skills"][number], now: Date): boolean {
  return (
    skill.status === SkillStatus.ACTIVE &&
    skill.dueAt !== null &&
    skill.dueAt.getTime() <= now.getTime() &&
    skill.stability !== null &&
    skill.difficulty !== null &&
    skill.exercises.some((exercise) => isPracticeReadModelExerciseReady(exercise, skill))
  );
}

function compareCollectionSummaries(left: CollectionSummary, right: CollectionSummary) {
  const nameDifference = left.name.localeCompare(right.name);

  if (nameDifference !== 0) {
    return nameDifference;
  }

  return left.id.localeCompare(right.id);
}

function toCollectionNameKey(name: string) {
  return normalizeCollectionName(name).toLocaleLowerCase("en-US");
}

function duplicateCollectionName(): Extract<CollectionInputResult, { status: "invalid" }> {
  return {
    status: "invalid",
    message: "Collection details need a little attention.",
    fieldErrors: {
      name: ["An active collection with this name already exists."],
    },
  };
}

function collectionNotFound(): CollectionNotFoundResult {
  return {
    status: "not-found",
    reason: "collection-not-found",
    message: "Collection was not found.",
  };
}

function optionalTrimmedString() {
  return z.preprocess((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (value === undefined || value === null) {
      return null;
    }

    return value;
  }, z.string().trim().nullable());
}
