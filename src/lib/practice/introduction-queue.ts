import "server-only";

import {
  AnswerKind,
  ExerciseVerificationStatus,
  GenerationJobStatus,
  SkillStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady, resolveReadModelTextPolicy } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

export const MAX_INTRODUCTION_QUEUE_ITEMS = 250;
export const DEFAULT_INTRODUCTION_QUEUE_PAGE_SIZE = 25;
export const MAX_INTRODUCTION_QUEUE_PAGE_SIZE = MAX_INTRODUCTION_QUEUE_ITEMS;
export const UNCOLLECTED_INTRODUCTION_QUEUE_KEY = "uncategorized";

const INTRODUCTION_QUEUE_CURSOR_VERSION = 1;
const QUEUE_TEMPORARY_POSITION_OFFSET = MAX_INTRODUCTION_QUEUE_ITEMS + 1_000;
const unintroducedSkillWhere: Prisma.SkillWhereInput = {
  firstIntroducedAt: null,
  lastReviewedAt: null,
  repetitions: 0,
};

type QueueClient = Pick<
  Prisma.TransactionClient,
  "introductionQueue" | "introductionQueueEntry" | "skill" | "collection"
>;

type QueueCursor = {
  cursorVersion: typeof INTRODUCTION_QUEUE_CURSOR_VERSION;
  queueId: string;
  queueVersion: number;
  position: number;
  entryId: string;
};

export type IntroductionQueueItemStatus =
  | "queued"
  | "preparing"
  | "paused"
  | "archived"
  | "unavailable";

export type IntroductionQueueItem = {
  entryId: string;
  skillId: string;
  position: number;
  title: string;
  status: IntroductionQueueItemStatus;
  reason: string | null;
};

export type IntroductionQueueSkippedItem = {
  skillId: string;
  reason: string;
};

export type IntroductionQueuePage = {
  queueId: string;
  collectionId: string | null;
  scopeKey: string;
  version: number;
  items: IntroductionQueueItem[];
  nextCursor: string | null;
  introducedCount: number;
  skipped: IntroductionQueueSkippedItem[];
};

export type IntroductionQueueOverviewGroup = IntroductionQueuePage & {
  collectionName: string;
};

export class IntroductionQueueError extends Error {
  constructor(
    readonly code:
      | "collection_not_found"
      | "skill_not_found"
      | "invalid_cursor"
      | "stale_state"
      | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "IntroductionQueueError";
  }
}

export function introductionQueueScopeKey(collectionId: string | null): string {
  return collectionId ?? UNCOLLECTED_INTRODUCTION_QUEUE_KEY;
}

export function compareIntroductionQueuePositions(
  left: Pick<IntroductionQueueItem, "position" | "entryId">,
  right: Pick<IntroductionQueueItem, "position" | "entryId">,
): number {
  return left.position - right.position || left.entryId.localeCompare(right.entryId);
}

export function compareIntroductionQueueCandidates(
  left: { skillId: string; collectionId: string | null },
  right: { skillId: string; collectionId: string | null },
  order: ReadonlyMap<string, { collectionId: string | null; position: number }>,
): number {
  const leftOrder = order.get(left.skillId);
  const rightOrder = order.get(right.skillId);
  return (
    (leftOrder?.position ?? Number.MAX_SAFE_INTEGER) -
      (rightOrder?.position ?? Number.MAX_SAFE_INTEGER) ||
    (leftOrder?.collectionId ?? left.collectionId ?? "").localeCompare(
      rightOrder?.collectionId ?? right.collectionId ?? "",
    ) ||
    left.skillId.localeCompare(right.skillId)
  );
}

export async function ensureIntroductionQueue(
  tx: QueueClient,
  userId: string,
  collectionId: string | null,
): Promise<{ id: string; collectionId: string | null; scopeKey: string; version: number }> {
  if (collectionId !== null) {
    const collection = await tx.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true },
    });
    if (!collection) {
      throw new IntroductionQueueError("collection_not_found", "The collection was not found.");
    }
  }

  const scopeKey = introductionQueueScopeKey(collectionId);
  let queue = await tx.introductionQueue.findUnique({
    where: { userId_scopeKey: { userId, scopeKey } },
    select: { id: true, collectionId: true, scopeKey: true, version: true },
  });
  if (!queue) {
    queue = await tx.introductionQueue.create({
      data: { userId, collectionId, scopeKey },
      select: { id: true, collectionId: true, scopeKey: true, version: true },
    });
  }

  const existing = await tx.introductionQueueEntry.findMany({
    where: { userId, queueId: queue.id },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, skillId: true, position: true },
  });
  const availableSkills = await tx.skill.findMany({
    where: {
      userId,
      ...unintroducedSkillWhere,
      collectionId,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_INTRODUCTION_QUEUE_ITEMS,
    select: { id: true },
  });
  const availableIds = new Set(availableSkills.map((skill) => skill.id));
  const retained = existing.filter((entry) => availableIds.has(entry.skillId));
  const retainedIds = new Set(retained.map((entry) => entry.skillId));
  const missing = availableSkills.filter((skill) => !retainedIds.has(skill.id));
  const desiredSkillIds = [
    ...retained.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)).map((entry) => entry.skillId),
    ...missing.map((skill) => skill.id),
  ];
  const currentSkillIds = existing
    .filter((entry) => availableIds.has(entry.skillId))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((entry) => entry.skillId);

  if (!sameStringArray(currentSkillIds, desiredSkillIds) || existing.length !== retained.length) {
    await rewriteQueueEntries(tx, queue.id, userId, existing, desiredSkillIds);
    queue = await tx.introductionQueue.update({
      where: { id_userId: { id: queue.id, userId } },
      data: { version: { increment: 1 } },
      select: { id: true, collectionId: true, scopeKey: true, version: true },
    });
  }

  return queue;
}

export async function getIntroductionQueuePage(
  tx: QueueClient,
  input: {
    userId: string;
    collectionId: string | null;
    cursor?: string;
    limit?: number;
    sync?: boolean;
  },
): Promise<IntroductionQueuePage> {
  const limit = Math.min(
    MAX_INTRODUCTION_QUEUE_PAGE_SIZE,
    Math.max(1, input.limit ?? DEFAULT_INTRODUCTION_QUEUE_PAGE_SIZE),
  );
  const queue = input.sync === false
    ? await loadQueueWithoutSync(tx, input.userId, input.collectionId)
    : await ensureIntroductionQueue(tx, input.userId, input.collectionId);
  const decodedCursor = input.cursor ? decodeIntroductionQueueCursor(input.cursor) : null;
  if (decodedCursor && (decodedCursor.queueId !== queue.id || decodedCursor.queueVersion !== queue.version)) {
    throw new IntroductionQueueError(
      "stale_state",
      "The introduction queue changed. Refresh it before requesting another page.",
    );
  }

  const entries = await tx.introductionQueueEntry.findMany({
    where: {
      userId: input.userId,
      queueId: queue.id,
      ...(decodedCursor
        ? {
            OR: [
              { position: { gt: decodedCursor.position } },
              { position: decodedCursor.position, id: { gt: decodedCursor.entryId } },
            ],
          }
        : {}),
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      skillId: true,
      position: true,
      skill: {
        select: {
          id: true,
          title: true,
          status: true,
          repetitions: true,
          alreadyStudied: true,
          textPolicy: true,
          exercises: {
            select: {
              answerKind: true,
              verificationStatus: true,
              retiredAt: true,
              choices: true,
              answerSpec: true,
            },
          },
          generationJobs: {
            where: { status: { in: [GenerationJobStatus.PENDING, GenerationJobStatus.RUNNING] } },
            take: 1,
            select: { id: true },
          },
          collection: { select: { textPolicy: true } },
        },
      },
    },
  });
  const pageEntries = entries.slice(0, limit);
  const last = pageEntries.at(-1);
  const skills = await tx.skill.findMany({
    where: { userId: input.userId, collectionId: input.collectionId },
    select: { firstIntroducedAt: true, lastReviewedAt: true, repetitions: true },
  });
  const introducedCount = skills.filter((skill) => isIntroduced(skill)).length;
  const items = pageEntries.map(toQueueItem);
  const skipped = items
    .filter((item) => item.status !== "queued")
    .map((item) => ({ skillId: item.skillId, reason: item.reason ?? "This skill is not currently selectable." }));

  return {
    queueId: queue.id,
    collectionId: queue.collectionId,
    scopeKey: queue.scopeKey,
    version: queue.version,
    items,
    nextCursor: entries.length > limit && last
      ? encodeIntroductionQueueCursor({
          cursorVersion: INTRODUCTION_QUEUE_CURSOR_VERSION,
          queueVersion: queue.version,
        position: last.position,
        entryId: last.id,
        queueId: queue.id,
      })
      : null,
    introducedCount,
    skipped,
  };
}

export async function getIntroductionQueueOverview(
  userId: string,
): Promise<IntroductionQueueOverviewGroup[]> {
  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
    const scopes = await tx.skill.findMany({
      where: { userId, ...unintroducedSkillWhere },
      distinct: ["collectionId"],
      select: { collectionId: true },
      orderBy: [{ collectionId: "asc" }],
    });
    const collectionIds = scopes.map((scope) => scope.collectionId);
    const collections = await tx.collection.findMany({
      where: { userId, id: { in: collectionIds.filter((id): id is string => id !== null) } },
      select: { id: true, name: true },
    });
    const names = new Map(collections.map((collection) => [collection.id, collection.name]));
    const groups: IntroductionQueueOverviewGroup[] = [];
    for (const collectionId of collectionIds) {
      const page = await getIntroductionQueuePage(tx, {
        userId,
        collectionId,
        limit: MAX_INTRODUCTION_QUEUE_PAGE_SIZE,
      });
      if (page.items.length === 0) continue;
      groups.push({
        ...page,
        collectionName: collectionId === null ? "Uncollected skills" : names.get(collectionId) ?? "Collection",
      });
    }
    return groups;
  }, { timeout: 15_000 });
}

export async function getIntroductionQueueOrder(
  tx: QueueClient,
  input: {
    userId: string;
    collectionIds: readonly (string | null)[];
    sync?: boolean;
  },
): Promise<Map<string, { collectionId: string | null; position: number }>> {
  const order = new Map<string, { collectionId: string | null; position: number }>();
  for (const collectionId of [...new Set(input.collectionIds)]) {
    const queue = input.sync === false
      ? await loadQueueWithoutSync(tx, input.userId, collectionId)
      : await ensureIntroductionQueue(tx, input.userId, collectionId);
    const entries = await tx.introductionQueueEntry.findMany({
      where: { userId: input.userId, queueId: queue.id },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { skillId: true, position: true },
    });
    entries.forEach((entry) => order.set(entry.skillId, { collectionId, position: entry.position }));
    const missingSkills = await tx.skill.findMany({
      where: { userId: input.userId, ...unintroducedSkillWhere, collectionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_INTRODUCTION_QUEUE_ITEMS,
      select: { id: true },
    });
    let nextPosition = entries.reduce((maximum, entry) => Math.max(maximum, entry.position), -1) + 1;
    for (const skill of missingSkills) {
      if (order.has(skill.id)) continue;
      order.set(skill.id, { collectionId, position: nextPosition });
      nextPosition += 1;
    }
  }
  return order;
}

export async function updateIntroductionQueue(
  tx: QueueClient,
  input: {
    userId: string;
    collectionId: string | null;
    expectedVersion: number;
    skillIds: readonly string[];
  },
): Promise<IntroductionQueuePage> {
  if (new Set(input.skillIds).size !== input.skillIds.length) {
    throw new IntroductionQueueError("invalid_input", "Introduction queue skill IDs must be unique.");
  }
  if (input.skillIds.length > MAX_INTRODUCTION_QUEUE_ITEMS) {
    throw new IntroductionQueueError("invalid_input", "An introduction queue cannot contain more than 250 skills.");
  }
  const queue = await ensureIntroductionQueue(tx, input.userId, input.collectionId);
  if (queue.version !== input.expectedVersion) {
    throw new IntroductionQueueError(
      "stale_state",
      "The introduction queue changed. Read it again before reordering it.",
    );
  }
  const entries = await tx.introductionQueueEntry.findMany({
    where: { userId: input.userId, queueId: queue.id },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, skillId: true, position: true },
  });
  const currentSkillIds = entries.map((entry) => entry.skillId);
  if (!sameStringSet(currentSkillIds, input.skillIds)) {
    const knownSkills = await tx.skill.count({
      where: { userId: input.userId, id: { in: [...input.skillIds] } },
    });
    throw new IntroductionQueueError(
      knownSkills === input.skillIds.length ? "invalid_input" : "skill_not_found",
      knownSkills === input.skillIds.length
        ? "Send exactly the unintroduced skill IDs in this queue."
        : "One or more requested skills do not belong to this account.",
    );
  }
  if (!sameStringArray(currentSkillIds, input.skillIds)) {
    await rewriteQueueEntries(tx, queue.id, input.userId, entries, input.skillIds);
    await tx.introductionQueue.update({
      where: { id_userId: { id: queue.id, userId: input.userId } },
      data: { version: { increment: 1 } },
    });
  }
  return getIntroductionQueuePage(tx, {
    userId: input.userId,
    collectionId: input.collectionId,
    limit: MAX_INTRODUCTION_QUEUE_PAGE_SIZE,
    sync: false,
  });
}

export async function removeSkillFromIntroductionQueues(
  tx: Pick<Prisma.TransactionClient, "introductionQueueEntry" | "introductionQueue">,
  userId: string,
  skillId: string,
): Promise<void> {
  const entries = await tx.introductionQueueEntry.findMany({
    where: { userId, skillId },
    select: { id: true, queueId: true },
  });
  if (entries.length === 0) return;
  await tx.introductionQueueEntry.deleteMany({
    where: { userId, id: { in: entries.map((entry) => entry.id) } },
  });
  await tx.introductionQueue.updateMany({
    where: { userId, id: { in: entries.map((entry) => entry.queueId) } },
    data: { version: { increment: 1 } },
  });
}

export function isIntroductionQueueReadyStatus(status: IntroductionQueueItemStatus): boolean {
  return status === "queued";
}

function toQueueItem(entry: QueueEntryWithSkill): IntroductionQueueItem {
  const status = getQueueItemStatus(entry.skill);
  return {
    entryId: entry.id,
    skillId: entry.skillId,
    position: entry.position,
    title: entry.skill.title,
    status: status.status,
    reason: status.reason,
  };
}

type QueueEntryWithSkill = {
  id: string;
  skillId: string;
  position: number;
  skill: {
    title: string;
    status: SkillStatus;
    repetitions: number;
    alreadyStudied: boolean;
    textPolicy: Prisma.JsonValue | null;
    exercises: Array<{
      answerKind: AnswerKind;
      verificationStatus: ExerciseVerificationStatus;
      retiredAt: Date | null;
      choices: Prisma.JsonValue | null;
      answerSpec: Prisma.JsonValue;
    }>;
    generationJobs: Array<{ id: string }>;
    collection: { textPolicy: Prisma.JsonValue | null } | null;
  };
};

function getQueueItemStatus(skill: QueueEntryWithSkill["skill"]): {
  status: IntroductionQueueItemStatus;
  reason: string | null;
} {
  if (skill.status === SkillStatus.PAUSED) {
    return { status: "paused", reason: "Paused skills keep their place until resumed." };
  }
  if (skill.status === SkillStatus.ARCHIVED) {
    return { status: "archived", reason: "Archived skills keep their history and cannot be introduced." };
  }
  const textPolicy = resolveReadModelTextPolicy({
    skill: skill.textPolicy,
    collection: skill.collection?.textPolicy,
  });
  const ready = skill.status === SkillStatus.ACTIVE && skill.exercises.some((exercise) =>
    isPracticeReadModelExerciseReady(exercise, {
      repetitions: skill.repetitions,
      alreadyStudied: skill.alreadyStudied,
      textPolicy,
    }),
  );
  if (ready) return { status: "queued", reason: null };
  if (skill.generationJobs.length > 0 || skill.status === SkillStatus.DRAFT) {
    return { status: "preparing", reason: "Exercises are still being prepared." };
  }
  return { status: "unavailable", reason: "No ready exercise is available yet." };
}

async function loadQueueWithoutSync(
  tx: QueueClient,
  userId: string,
  collectionId: string | null,
): Promise<{ id: string; collectionId: string | null; scopeKey: string; version: number }> {
  const scopeKey = introductionQueueScopeKey(collectionId);
  const queue = await tx.introductionQueue.findUnique({
    where: { userId_scopeKey: { userId, scopeKey } },
    select: { id: true, collectionId: true, scopeKey: true, version: true },
  });
  if (queue) return queue;
  return { id: "__virtual__", collectionId, scopeKey, version: 0 };
}

async function rewriteQueueEntries(
  tx: QueueClient,
  queueId: string,
  userId: string,
  existing: Array<{ id: string; skillId: string; position: number }>,
  desiredSkillIds: readonly string[],
): Promise<void> {
  const existingBySkillId = new Map(existing.map((entry) => [entry.skillId, entry]));
  const retainedIds = new Set(
    desiredSkillIds
      .map((skillId) => existingBySkillId.get(skillId)?.id)
      .filter((id): id is string => Boolean(id)),
  );
  const removedIds = existing.filter((entry) => !retainedIds.has(entry.id)).map((entry) => entry.id);
  if (removedIds.length > 0) {
    await tx.introductionQueueEntry.deleteMany({
      where: { userId, queueId, id: { in: removedIds } },
    });
  }
  for (const [index, skillId] of desiredSkillIds.entries()) {
    const entry = existingBySkillId.get(skillId);
    if (entry) {
      await tx.introductionQueueEntry.update({
        where: { id_userId: { id: entry.id, userId } },
        data: { position: -(QUEUE_TEMPORARY_POSITION_OFFSET + index) },
      });
    }
  }
  const missing = desiredSkillIds.filter((skillId) => !existingBySkillId.has(skillId));
  if (missing.length > 0) {
    await tx.introductionQueueEntry.createMany({
      data: missing.map((skillId) => ({
        userId,
        queueId,
        skillId,
        position: -(indexOfOrThrow(desiredSkillIds, skillId) + 1),
      })),
    });
  }
  const all = await tx.introductionQueueEntry.findMany({
    where: { userId, queueId },
    select: { id: true },
  });
  const bySkillId = new Map(
    (await tx.introductionQueueEntry.findMany({
      where: { userId, queueId },
      select: { id: true, skillId: true },
    })).map((entry) => [entry.skillId, entry.id]),
  );
  if (all.length !== desiredSkillIds.length) {
    throw new Error("Introduction queue rewrite produced an unexpected number of entries.");
  }
  for (const [index, skillId] of desiredSkillIds.entries()) {
    const id = bySkillId.get(skillId);
    if (!id) throw new Error("Introduction queue rewrite lost an entry.");
    await tx.introductionQueueEntry.update({
      where: { id_userId: { id, userId } },
      data: { position: index },
    });
  }
}

function isIntroduced(skill: {
  firstIntroducedAt: Date | null;
  lastReviewedAt: Date | null;
  repetitions: number;
}): boolean {
  return Boolean(skill.firstIntroducedAt || skill.lastReviewedAt || skill.repetitions > 0);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function indexOfOrThrow(values: readonly string[], value: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new Error("Value was not found in the introduction queue.");
  return index;
}

function encodeIntroductionQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeIntroductionQueueCursor(value: string): QueueCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<QueueCursor>;
    if (
      parsed.cursorVersion !== INTRODUCTION_QUEUE_CURSOR_VERSION ||
      typeof parsed.queueId !== "string" ||
      parsed.queueId.length === 0 ||
      typeof parsed.queueVersion !== "number" ||
      !Number.isSafeInteger(parsed.queueVersion) ||
      parsed.queueVersion < 0 ||
      typeof parsed.position !== "number" ||
      !Number.isSafeInteger(parsed.position) ||
      parsed.position < 0 ||
      typeof parsed.entryId !== "string" ||
      parsed.entryId.length === 0
    ) {
      throw new Error("Invalid cursor shape.");
    }
    return parsed as QueueCursor;
  } catch {
    throw new IntroductionQueueError("invalid_cursor", "The introduction queue cursor is invalid.");
  }
}
