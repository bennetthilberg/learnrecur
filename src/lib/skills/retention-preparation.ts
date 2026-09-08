import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { ExerciseRefillEventSender } from "@/lib/jobs/events";
import { isExactInputUnlocked } from "@/lib/skills";
import { inferSubjectCapability } from "./quality-pipeline";
import {
  queueChoiceExerciseRefillForSkill,
  queueExactInputExerciseRefillForSkill,
  queueMathExerciseRefillForSkill,
  type RefillQueueResultWithDeferredEvent,
} from "./refill-jobs";

export async function queueRetentionPreparation(input: {
  userId: string;
  skillId: string;
  now: Date;
  sender?: ExerciseRefillEventSender;
  transaction?: Prisma.TransactionClient;
}): Promise<RefillQueueResultWithDeferredEvent[] | undefined> {
  const prisma = input.transaction ?? getPrisma();
  const skill = await prisma.skill.findFirst({
    where: { id: input.skillId, userId: input.userId, status: "ACTIVE" },
  });
  if (!skill) return;
  const results = [
    await queueChoiceExerciseRefillForSkill({
      ...input,
      deferEvent: Boolean(input.transaction),
    }),
  ];
  if (isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
    const capability = inferSubjectCapability(skill);
    results.push(
      capability === "symbolic_numeric"
        ? await queueMathExerciseRefillForSkill({
            ...input,
            deferEvent: Boolean(input.transaction),
          })
        : await queueExactInputExerciseRefillForSkill({
            ...input,
            deferEvent: Boolean(input.transaction),
          }),
    );
  }
  return results;
}

export async function queueDueRetentionPreparation(input: {
  userId: string;
  collectionId?: string | null;
  now: Date;
  sender?: ExerciseRefillEventSender;
}) {
  const skills = await getPrisma().skill.findMany({
    where: {
      userId: input.userId,
      status: "ACTIVE",
      dueAt: { lte: input.now },
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 10,
    select: { id: true },
  });
  for (const skill of skills)
    await queueRetentionPreparation({ ...input, skillId: skill.id });
}
