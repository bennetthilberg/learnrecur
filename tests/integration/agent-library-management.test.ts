import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  AgentConnectionStatus,
  CollectionStatus,
  ExerciseType,
  ExerciseVerificationStatus,
  FsrsRating,
  GenerationFailureCategory,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
  SkillGenerationSpecStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  type AgentAccessScope,
  type AgentAuthContext,
} from "@/lib/agent-access/auth";
import {
  createAgentCustomSession,
  getAgentCustomSession,
  resumeAgentCustomSession,
  stopAgentCustomSession,
} from "@/lib/agent-access/custom-sessions";
import {
  batchUpdateAgentSkills,
  createAgentCollection,
  getAgentSkill,
  lifecycleAgentCollection,
  lifecycleAgentSkill,
  searchAgentSkills,
  updateAgentCollection,
  updateAgentSkill,
} from "@/lib/agent-access/library";
import {
  getAgentReminders,
  updateAgentReminders,
} from "@/lib/agent-access/reminders";
import { commitPracticeReview } from "@/lib/practice";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";
import {
  getDuePracticeSkillCount,
  getReminderSettings,
} from "@/lib/reminders";
import { getPrisma } from "@/lib/prisma";

import {
  createChoiceExercise,
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `agent_library_${randomUUID()}`;
type PublicSkill = {
  skill_id: string;
  title: string;
  objective: string | null;
  tags: string[];
  collection: Record<string, unknown> | null;
  guidance: Record<string, unknown>;
  readiness: Record<string, unknown>;
  sample_exercises?: Array<Record<string, unknown>>;
};

function equivalentOffset(timestamp: Date) {
  return timestamp.toISOString().replace("Z", "+00:00");
}

function previousInstant(timestamp: Date) {
  return new Date(timestamp.getTime() - 1_000).toISOString();
}

describeDatabase("agent library and reminder management", () => {
  const prisma = getPrisma();
  const ownedUserIds: string[] = [];
  const defaultLibraryScopes = [
    "skills:read",
    "skills:write",
    "collections:write",
    "reminders:read",
    "reminders:write",
  ] as AgentAccessScope[];

  function makeUserId(label: string) {
    const userId = `${runId}_${label}_${randomUUID().slice(0, 8)}`;
    ownedUserIds.push(userId);
    return userId;
  }

  async function createUser(label: string, email = `${label}@example.test`) {
    const userId = makeUserId(label);
    await prisma.user.create({ data: { id: userId, email } });
    return userId;
  }

  async function createConnection(
    label: string,
    scopes: readonly AgentAccessScope[] = defaultLibraryScopes,
    email = `${label}@example.test`,
  ): Promise<AgentAuthContext> {
    const userId = await createUser(label, email);
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `workos_${userId}`,
        externalId: userId,
      },
    });
    const record = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: userId,
        workosSessionId: `session_${userId}`,
        workosApplicationId: `app_${userId}`,
        clientId: "https://agent.example/client.json",
        clientName: "Library test agent",
        clientDomain: "agent.example",
        resourceUrl: "https://learnrecur.com/mcp",
        scopes: [...scopes],
      },
    });
    return {
      userId,
      connectionId: record.id,
      subject: userId,
      sessionId: record.workosSessionId,
      clientId: record.clientId,
      clientName: record.clientName,
      clientDomain: record.clientDomain,
      resourceUrl: record.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      scopes: [...scopes],
    };
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ownedUserIds } } });
    await prisma.$disconnect();
  });

  it("reads an owned library with safe samples and enforces read, write, and revocation boundaries", async () => {
    const auth = await createConnection("library-read");
    const collection = await prisma.collection.create({
      data: {
        userId: auth.userId,
        name: "Spanish verbs",
        textPolicy: NATURAL_TEXT_POLICY,
      },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Spanish present tense",
      objective: "Conjugate common Spanish verbs in the present tense.",
      collectionId: collection.id,
      repetitions: 3,
      tags: ["spanish", "verbs"],
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: {
        rules: ["Match the subject before choosing the ending."],
        examples: ["yo hablo"],
        exerciseConstraints: "Use short, everyday examples.",
      },
    });
    await createChoiceExercise({
      prisma,
      userId: auth.userId,
      skillId: skill.id,
    });
    await createTextExercise(prisma, auth.userId, skill.id, {
      answerSpec: textAnswerContract(["hablo"], NATURAL_TEXT_POLICY),
    });

    const foreignUserId = await createUser("library-foreign");
    const foreignSkill = await createSkillFixture(prisma, {
      userId: foreignUserId,
      title: "Spanish present tense",
      objective: "A private objective that should never cross accounts.",
    });

    const search = await searchAgentSkills(auth, {
      query: "present tense",
      tags: ["spanish"],
      include_samples: true,
    });
    const searchSkills = search.skills as unknown as PublicSkill[];
    expect(searchSkills).toHaveLength(1);
    expect(searchSkills[0]).toMatchObject({
      skill_id: skill.id,
      title: "Spanish present tense",
      objective: "Conjugate common Spanish verbs in the present tense.",
      tags: ["spanish", "verbs"],
      collection: {
        collection_id: collection.id,
        name: "Spanish verbs",
        status: CollectionStatus.ACTIVE,
      },
      guidance: {
        rules: ["Match the subject before choosing the ending."],
        examples: ["yo hablo"],
        exercise_constraints: "Use short, everyday examples.",
      },
    });
    expect(searchSkills[0]).not.toMatchObject({ skill_id: foreignSkill.id });
    const searchSample = searchSkills[0].sample_exercises?.[0];
    expect(searchSample).toBeDefined();
    expect(searchSample).toHaveProperty("prompt");
    expect(searchSample).not.toHaveProperty("answerSpec");
    expect(searchSample).not.toHaveProperty("correctAnswerDisplay");
    expect(searchSample).not.toHaveProperty("explanation");

    const read = await getAgentSkill(auth, { skill_id: skill.id, sample_limit: 2 });
    const readSkill = read.skill as unknown as PublicSkill;
    expect(readSkill).toMatchObject({
      skill_id: skill.id,
      collection: { collection_id: collection.id, name: "Spanish verbs" },
      readiness: { status: "ready", ready_exercise_count: 2 },
      guidance: { rules: ["Match the subject before choosing the ending."] },
    });
    expect(readSkill.sample_exercises).toHaveLength(2);
    for (const sample of readSkill.sample_exercises ?? []) {
      expect(sample).not.toHaveProperty("answerSpec");
      expect(sample).not.toHaveProperty("correctAnswerDisplay");
    }

    const readOnlyAuth = {
      ...auth,
      scopes: ["skills:read"] as AgentAccessScope[],
    };
    await expect(
      updateAgentSkill(readOnlyAuth, {
        skill_id: skill.id,
        changes: { title: "Should be denied" },
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await prisma.agentConnection.update({
      where: { id: auth.connectionId },
      data: { status: AgentConnectionStatus.REVOKED },
    });
    await expect(getAgentSkill(auth, { skill_id: skill.id })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("keeps search readiness independent of samples and excludes incompatible text inventory", async () => {
    const auth = await createConnection("library-search-readiness", ["skills:read"]);
    const collection = await prisma.collection.create({
      data: {
        userId: auth.userId,
        name: "Natural search policy",
        textPolicy: NATURAL_TEXT_POLICY,
      },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Search readiness fixture",
      collectionId: collection.id,
      repetitions: 3,
    });
    // The incompatible row is older than the ready rows. Samples must keep
    // scanning after it instead of letting it consume one of the three slots.
    await createTextExercise(prisma, auth.userId, skill.id, {
      answerSpec: textAnswerContract(["right"], EXACT_TEXT_POLICY),
    });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        createChoiceExercise({ prisma, userId: auth.userId, skillId: skill.id }),
      ),
    );

    const withoutSamples = await searchAgentSkills(auth, { query: "readiness" });
    const withoutSamplesSkill = (withoutSamples.skills as unknown as PublicSkill[])[0];
    expect(withoutSamplesSkill).toMatchObject({
      skill_id: skill.id,
      readiness: { status: "ready", ready_exercise_count: 4 },
    });
    expect(withoutSamplesSkill.sample_exercises).toBeUndefined();

    const withSamples = await searchAgentSkills(auth, {
      query: "readiness",
      include_samples: true,
    });
    const withSamplesSkill = (withSamples.skills as unknown as PublicSkill[])[0];
    expect(withSamplesSkill).toMatchObject({
      skill_id: skill.id,
      readiness: { status: "ready", ready_exercise_count: 4 },
    });
    expect(withSamplesSkill.sample_exercises).toHaveLength(3);
    expect(withSamplesSkill.sample_exercises?.every((sample) => sample.type === ExerciseType.MULTIPLE_CHOICE)).toBe(true);
  });

  it("matches search and get readiness for already-studied text and rejects malformed numeric or math specs", async () => {
    const auth = await createConnection("library-readiness-parity", ["skills:read"]);
    const collection = await prisma.collection.create({
      data: {
        userId: auth.userId,
        name: "Parity text policy",
        textPolicy: NATURAL_TEXT_POLICY,
      },
    });
    const alreadyStudied = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Already studied text",
      collectionId: collection.id,
      repetitions: 0,
    });
    await prisma.skill.update({
      where: { id: alreadyStudied.id },
      data: { alreadyStudied: true },
    });
    await createTextExercise(prisma, auth.userId, alreadyStudied.id, {
      answerSpec: textAnswerContract(["ready"], NATURAL_TEXT_POLICY),
    });

    const search = await searchAgentSkills(auth, {
      query: "Already studied text",
    });
    const searchSkill = (search.skills as unknown as PublicSkill[])[0];
    expect(searchSkill).toMatchObject({
      skill_id: alreadyStudied.id,
      readiness: { status: "ready", ready_exercise_count: 1 },
    });
    const read = await getAgentSkill(auth, {
      skill_id: alreadyStudied.id,
      sample_limit: 1,
    });
    const readSkill = read.skill as unknown as PublicSkill;
    expect(readSkill).toMatchObject({
      readiness: { status: "ready", ready_exercise_count: 1, verified_exercise_count: 1 },
    });
    expect(readSkill.sample_exercises).toHaveLength(1);

    const malformed = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Malformed inventory",
      repetitions: 3,
    });
    await prisma.exercise.createMany({
      data: [
        {
          userId: auth.userId,
          skillId: malformed.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.NUMERIC,
          prompt: "Malformed numeric answer",
          answerSpec: { kind: "numeric", accepted: [{ type: "unknown", value: 1 }] },
          correctAnswerDisplay: "1",
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
        },
        {
          userId: auth.userId,
          skillId: malformed.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.MATH,
          prompt: "Malformed math answer",
          answerSpec: { kind: "math", acceptedExpressions: [123] },
          correctAnswerDisplay: "1",
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
        },
        {
          userId: auth.userId,
          skillId: malformed.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.NUMERIC,
          prompt: "Oversized numeric answer",
          answerSpec: { kind: "numeric", accepted: [1e64] },
          correctAnswerDisplay: "1",
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
        },
        {
          userId: auth.userId,
          skillId: malformed.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.NUMERIC,
          prompt: "Non-integer fraction answer",
          answerSpec: {
            kind: "numeric",
            accepted: [{ type: "fraction", numerator: 1.5, denominator: 2 }],
          },
          correctAnswerDisplay: "0.75",
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
        },
      ],
    });

    const malformedSearch = await searchAgentSkills(auth, { query: "Malformed inventory" });
    expect((malformedSearch.skills as unknown as PublicSkill[])[0]).toMatchObject({
      skill_id: malformed.id,
      readiness: { status: "needs_preparation", ready_exercise_count: 0 },
    });
    const malformedRead = await getAgentSkill(auth, {
      skill_id: malformed.id,
      sample_limit: 2,
    });
    const malformedReadSkill = malformedRead.skill as unknown as PublicSkill;
    expect(malformedReadSkill).toMatchObject({
      readiness: { status: "needs_preparation", ready_exercise_count: 0, verified_exercise_count: 4 },
    });
    expect(malformedReadSkill.sample_exercises).toHaveLength(0);
  });

  it("updates active guidance without resetting mastery and rejects active objective changes", async () => {
    const auth = await createConnection("library-guidance", ["skills:read", "skills:write"]);
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Active guidance fixture",
      objective: "Identify the correct Spanish article for a noun.",
      repetitions: 4,
    });
    await createChoiceExercise({ prisma, userId: auth.userId, skillId: skill.id });
    await prisma.skill.update({
      where: { id: skill.id },
      data: {
        rules: ["Old rule"],
        examples: ["Old example"],
        exerciseConstraints: "Old constraint",
        generationSpecStatus: SkillGenerationSpecStatus.ACCEPTED,
      },
    });
    const before = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    const guidance = await updateAgentSkill(auth, {
      skill_id: skill.id,
      changes: {
        rules: ["Check noun gender before selecting the article."],
        examples: ["la mesa"],
        exercise_constraints: "Keep prompts at beginner level.",
      },
    });
    expect(guidance).toMatchObject({
      status: "updated",
      skill: { skill_id: skill.id, guidance_updated: true, mastery_reset: false },
    });

    const updated = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(updated).toMatchObject({
      rules: { items: ["Check noun gender before selecting the article."] },
      examples: { items: ["la mesa"] },
      exerciseConstraints: {
        answerKind: "choice",
        notes: "Keep prompts at beginner level.",
        requestedCount: 5,
      },
      generationSpecStatus: SkillGenerationSpecStatus.SUPERSEDED,
      dueAt: before.dueAt,
      stability: before.stability,
      difficulty: before.difficulty,
      repetitions: before.repetitions,
      lapses: before.lapses,
    });
    const readBack = await getAgentSkill(auth, { skill_id: skill.id });
    expect(readBack.skill).toMatchObject({
      guidance: {
        rules: ["Check noun gender before selecting the article."],
        examples: ["la mesa"],
        exercise_constraints: "Keep prompts at beginner level.",
      },
    });

    await expect(
      updateAgentSkill(auth, {
        skill_id: skill.id,
        changes: { objective: "Change the meaning of this mastered skill." },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const afterRejectedObjective = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(afterRejectedObjective.objective).toBe(before.objective);
    expect(afterRejectedObjective.repetitions).toBe(before.repetitions);
    expect(afterRejectedObjective.dueAt).toEqual(before.dueAt);
  });

  it("owns collection and skill lifecycle transitions and preserves foreign-target boundaries", async () => {
    const auth = await createConnection("library-lifecycle", ["skills:read", "skills:write", "collections:write"]);
    const created = await createAgentCollection(auth, {
      name: "Lifecycle collection",
      description: "Initial description",
    });
    expect(created).toMatchObject({ status: "created", collection: { status: CollectionStatus.ACTIVE } });
    if (created.status !== "created") throw new Error("Expected collection creation to succeed.");
    const collectionId = created.collection.collection_id;

    expect(
      await updateAgentCollection(auth, {
        collection_id: collectionId,
        changes: { description: "Updated description" },
      }),
    ).toMatchObject({ status: "updated", collection: { description: "Updated description" } });
    expect(
      await lifecycleAgentCollection(auth, { collection_id: collectionId, action: "archive" }),
    ).toMatchObject({ status: "updated", collection: { status: CollectionStatus.ARCHIVED } });
    expect(
      await lifecycleAgentCollection(auth, { collection_id: collectionId, action: "restore" }),
    ).toMatchObject({ status: "updated", collection: { status: CollectionStatus.ACTIVE } });

    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Lifecycle skill",
      collectionId,
      repetitions: 3,
    });
    await createChoiceExercise({ prisma, userId: auth.userId, skillId: skill.id });
    expect(await lifecycleAgentSkill(auth, { skill_id: skill.id, action: "pause" })).toMatchObject({
      status: "updated",
      action: "pause",
      skill: { status: SkillStatus.PAUSED },
    });
    expect(await lifecycleAgentSkill(auth, { skill_id: skill.id, action: "resume" })).toMatchObject({
      status: "updated",
      action: "resume",
      skill: { status: SkillStatus.ACTIVE },
    });
    expect(await lifecycleAgentSkill(auth, { skill_id: skill.id, action: "archive" })).toMatchObject({
      status: "updated",
      action: "archive",
      skill: { status: SkillStatus.ARCHIVED },
    });
    expect(await lifecycleAgentSkill(auth, { skill_id: skill.id, action: "restore" })).toMatchObject({
      status: "updated",
      action: "restore",
      skill: { status: SkillStatus.ACTIVE },
    });

    const foreignUserId = await createUser("lifecycle-foreign");
    const foreignCollection = await prisma.collection.create({
      data: { userId: foreignUserId, name: "Private lifecycle collection" },
    });
    const foreignSkill = await createSkillFixture(prisma, {
      userId: foreignUserId,
      title: "Private lifecycle skill",
    });
    const skillsOnlyAuth = { ...auth, scopes: ["skills:write"] as AgentAccessScope[] };
    await expect(
      updateAgentCollection(skillsOnlyAuth, {
        collection_id: collectionId,
        changes: { description: "Denied" },
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      lifecycleAgentSkill(auth, { skill_id: foreignSkill.id, action: "archive" }),
    ).rejects.toMatchObject({ code: "skill_not_found" });
    await expect(
      lifecycleAgentCollection(auth, { collection_id: foreignCollection.id, action: "archive" }),
    ).rejects.toMatchObject({ code: "collection_not_found" });
  });

  it("compares collection, skill, and batch timestamps by instant", async () => {
    const auth = await createConnection("library-timestamp-offsets");
    const collection = await prisma.collection.create({
      data: { userId: auth.userId, name: "Timestamp collection" },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Timestamp skill",
      collectionId: collection.id,
    });

    await expect(
      updateAgentCollection(auth, {
        collection_id: collection.id,
        expected_updated_at: equivalentOffset(collection.updatedAt),
        changes: { description: "Offset spelling accepted" },
      }),
    ).resolves.toMatchObject({ status: "updated" });
    const changedCollection = await prisma.collection.findUniqueOrThrow({
      where: { id: collection.id },
    });
    await expect(
      updateAgentCollection(auth, {
        collection_id: collection.id,
        expected_updated_at: previousInstant(changedCollection.updatedAt),
        changes: { description: "Old collection timestamp rejected" },
      }),
    ).rejects.toMatchObject({ code: "stale_state" });

    const currentSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    await expect(
      updateAgentSkill(auth, {
        skill_id: skill.id,
        expected_updated_at: equivalentOffset(currentSkill.updatedAt),
        changes: { title: "Timestamp skill renamed" },
      }),
    ).resolves.toMatchObject({ status: "updated" });
    const changedSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    await expect(
      updateAgentSkill(auth, {
        skill_id: skill.id,
        expected_updated_at: previousInstant(changedSkill.updatedAt),
        changes: { title: "Old skill timestamp rejected" },
      }),
    ).rejects.toMatchObject({ code: "stale_state" });

    const batchCurrent = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    await expect(
      batchUpdateAgentSkills(auth, {
        skill_ids: [skill.id],
        expected_updated_at: equivalentOffset(batchCurrent.updatedAt),
        set_tags: ["timestamp"],
      }),
    ).resolves.toMatchObject({
      status: "updated",
      results: [{ skill_id: skill.id, status: "updated" }],
    });
    const changedBatchSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    await expect(
      batchUpdateAgentSkills(auth, {
        skill_ids: [skill.id],
        expected_updated_at: previousInstant(changedBatchSkill.updatedAt),
        set_tags: ["old-timestamp-rejected"],
      }),
    ).resolves.toMatchObject({
      status: "partial",
      results: [{ skill_id: skill.id, status: "stale" }],
    });

    const secondSkill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Second timestamp skill",
    });
    const secondCurrent = await prisma.skill.findUniqueOrThrow({ where: { id: secondSkill.id } });
    await expect(
      batchUpdateAgentSkills(auth, {
        skill_ids: [skill.id, secondSkill.id],
        expected_updated_at: changedBatchSkill.updatedAt.toISOString(),
        set_tags: ["legacy-global-rejected"],
      }),
    ).rejects.toThrow(/expected_updated_at_by_skill/i);
    await expect(
      batchUpdateAgentSkills(auth, {
        skill_ids: [skill.id, secondSkill.id],
        expected_updated_at_by_skill: {
          [skill.id]: changedBatchSkill.updatedAt.toISOString(),
          [secondSkill.id]: equivalentOffset(secondCurrent.updatedAt),
        },
        set_tags: ["per-skill-timestamp"],
      }),
    ).resolves.toMatchObject({
      status: "updated",
      results: [
        { skill_id: skill.id, status: "updated" },
        { skill_id: secondSkill.id, status: "updated" },
      ],
    });
  });

  it("reports a partial batch when an archived skill fails beside an updated skill", async () => {
    const auth = await createConnection("library-batch-partial", ["skills:read", "skills:write"]);
    const destination = await prisma.collection.create({
      data: { userId: auth.userId, name: "Batch destination" },
    });
    const archived = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Archived batch skill",
    });
    const active = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Active batch skill",
    });
    await lifecycleAgentSkill(auth, { skill_id: archived.id, action: "archive" });

    const result = await batchUpdateAgentSkills(auth, {
      skill_ids: [archived.id, active.id],
      collection_id: destination.id,
    });

    expect(result.status).toBe("partial");
    expect(result.results).toEqual([
      expect.objectContaining({ skill_id: archived.id, status: "failed" }),
      expect.objectContaining({ skill_id: active.id, status: "updated" }),
    ]);
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({
      status: SkillStatus.ARCHIVED,
      collectionId: null,
    });
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      collectionId: destination.id,
    });
  });

  it("fails only the batch item whose merged tags exceed the native limit", async () => {
    const auth = await createConnection("library-batch-tags", ["skills:read", "skills:write"]);
    const tooMany = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Too many batch tags",
      tags: Array.from({ length: 12 }, (_, index) => `tag-${index}`),
    });
    const withinLimit = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Within batch tag limit",
    });

    const result = await batchUpdateAgentSkills(auth, {
      skill_ids: [tooMany.id, withinLimit.id],
      add_tags: ["overflow"],
    });

    expect(result).toMatchObject({
      status: "partial",
      results: [
        { skill_id: tooMany.id, status: "failed", message: expect.stringMatching(/12 tags/i) },
        { skill_id: withinLimit.id, status: "updated", tags: ["overflow"] },
      ],
    });
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: tooMany.id } })).tags).toHaveLength(12);
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: withinLimit.id } })).tags).toEqual(["overflow"]);
  });

  it("allows metadata-only edits with malformed policy and rejects an explicit move", async () => {
    const auth = await createConnection("library-malformed-policy", ["skills:read", "skills:write"]);
    const source = await prisma.collection.create({
      data: { userId: auth.userId, name: "Malformed source", textPolicy: NATURAL_TEXT_POLICY },
    });
    const destination = await prisma.collection.create({
      data: { userId: auth.userId, name: "Malformed destination", textPolicy: EXACT_TEXT_POLICY },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Malformed metadata policy",
      collectionId: source.id,
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { textPolicy: { invalid: true } },
    });

    await expect(
      updateAgentSkill(auth, {
        skill_id: skill.id,
        changes: { title: "Metadata remains editable" },
      }),
    ).resolves.toMatchObject({
      status: "updated",
      skill: { title: "Metadata remains editable", collection_id: source.id },
    });
    await expect(
      updateAgentSkill(auth, {
        skill_id: skill.id,
        changes: { collection_id: destination.id },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/policy/i) });
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({
      collectionId: source.id,
      title: "Metadata remains editable",
    });
  });

  it("uses the transactional MCP custom-session wrapper without spending preview allowance", async () => {
    const auth = await createConnection("custom-wrapper", ["practice:read", "practice:write"]);
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "MCP custom session skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
      repetitions: 1,
    });
    const exercise = await createChoiceExercise({
      prisma,
      userId: auth.userId,
      skillId: skill.id,
    });
    const before = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    const input = {
      mode: "PRACTICE_ONLY",
      target_count: 1,
      scope: {
        collection_ids: [],
        tags: [],
        skill_ids: [skill.id],
        recently_missed: false,
        mixed_review: false,
      },
    };
    await expect(
      createAgentCustomSession({ ...auth, scopes: ["practice:read"] as AgentAccessScope[] }, input),
    ).rejects.toMatchObject({ code: "permission_denied" });

    const created = await createAgentCustomSession(auth, input);
    expect(created).toMatchObject({
      status: "ready",
      session: {
        mode: "PRACTICE_ONLY",
        status: "ACTIVE",
        target_count: 1,
        completed_count: 0,
        next_index: 0,
        scope: {
          collectionIds: [],
          tags: [],
          skillIds: [skill.id],
          recentlyMissed: false,
          mixedReview: false,
        },
        items: [
          {
            ordinal: 0,
            skill_id: skill.id,
            exercise_id: exercise.id,
            status: "PENDING",
          },
        ],
      },
    });
    const sessionId = created.session.session_id;

    expect(await prisma.exerciseAttempt.count({ where: { skillId: skill.id } })).toBe(0);
    expect(await prisma.reviewLog.count({ where: { skillId: skill.id } })).toBe(0);
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({
      firstIntroducedAt: before.firstIntroducedAt,
      dueAt: before.dueAt,
      repetitions: before.repetitions,
      stability: before.stability,
      difficulty: before.difficulty,
    });

    expect(await getAgentCustomSession(auth, { session_id: sessionId })).toMatchObject({
      status: "ready",
      session: { session_id: sessionId, status: "ACTIVE", items: [{ status: "PENDING" }] },
    });
    expect(await stopAgentCustomSession(auth, { session_id: sessionId })).toMatchObject({
      status: "stopped",
      session: { session_id: sessionId, status: "STOPPED" },
    });
    expect(await resumeAgentCustomSession(auth, { session_id: sessionId })).toMatchObject({
      status: "active",
      session: { session_id: sessionId, status: "ACTIVE" },
    });
    expect(await prisma.exerciseAttempt.count({ where: { skillId: skill.id } })).toBe(0);
    expect(await prisma.reviewLog.count({ where: { skillId: skill.id } })).toBe(0);
  });

  it("moves skills across text policies while retiring only future text inventory", async () => {
    const auth = await createConnection("library-batch", ["skills:read", "skills:write"]);
    const source = await prisma.collection.create({
      data: { userId: auth.userId, name: "Natural text", textPolicy: NATURAL_TEXT_POLICY },
    });
    const destination = await prisma.collection.create({
      data: { userId: auth.userId, name: "Exact text", textPolicy: EXACT_TEXT_POLICY },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Batch policy move",
      objective: "Practice a skill whose text comparison policy can change safely.",
      collectionId: source.id,
      repetitions: 3,
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: {
        generationSpec: { version: 1, policy: NATURAL_TEXT_POLICY },
        generationSpecFingerprint: "natural-fixture",
        generationSpecStatus: SkillGenerationSpecStatus.ACCEPTED,
      },
    });
    const choice = await createChoiceExercise({ prisma, userId: auth.userId, skillId: skill.id });
    const text = await createTextExercise(prisma, auth.userId, skill.id, {
      answerSpec: textAnswerContract(["sí"], NATURAL_TEXT_POLICY),
    });
    const reviewedAt = new Date("2026-06-05T12:00:00.000Z");
    await expect(
      commitPracticeReview({
        userId: auth.userId,
        exerciseId: choice.id,
        submittedAnswer: "right",
        attemptId: randomUUID(),
        reviewedAt,
        now: reviewedAt,
        manualRating: FsrsRating.GOOD,
      }),
    ).resolves.toMatchObject({ status: "committed" });
    await prisma.generationJob.create({
      data: {
        userId: auth.userId,
        skillId: skill.id,
        kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.GENERATING,
        provider: "test",
        model: "fixture",
        promptVersion: "test-v1",
        requestedCount: 3,
      },
    });

    const before = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    const beforeAttempts = await prisma.exerciseAttempt.count({ where: { skillId: skill.id } });
    const beforeReviews = await prisma.reviewLog.count({ where: { skillId: skill.id } });
    const result = await batchUpdateAgentSkills(auth, {
      skill_ids: [skill.id],
      collection_id: destination.id,
    });
    expect(result).toMatchObject({ status: "updated", results: [{ skill_id: skill.id, status: "updated" }] });

    const [after, retiredText, choiceAfter, job] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
      prisma.exercise.findUniqueOrThrow({ where: { id: text.id } }),
      prisma.exercise.findUniqueOrThrow({ where: { id: choice.id } }),
      prisma.generationJob.findFirstOrThrow({ where: { skillId: skill.id } }),
    ]);
    expect(after).toMatchObject({
      collectionId: destination.id,
      textPolicyRevision: before.textPolicyRevision + 1,
      generationSpec: null,
      generationSpecFingerprint: null,
      generationSpecStatus: SkillGenerationSpecStatus.SUPERSEDED,
      dueAt: before.dueAt,
      stability: before.stability,
      difficulty: before.difficulty,
      repetitions: before.repetitions,
      lapses: before.lapses,
      lastReviewedAt: before.lastReviewedAt,
    });
    expect(retiredText).toMatchObject({ retiredAt: expect.any(Date), retirementReason: "REPLACED" });
    expect(choiceAfter.retiredAt).toBeNull();
    expect(job).toMatchObject({
      status: GenerationJobStatus.FAILED,
      stage: GenerationJobStage.FAILED,
      failureCategory: GenerationFailureCategory.CANCELED,
      errorMessage: "Text policy changed. Prepare using the current comparison policy.",
    });
    expect(await prisma.exerciseAttempt.count({ where: { skillId: skill.id } })).toBe(beforeAttempts);
    expect(await prisma.reviewLog.count({ where: { skillId: skill.id } })).toBe(beforeReviews);
  });

  it("keeps agent reminders in parity with native settings and enforces both reminder scopes", async () => {
    const auth = await createConnection(
      "reminder-agent",
      ["reminders:read", "reminders:write"],
      "reminder-owner@example.test",
    );
    const dueSkill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Reminder due skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
      repetitions: 3,
    });
    await createChoiceExercise({ prisma, userId: auth.userId, skillId: dueSkill.id });

    const nativeDefaults = await getReminderSettings({ userId: auth.userId });
    expect(nativeDefaults).toMatchObject({
      status: "ready",
      persisted: false,
      preference: {
        enabled: false,
        email: "reminder-owner@example.test",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    const agentDefaults = await getAgentReminders(auth, {});
    expect(agentDefaults).toMatchObject({
      status: "ready",
      persisted: false,
      preference: {
        enabled: false,
        email: "reminder-owner@example.test",
        local_hour: 9,
        timezone: "America/New_York",
        minimum_due_count: 1,
      },
      due_skill_count: await getDuePracticeSkillCount({ userId: auth.userId, now: new Date() }),
    });

    const saved = await updateAgentReminders(auth, {
      changes: {
        enabled: true,
        email: "different-recipient@example.test",
        local_hour: 8,
        timezone: "America/Chicago",
        minimum_due_count: 3,
      },
    });
    expect(saved).toMatchObject({
      status: "saved",
      preference: {
        enabled: true,
        email: "reminder-owner@example.test",
        local_hour: 8,
        timezone: "America/Chicago",
        minimum_due_count: 3,
      },
    });
    const nativeSaved = await getReminderSettings({ userId: auth.userId });
    expect(nativeSaved).toMatchObject({
      status: "ready",
      persisted: true,
      preference: {
        enabled: true,
        email: "reminder-owner@example.test",
        localHour: 8,
        timezone: "America/Chicago",
        minimumDueCount: 3,
      },
    });

    await expect(
      updateAgentReminders({ ...auth, scopes: ["reminders:read"] as AgentAccessScope[] }, {
        changes: { local_hour: 10 },
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      getAgentReminders({ ...auth, scopes: ["reminders:write"] as AgentAccessScope[] }, {}),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await prisma.agentConnection.update({
      where: { id: auth.connectionId },
      data: { status: AgentConnectionStatus.REVOKED },
    });
    await expect(getAgentReminders(auth, {})).rejects.toMatchObject({ code: "permission_denied" });
  });
});
