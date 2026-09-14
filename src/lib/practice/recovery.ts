import { z } from "zod";
import { AnswerKind, FsrsRating, SkillFsrsState } from "@/generated/prisma/enums";
import { answerSpecSchema } from "@/lib/answer-checking";

const exercise = z.object({
  answerKind: z.enum(AnswerKind), prompt: z.string(), answerSpec: answerSpecSchema,
  correctAnswerDisplay: z.string(), explanation: z.string().nullable(),
  difficulty: z.number().nullable(), expectedSeconds: z.number().nullable(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
});
const scope = z.discriminatedUnion("kind", [z.object({ kind: z.literal("all") }), z.object({ kind: z.literal("collection"), collectionId: z.string(), collectionName: z.string() })]);
const fields = { answer: z.string(), checked: z.boolean(), rating: z.enum(FsrsRating).nullable(), responseMs: z.number().nonnegative().nullable() };
export const normalDraftSchema = z.object({
  ...fields, attemptId: z.string(),
  item: z.object({ status: z.literal("ready"), scope,
    skill: z.object({ id: z.string(), title: z.string(), fsrsState: z.enum(SkillFsrsState), repetitions: z.number(), lapses: z.number(), alreadyStudied: z.boolean().optional() }),
    exercise: exercise.extend({ id: z.string(), skillId: z.string() }),
  }),
});
export const customDraftSchema = z.object({
  ...fields,
  view: z.object({ status: z.literal("ready"),
    session: z.object({ id: z.string(), mode: z.enum(["PRACTICE_ONLY", "SCHEDULED"]), mixedReview: z.boolean(), status: z.enum(["ACTIVE", "STOPPED", "COMPLETED"]), targetCount: z.number(), completedCount: z.number() }),
    item: exercise.extend({ itemKey: z.string(), exerciseId: z.string(), skillId: z.string(), skillTitle: z.string(), choices: z.array(z.object({ id: z.string(), label: z.string() })) }),
  }),
});
type DraftAnswer = { answer: string; checked: boolean; rating: z.infer<typeof fields.rating>; responseMs: number | null };
export type NormalDraft = DraftAnswer & { attemptId: string; item: Extract<import("@/app/practice/types").PracticeItem, { status: "ready" }> };
export type CustomDraft = DraftAnswer & { view: Extract<import("@/app/practice/types").CustomPracticeClientView, { status: "ready" }> };
export type Recovery<T> = { current: T; pending?: T; deferred?: T };
export function recoveryKey(userId: string, kind: "normal" | "custom", scope: string) {
  return `learnrecur:review:v1:${userId}:${kind}:${scope}`;
}
export function readRecovery<T>(key: string, schema: z.ZodType<T>): Recovery<T> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 500_000) return null;
    const envelope = z.object({ version: z.literal(1), current: schema, pending: schema.optional(), deferred: schema.optional() }).safeParse(JSON.parse(raw));
    return envelope.success ? envelope.data : null;
  } catch { return null; }
}
export function writeRecovery<T>(key: string, recovery: Recovery<T> | null): boolean {
  try {
    if (recovery) sessionStorage.setItem(key, JSON.stringify({ version: 1, ...recovery }));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
