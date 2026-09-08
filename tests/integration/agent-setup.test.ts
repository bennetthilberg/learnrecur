import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/events", () => ({
  sendAgentSkillOperationRequested: vi.fn().mockResolvedValue(undefined),
}));

import { AgentSetupPlanStatus } from "@/generated/prisma/client";
import { sendAgentSkillOperationRequested } from "@/lib/jobs/events";
import {
  applyAgentSetup,
  previewAgentSetup,
} from "@/lib/agent-access/setup";
import type { AgentAccessScope, AgentAuthContext } from "@/lib/agent-access/auth";
import { createAgentSpecOperation } from "@/lib/agent-access/operations";
import { getPrisma } from "@/lib/prisma";
import { createSkillFixture } from "./test-helpers";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const runId = `agent_setup_${randomUUID()}`;
const allSetupScopes: AgentAccessScope[] = [
  "setup:read",
  "setup:write",
  "practice:write",
  "skills:create",
  "skills:read",
  "skills:write",
  "collections:read",
  "collections:write",
  "reminders:write",
  "materials:read",
];

describeDatabase("durable agent setup plans", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createFixture(
    label: string,
    scopes: AgentAccessScope[] = allSetupScopes,
  ) {
    const userId = `${runId}_${label}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, email: `${label}@example.test` } });
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `${runId}_${label}_workos`,
        externalId: `${runId}_${label}_external`,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: identity.externalId,
        workosSessionId: `${runId}_${label}_session`,
        workosApplicationId: `${runId}_${label}_application`,
        clientId: `https://${label}.example.test/client.json`,
        clientName: `${label} setup agent`,
        clientDomain: `${label}.example.test`,
        resourceUrl: "https://learnrecur.com/mcp",
        scopes,
      },
    });
    const auth: AgentAuthContext = {
      userId,
      connectionId: connection.id,
      subject: connection.workosSubject,
      sessionId: connection.workosSessionId,
      clientId: connection.clientId,
      clientName: connection.clientName,
      clientDomain: connection.clientDomain,
      resourceUrl: connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      permissionVersion: connection.permissionVersion,
      scopes,
    };
    return { userId, identity, connection, auth };
  }

  const practicePlan = (idempotencyKey: string) => ({
    idempotency_key: idempotencyKey,
    practice: { desired_retention: 0.92, practice_day_start_minutes: 90 },
  });

  const specsPlan = (idempotencyKey: string) => ({
    idempotency_key: idempotencyKey,
    skills: [
      {
        kind: "create_specs" as const,
        client_reference: "binary-search",
        skill: {
          title: "Binary search boundaries",
          objective: "Choose the correct binary-search boundary update.",
          rules: [],
          examples: [],
          exerciseConstraints: "",
          tags: ["algorithms"],
        },
      },
    ],
  });

  it("allows a scoped settings plan and persists its completed journal", async () => {
    const fixture = await createFixture("allowed");
    const preview = await previewAgentSetup(fixture.auth, practicePlan(`${runId}_allowed`));
    const planId = preview.plan_id as string;
    const applied = await applyAgentSetup(fixture.auth, { plan_id: planId });

    expect(applied).toMatchObject({ plan_id: planId, status: "SUCCEEDED" });
    const stored = await prisma.agentSetupPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(stored.status).toBe(AgentSetupPlanStatus.SUCCEEDED);
    expect(stored.result).toMatchObject({
      pending_count: 0,
      failed_count: 0,
      actions: [expect.objectContaining({ step_key: "practice", status: "saved" })],
    });
  });

  it("rejects a preview before mutation when a required scope is absent", async () => {
    const fixture = await createFixture("denied", ["setup:write"]);
    await expect(
      previewAgentSetup(fixture.auth, practicePlan(`${runId}_denied`)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      prisma.agentSetupPlan.count({ where: { userId: fixture.userId } }),
    ).resolves.toBe(0);
  });

  it("marks a preview stale after an unrelated settings edit", async () => {
    const fixture = await createFixture("stale");
    const preview = await previewAgentSetup(fixture.auth, practicePlan(`${runId}_stale`));
    const planId = preview.plan_id as string;
    await prisma.user.update({ where: { id: fixture.userId }, data: { desiredRetention: 0.81 } });

    const applied = await applyAgentSetup(fixture.auth, { plan_id: planId });
    expect(applied).toMatchObject({ plan_id: planId, status: "STALE" });
    await expect(
      prisma.agentSetupPlan.findUniqueOrThrow({ where: { id: planId } }),
    ).resolves.toMatchObject({ status: AgentSetupPlanStatus.STALE });
  });

  it("reconciles an existing deterministic child operation after an interrupted apply", async () => {
    const fixture = await createFixture("resume");
    const planInput = specsPlan(`${runId}_resume`);
    const preview = await previewAgentSetup(fixture.auth, planInput);
    const planId = preview.plan_id as string;
    const idempotencyKey = `setup-${planId}-0`;
    await createAgentSpecOperation(fixture.auth, {
      idempotency_key: idempotencyKey,
      items: [{
        client_reference: planInput.skills[0].client_reference,
        skill: planInput.skills[0].skill,
      }],
    });
    await prisma.agentSetupPlan.update({
      where: { id: planId },
      data: {
        status: AgentSetupPlanStatus.APPLYING,
        result: {
          version: 1,
          lease_token: "expired-worker",
          lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
          actions: [],
        },
      },
    });

    const resumed = await applyAgentSetup(fixture.auth, { plan_id: planId });
    expect(resumed).toMatchObject({ status: "PARTIAL" });
    await expect(
      prisma.agentSkillOperation.count({
        where: { connectionId: fixture.connection.id, idempotencyKey },
      }),
    ).resolves.toBe(1);
    expect(resumed.result).toMatchObject({
      actions: [expect.objectContaining({ operation_status: "QUEUED", status: "queued" })],
    });
  });

  it("preserves a settings edit made between child creation and the next step", async () => {
    const fixture = await createFixture("between-steps");
    vi.mocked(sendAgentSkillOperationRequested).mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: fixture.userId },
        data: { desiredRetention: 0.81 },
      });
    });
    const preview = await previewAgentSetup(fixture.auth, {
      idempotency_key: `${runId}_between_steps`,
      skills: [
        {
          kind: "create_specs" as const,
          client_reference: "between-steps-skill",
          skill: {
            title: "A skill created before the edit",
            objective: "Keep this child operation durable before settings change.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: [],
          },
        },
      ],
      practice: { desired_retention: 0.92 },
    });

    const applied = await applyAgentSetup(fixture.auth, { plan_id: preview.plan_id });
    expect(applied).toMatchObject({ plan_id: preview.plan_id, status: "PARTIAL" });
    expect(applied.result).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          step_key: "skill:between-steps-skill",
          status: "queued",
        }),
        expect.objectContaining({
          step_key: "practice",
          status: "failed",
          error: expect.objectContaining({ code: "stale_state" }),
        }),
      ]),
    });
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: fixture.userId },
        select: { desiredRetention: true },
      }),
    ).resolves.toEqual({ desiredRetention: 0.81 });
  });

  it("fences concurrent applies so both callers observe one durable result", async () => {
    const fixture = await createFixture("concurrent");
    const preview = await previewAgentSetup(fixture.auth, practicePlan(`${runId}_concurrent`));
    const planId = preview.plan_id as string;
    const results = await Promise.allSettled([
      applyAgentSetup(fixture.auth, { plan_id: planId }),
      applyAgentSetup(fixture.auth, { plan_id: planId }),
    ]);

    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ status: unknown }> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled.some((result) => result.value.status === "SUCCEEDED")).toBe(true);
    expect(fulfilled.length + rejected.length).toBe(2);
    if (rejected.length) {
      expect(rejected[0].reason).toMatchObject({ code: "setup_in_progress" });
    }
    await expect(
      prisma.agentSetupPlan.findUniqueOrThrow({ where: { id: planId } }),
    ).resolves.toMatchObject({ status: AgentSetupPlanStatus.SUCCEEDED });
  });

  it("resumes after completed library steps without overwriting a later user edit", async () => {
    const fixture = await createFixture("mixed-resume");
    const source = await prisma.collection.create({ data: { userId: fixture.userId, name: "Source" } });
    const destination = await prisma.collection.create({ data: { userId: fixture.userId, name: "Topic" } });
    const skill = await createSkillFixture(prisma, {
      userId: fixture.userId,
      title: "Original title",
      collectionId: source.id,
      tags: ["old"],
    });
    const input = {
      idempotency_key: `${runId}_mixed_resume`,
      collections: [{ kind: "reuse" as const, collection_id: source.id }],
      skills: [{ kind: "reuse" as const, skill_id: skill.id, collection_id: destination.id, tags: ["topic"] }],
      practice: { desired_retention: 0.93 },
      reminders: { local_hour: 17 },
    };
    const preview = await previewAgentSetup(fixture.auth, input);
    const planId = preview.plan_id as string;
    await prisma.skill.update({
      where: { id: skill.id },
      data: { collectionId: destination.id, tags: ["topic"] },
    });
    await prisma.skill.update({ where: { id: skill.id }, data: { title: "Learner edited title" } });
    await prisma.agentSetupPlan.update({
      where: { id: planId },
      data: {
        status: AgentSetupPlanStatus.APPLYING,
        result: {
          version: 1,
          lease_token: "expired-worker",
          lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
          actions: [
            { step_key: `collection:${source.id}`, kind: "collection", action: "reuse", collection_id: source.id, status: "ready" },
            { step_key: `skill:${skill.id}`, kind: "skill", action: "reuse", skill_id: skill.id, status: "updated", placement: { status: "updated" } },
          ],
        },
      },
    });

    const applied = await applyAgentSetup(fixture.auth, { plan_id: planId });
    expect(applied).toMatchObject({ status: "SUCCEEDED" });
    await expect(
      prisma.skill.findUniqueOrThrow({ where: { id: skill.id }, select: { title: true, collectionId: true, tags: true } }),
    ).resolves.toEqual({ title: "Learner edited title", collectionId: destination.id, tags: ["topic"] });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: fixture.userId }, select: { desiredRetention: true } }),
    ).resolves.toEqual({ desiredRetention: 0.93 });
    await expect(
      prisma.reminderPreference.findUniqueOrThrow({ where: { userId: fixture.userId }, select: { localHour: true } }),
    ).resolves.toEqual({ localHour: 17 });
  });

  it("marks an unfinished moved target stale instead of overwriting it", async () => {
    const fixture = await createFixture("unfinished-stale");
    const source = await prisma.collection.create({ data: { userId: fixture.userId, name: "Source" } });
    const planned = await prisma.collection.create({ data: { userId: fixture.userId, name: "Planned" } });
    const external = await prisma.collection.create({ data: { userId: fixture.userId, name: "External" } });
    const skill = await createSkillFixture(prisma, {
      userId: fixture.userId,
      title: "Move me carefully",
      collectionId: source.id,
    });
    const preview = await previewAgentSetup(fixture.auth, {
      idempotency_key: `${runId}_unfinished_stale`,
      skills: [{ kind: "reuse" as const, skill_id: skill.id, collection_id: planned.id }],
    });
    const planId = preview.plan_id as string;
    await prisma.skill.update({ where: { id: skill.id }, data: { collectionId: external.id } });
    await prisma.agentSetupPlan.update({
      where: { id: planId },
      data: {
        status: AgentSetupPlanStatus.APPLYING,
        result: {
          version: 1,
          lease_token: "expired-worker",
          lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
          actions: [],
        },
      },
    });

    const applied = await applyAgentSetup(fixture.auth, { plan_id: planId });
    expect(applied).toMatchObject({ status: "STALE" });
    await expect(
      prisma.skill.findUniqueOrThrow({ where: { id: skill.id }, select: { collectionId: true } }),
    ).resolves.toEqual({ collectionId: external.id });
  });
});
