import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/agent-access/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-access/auth")>()),
  verifyAgentBearerToken: vi.fn(),
}));
vi.mock("@/lib/skills/retention-preparation", () => ({
  queueRetentionPreparation: vi.fn().mockResolvedValue([]),
}));

import { Prisma } from "@/generated/prisma/client";
import {
  verifyAgentBearerToken,
  type AgentAuthContext,
} from "@/lib/agent-access/auth";
import {
  getAgentPracticeSettings,
  updateAgentPracticeSettings,
} from "@/lib/agent-access/practice";
import { POST } from "@/app/mcp/route";
import { getPrisma } from "@/lib/prisma";
import { commitPracticeReview } from "@/lib/practice";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";
import { queueRetentionPreparation } from "@/lib/skills/retention-preparation";
import {
  createSkillFixture,
  createTextExercise,
  createChoiceExercise,
} from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("MCP practice settings HTTP and persistence", () => {
  const prisma = getPrisma();
  const users: string[] = [];
  const originalEnv = { ...process.env };
  let auth: AgentAuthContext;

  async function connection() {
    const userId = `agent_practice_${randomUUID()}`;
    users.push(userId);
    await prisma.user.create({ data: { id: userId } });
    const identity = await prisma.workosIdentity.create({
      data: { userId, workosUserId: `workos_${userId}`, externalId: userId },
    });
    const record = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: userId,
        workosSessionId: `session_${userId}`,
        workosApplicationId: `app_${userId}`,
        clientId: "https://agent.example/client.json",
        clientName: "Test agent",
        clientDomain: "agent.example",
        resourceUrl: "https://learnrecur.com/mcp",
        scopes: ["practice:read", "practice:write"],
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
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scopes: ["practice:read", "practice:write"],
    } satisfies AgentAuthContext;
  }

  beforeAll(() =>
    Object.assign(process.env, {
      AGENT_SKILL_CREATION_ENABLED: "1",
      MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
      MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
      MCP_ALLOWED_CLIENT_IDS: "https://agent.example/client.json",
      WORKOS_AUTHKIT_ISSUER: "https://test.authkit.app",
      WORKOS_API_KEY: "sk_test_example",
      AGENT_OAUTH_COOKIE_SECRET: "a-secure-cookie-secret-at-least-32-bytes",
    }),
  );
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    auth = await connection();
    vi.mocked(verifyAgentBearerToken).mockImplementation(async () => ({
      token: "test",
      clientId: auth.clientId,
      scopes: auth.scopes,
      expiresAt: auth.expiresAt,
      resource: new URL(auth.resourceUrl),
      extra: {
        userId: auth.userId,
        connectionId: auth.connectionId,
        workosSubject: auth.subject,
        workosSessionId: auth.sessionId,
        clientName: auth.clientName,
        clientDomain: auth.clientDomain,
      },
    }));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    await prisma.accountDeletionJob.deleteMany({
      where: { userId: { in: users } },
    });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
    revision = "2026-07-28",
  ) {
    const response = await POST(
      new Request("https://learnrecur.com/mcp", {
        method: "POST",
        headers: {
          host: "learnrecur.com",
          authorization: "Bearer test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": revision,
          "Mcp-Method": method,
          ...(typeof params.name === "string"
            ? { "Mcp-Name": params.name }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params: {
            ...params,
            _meta:
              revision === "2026-07-28"
                ? {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": {
                      name: "retention-test",
                      version: "1.0.0",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  }
                : {},
          },
        }),
      }),
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const message = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? JSON.parse(
          body
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        )
      : JSON.parse(body);
    return message;
  }
  async function call(name: string, args: Record<string, unknown>) {
    const message = await rpc("tools/call", { name, arguments: args });
    expect(message.error).toBeUndefined();
    return message.result;
  }
  const target = (scope: "skill" | "collection", id: string) => ({ scope, id });

  it("publishes discoverable settings tools with separate read and write consent", async () => {
    const response = await rpc("tools/list");
    const tools = response.result.tools.filter((tool: { name: string }) =>
      tool.name.startsWith("practice."),
    );
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "practice.list_targets",
      "practice.get_settings",
      "practice.update_settings",
    ]);
    expect(tools[0]._meta.securitySchemes[0].scopes).toEqual(["practice:read"]);
    expect(tools[1].annotations.readOnlyHint).toBe(true);
    expect(tools[2]._meta.securitySchemes[0].scopes).toEqual([
      "practice:write",
    ]);
    expect(tools[2].annotations.readOnlyHint).toBe(false);
  });

  it("supports existing MCP clients using the 2025-11-25 protocol", async () => {
    const response = await rpc(
      "tools/call",
      {
        name: "practice.update_settings",
        arguments: {
          target: { scope: "user" },
          changes: { mixedReview: true },
        },
      },
      "2025-11-25",
    );
    expect(response.error).toBeUndefined();
    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.settings.mixedReview).toBe(true);
  });

  it("edits every setting via HTTP and returns explicit and inherited values", async () => {
    const collection = await prisma.collection.create({
      data: { userId: auth.userId, name: "Spanish" },
    });
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Accents",
      collectionId: collection.id,
    });
    const update = (scope: object, changes: object) =>
      call("practice.update_settings", { target: scope, changes });
    expect(
      (
        await update(
          { scope: "user" },
          { practicePreference: "RECALL_FIRST", mixedReview: true },
        )
      ).structuredContent.settings,
    ).toEqual({ practicePreference: "RECALL_FIRST", mixedReview: true, dailyNewSkillLimit: null, practiceTimezone: "UTC" });
    expect(
      (
        await call("practice.get_settings", {
          target: target("skill", skill.id),
        })
      ).structuredContent.effective,
    ).toMatchObject({
      practicePreference: "RECALL_FIRST",
      mixedReview: true,
      textPolicy: NATURAL_TEXT_POLICY,
    });
    await update(target("collection", collection.id), {
      practicePreference: "BALANCED",
      textPolicy: EXACT_TEXT_POLICY,
    });
    const custom = {
      ...NATURAL_TEXT_POLICY,
      profile: "CUSTOM",
      normalizeWhitespace: false,
    };
    const result = await update(target("skill", skill.id), {
      practicePreference: "RECALL_FIRST",
      textPolicy: custom,
      alreadyStudied: true,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.settings).toEqual({
      practicePreference: "RECALL_FIRST",
      textPolicy: custom,
      alreadyStudied: true,
    });
    // Partial saves preserve fields that were not supplied, including explicit false.
    const partial = await update(target("skill", skill.id), {
      alreadyStudied: false,
    });
    expect(partial.structuredContent.settings).toEqual({
      practicePreference: "RECALL_FIRST",
      textPolicy: custom,
      alreadyStudied: false,
    });
    const inherited = await update(target("skill", skill.id), {
      practicePreference: null,
      textPolicy: null,
    });
    expect(inherited.structuredContent.effective).toMatchObject({
      practicePreference: "BALANCED",
      textPolicy: EXACT_TEXT_POLICY,
    });
    const defaults = await update(target("collection", collection.id), {
      practicePreference: null,
      textPolicy: null,
    });
    expect(defaults.structuredContent.effective).toMatchObject({
      practicePreference: "RECALL_FIRST",
      textPolicy: NATURAL_TEXT_POLICY,
    });
    const userPartial = await update({ scope: "user" }, { mixedReview: false });
    expect(userPartial.structuredContent.settings).toEqual({
      practicePreference: "RECALL_FIRST",
      mixedReview: false,
      dailyNewSkillLimit: null,
      practiceTimezone: "UTC",
    });
  });

  it("edits the daily limit and timezone through MCP without resetting other settings", async () => {
    const saved = await call("practice.update_settings", { target: { scope: "user" }, changes: { dailyNewSkillLimit: 2, practiceTimezone: "America/Chicago" } });
    expect(saved.structuredContent.settings).toMatchObject({ dailyNewSkillLimit: 2, practiceTimezone: "America/Chicago", practicePreference: "BALANCED" });
    await call("practice.update_settings", { target: { scope: "user" }, changes: { mixedReview: true } });
    const read = await call("practice.get_settings", { target: { scope: "user" } });
    expect(read.structuredContent.settings).toMatchObject({ dailyNewSkillLimit: 2, practiceTimezone: "America/Chicago", mixedReview: true });
    auth.scopes = ["practice:read"];
    const denied = await call("practice.update_settings", { target: { scope: "user" }, changes: { dailyNewSkillLimit: null } });
    expect(denied.isError).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } })).dailyNewSkillLimit).toBe(2);
  });

  it("discovers owned targets with bounded stable pagination and search", async () => {
    const other = await connection();
    await createSkillFixture(prisma, {
      userId: other.userId,
      title: "private vocabulary",
    });
    const skills = await Promise.all(
      ["vocabulary a", "vocabulary b", "unrelated"].map((title) =>
        createSkillFixture(prisma, { userId: auth.userId, title }),
      ),
    );
    const page1 = (
      await call("practice.list_targets", {
        scope: "skill",
        query: "vocabulary",
        limit: 1,
      })
    ).structuredContent;
    const page2 = (
      await call("practice.list_targets", {
        scope: "skill",
        query: "vocabulary",
        limit: 1,
        after_id: page1.next_cursor,
      })
    ).structuredContent;
    expect(
      [...page1.items, ...page2.items]
        .map((item: { id: string }) => item.id)
        .sort(),
    ).toEqual(
      skills
        .slice(0, 2)
        .map((s) => s.id)
        .sort(),
    );
    expect(page2.next_cursor).toBeNull();
    expect(JSON.stringify(page1)).not.toContain("userId");
    await prisma.collection.create({
      data: { userId: auth.userId, name: "Owned collection" },
    });
    await prisma.collection.create({
      data: { userId: other.userId, name: "Private collection" },
    });
    const collections = (
      await call("practice.list_targets", { scope: "collection" })
    ).structuredContent.items;
    expect(collections).toHaveLength(1);
    expect(collections[0].name).toBe("Owned collection");
  });

  it("denies foreign and nonexistent targets identically without changing inventory", async () => {
    const other = await connection();
    const collection = await prisma.collection.create({
      data: { userId: other.userId, name: "Private" },
    });
    const skill = await createSkillFixture(prisma, {
      userId: other.userId,
      title: "Secret",
      collectionId: collection.id,
    });
    for (const scope of ["skill", "collection"] as const) {
      for (const id of [
        scope === "skill" ? skill.id : collection.id,
        "missing",
      ]) {
        for (const name of [
          "practice.get_settings",
          "practice.update_settings",
        ]) {
          const result = await call(name, {
            target: target(scope, id),
            ...(name.endsWith("update_settings")
              ? { changes: { practicePreference: "RECALL_FIRST" } }
              : {}),
          });
          expect(result.isError).toBe(true);
          expect(result.structuredContent.code).toBe("settings_not_found");
        }
      }
    }
    expect(queueRetentionPreparation).not.toHaveBeenCalled();
    expect(
      (await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }))
        .practicePreference,
    ).toBeNull();
  });

  it("requires fresh scoped authorization, even after token verification", async () => {
    auth.scopes = ["skills:create"];
    expect(
      (
        await call("practice.update_settings", {
          target: { scope: "user" },
          changes: { mixedReview: true },
        })
      ).structuredContent.code,
    ).toBe("permission_denied");
    auth.scopes = ["practice:read"];
    expect(
      (await call("practice.get_settings", { target: { scope: "user" } }))
        .isError,
    ).not.toBe(true);
    expect(
      (
        await call("practice.update_settings", {
          target: { scope: "user" },
          changes: { mixedReview: true },
        })
      ).structuredContent.code,
    ).toBe("permission_denied");
    auth.scopes = ["practice:write"];
    expect(
      (await call("practice.get_settings", { target: { scope: "user" } }))
        .structuredContent.code,
    ).toBe("permission_denied");
    await prisma.agentConnection.update({
      where: { id: auth.connectionId },
      data: { scopes: ["practice:read"] },
    });
    await expect(
      updateAgentPracticeSettings(auth, {
        target: { scope: "user" },
        changes: { mixedReview: true },
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await prisma.agentConnection.update({
      where: { id: auth.connectionId },
      data: { scopes: ["practice:read", "practice:write"], status: "REVOKED" },
    });
    await expect(
      updateAgentPracticeSettings(auth, {
        target: { scope: "user" },
        changes: { mixedReview: true },
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }))
        .mixedReview,
    ).toBe(false);
  });

  it.each(["disabled", "deleting", "expired", "connection-mismatch"])(
    "denies %s accounts or credentials",
    async (reason) => {
      if (reason === "disabled")
        await prisma.user.update({
          where: { id: auth.userId },
          data: { agentAccessDisabledAt: new Date() },
        });
      if (reason === "deleting")
        await prisma.accountDeletionJob.create({
          data: { userId: auth.userId, manifest: {} },
        });
      if (reason === "expired") auth.expiresAt = 1;
      if (reason === "connection-mismatch") auth.sessionId = "other-session";
      await expect(
        getAgentPracticeSettings(auth, { target: { scope: "user" } }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      await expect(
        updateAgentPracticeSettings(auth, {
          target: { scope: "user" },
          changes: { mixedReview: true },
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    },
  );

  it("retires only affected future text and fences jobs while preserving history and schedules", async () => {
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Spanish accents",
      repetitions: 6,
    });
    const exercise = await createTextExercise(prisma, auth.userId, skill.id, {
      answerSpec: textAnswerContract(["sí"], NATURAL_TEXT_POLICY),
    });
    const choice = await createChoiceExercise({
      prisma,
      userId: auth.userId,
      skillId: skill.id,
    });
    const reviewedAt = new Date();
    expect(
      await commitPracticeReview({
        userId: auth.userId,
        exerciseId: exercise.id,
        submittedAnswer: "sí",
        responseMs: 4000,
        attemptId: randomUUID(),
        reviewedAt,
        now: reviewedAt,
      }),
    ).toMatchObject({ status: "committed" });
    const before = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
    });
    const history = await prisma.reviewLog.findMany({
      where: { skillId: skill.id },
    });
    const attempts = await prisma.exerciseAttempt.findMany({
      where: { skillId: skill.id },
    });
    expect(history).toHaveLength(1);
    await prisma.generationJob.create({
      data: {
        userId: auth.userId,
        skillId: skill.id,
        kind: "EXACT_INPUT_EXERCISE_GENERATION",
        status: "RUNNING",
        provider: "test",
        model: "fixture",
        promptVersion: "test-v1",
        requestedCount: 3,
      },
    });
    const result = await call("practice.update_settings", {
      target: target("skill", skill.id),
      changes: { textPolicy: EXACT_TEXT_POLICY, alreadyStudied: true },
    });
    expect(result.structuredContent.policy_changed).toBe(true);
    const updated = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
    });
    expect(updated).toMatchObject({
      textPolicyRevision: 1,
      repetitions: before.repetitions,
      stability: before.stability,
      difficulty: before.difficulty,
      dueAt: before.dueAt,
    });
    expect(
      await prisma.reviewLog.findMany({ where: { skillId: skill.id } }),
    ).toEqual(history);
    expect(
      await prisma.exerciseAttempt.findMany({ where: { skillId: skill.id } }),
    ).toEqual(attempts);
    expect(
      await prisma.exercise.findUniqueOrThrow({ where: { id: exercise.id } }),
    ).toMatchObject({
      retirementReason: "REPLACED",
      answerSpec: exercise.answerSpec,
    });
    expect(
      (await prisma.exercise.findUniqueOrThrow({ where: { id: choice.id } }))
        .retiredAt,
    ).toBeNull();
    expect(
      await prisma.generationJob.findFirstOrThrow({
        where: { skillId: skill.id },
      }),
    ).toMatchObject({ status: "FAILED", failureCategory: "CANCELED" });
    expect(queueRetentionPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: auth.userId, skillId: skill.id }),
    );
    await call("practice.update_settings", {
      target: target("skill", skill.id),
      changes: { textPolicy: EXACT_TEXT_POLICY, alreadyStudied: true },
    });
    expect(
      (await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }))
        .textPolicyRevision,
    ).toBe(1);
    expect(queueRetentionPreparation).toHaveBeenCalledTimes(1);
  });

  it("preserves concurrent partial writes and does not lose a save when preparation fails", async () => {
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Concurrent",
    });
    await Promise.all([
      updateAgentPracticeSettings(auth, {
        target: target("skill", skill.id),
        changes: { alreadyStudied: true },
      }),
      updateAgentPracticeSettings(auth, {
        target: target("skill", skill.id),
        changes: { practicePreference: "RECALL_FIRST" },
      }),
    ]);
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
    ).toMatchObject({
      alreadyStudied: true,
      practicePreference: "RECALL_FIRST",
    });
    vi.mocked(queueRetentionPreparation).mockRejectedValueOnce(
      new Error("private provider details"),
    );
    const response = await call("practice.update_settings", {
      target: target("skill", skill.id),
      changes: { textPolicy: EXACT_TEXT_POLICY },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent.preparation_deferred).toBe(true);
    expect(JSON.stringify(response)).not.toContain("private provider details");
  });

  it("reports malformed stored policies without treating them as valid inheritance and permits repair", async () => {
    const skill = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Repair",
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { textPolicy: { version: 999, secret: "not-for-tool-output" } },
    });
    const read = await call("practice.get_settings", {
      target: target("skill", skill.id),
    });
    expect(read.structuredContent.invalid_fields).toContain("textPolicy");
    expect(read.structuredContent.effective.textPolicy).toBeNull();
    expect(JSON.stringify(read)).not.toContain("not-for-tool-output");
    const partial = await call("practice.update_settings", {
      target: target("skill", skill.id),
      changes: { alreadyStudied: true },
    });
    expect(partial.structuredContent.code).toBe("invalid_stored_settings");
    const repair = await call("practice.update_settings", {
      target: target("skill", skill.id),
      changes: { textPolicy: null, alreadyStudied: true },
    });
    expect(repair.isError).not.toBe(true);
    expect(repair.structuredContent.effective.textPolicy).toEqual(
      NATURAL_TEXT_POLICY,
    );
    expect(
      await prisma.skill.count({
        where: { id: skill.id, textPolicy: { equals: Prisma.DbNull } },
      }),
    ).toBe(1);
  });

  it("enforces mutation and read limits without partially saving settings", async () => {
    // The allowance must not roll into another minute halfway through the test.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await prisma.agentRateLimitBucket.createMany({
      data: [
        {
          userId: auth.userId,
          connectionId: auth.connectionId,
          kind: "MUTATION",
          windowStart,
          count: 10,
        },
        {
          userId: auth.userId,
          connectionId: auth.connectionId,
          kind: "READ",
          windowStart,
          count: 60,
        },
      ],
    });
    const write = await call("practice.update_settings", {
      target: { scope: "user" },
      changes: { mixedReview: true },
    });
    expect(write.structuredContent).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    for (const name of ["practice.get_settings", "practice.list_targets"]) {
      const read = await call(
        name,
        name.endsWith("get_settings")
          ? { target: { scope: "user" } }
          : { scope: "skill" },
      );
      expect(read.structuredContent.code).toBe("rate_limited");
    }
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }))
        .mixedReview,
    ).toBe(false);
  });

  it("rejects invalid HTTP updates before mutation", async () => {
    for (const args of [
      { target: { scope: "user" }, changes: { mixedReview: "true" } },
      { target: { scope: "user" }, changes: { practicePreference: null } },
      { target: { scope: "user" }, changes: {} },
      {
        target: { scope: "user" },
        changes: { mixedReview: true },
        userId: "other",
      },
    ]) {
      const message = await rpc("tools/call", {
        name: "practice.update_settings",
        arguments: args,
      });
      expect(message.error || message.result?.isError).toBeTruthy();
    }
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }))
        .mixedReview,
    ).toBe(false);
    expect(queueRetentionPreparation).not.toHaveBeenCalled();
  });

  it("bounds collection changes and preparation while preserving explicit skill overrides", async () => {
    const collection = await prisma.collection.create({
      data: { userId: auth.userId, name: "Bounded" },
    });
    await prisma.skill.createMany({
      data: Array.from({ length: 12 }, (_, n) => ({
        userId: auth.userId,
        collectionId: collection.id,
        title: `Inheriting ${n}`,
        status: "ACTIVE",
      })),
    });
    const explicit = await prisma.skill.create({
      data: {
        userId: auth.userId,
        collectionId: collection.id,
        title: "Explicit",
        textPolicy: NATURAL_TEXT_POLICY,
      },
    });
    const result = await call("practice.update_settings", {
      target: target("collection", collection.id),
      changes: { textPolicy: EXACT_TEXT_POLICY },
    });
    expect(result.structuredContent.policy_changed).toBe(true);
    expect(
      await prisma.skill.count({
        where: { collectionId: collection.id, textPolicyRevision: 1 },
      }),
    ).toBe(12);
    expect(
      (await prisma.skill.findUniqueOrThrow({ where: { id: explicit.id } }))
        .textPolicyRevision,
    ).toBe(0);
    expect(queueRetentionPreparation).toHaveBeenCalledTimes(10);
    await prisma.skill.createMany({
      data: Array.from({ length: 489 }, (_, n) => ({
        userId: auth.userId,
        collectionId: collection.id,
        title: `More ${n}`,
      })),
    });
    const blocked = await call("practice.update_settings", {
      target: target("collection", collection.id),
      changes: { textPolicy: null, practicePreference: "RECALL_FIRST" },
    });
    expect(blocked.structuredContent.code).toBe("collection_too_large");
    expect(
      await prisma.collection.findUniqueOrThrow({
        where: { id: collection.id },
      }),
    ).toMatchObject({
      textPolicy: EXACT_TEXT_POLICY,
      practicePreference: null,
    });
    const allowed = await call("practice.update_settings", {
      target: target("collection", collection.id),
      changes: { practicePreference: "RECALL_FIRST" },
    });
    expect(allowed.isError).not.toBe(true);
  });

  it("rechecks revocation after waiting for an in-flight connection change", async () => {
    let locked!: () => void;
    let release!: () => void;
    let revocationPid = 0;
    const didLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const canCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        revocationPid = backend.pid;
        await tx.agentConnection.update({
          where: { id: auth.connectionId },
          data: { status: "REVOKED" },
        });
        locked();
        await canCommit;
      },
      { timeout: 10_000 },
    );
    await didLock;
    const pending = updateAgentPracticeSettings(auth, {
      target: { scope: "user" },
      changes: { mixedReview: true },
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "permission_denied",
    });
    try {
      // Observe PostgreSQL's actual lock wait before committing revocation.
      // A plain status lookup without the connection lock must fail this test.
      await expect
        .poll(
          async () => {
            const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${revocationPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `;
            return state.waiting;
          },
          { timeout: 3_000, interval: 50 },
        )
        .toBe(true);
    } finally {
      release();
    }
    await revoke;
    await assertion;
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }))
        .mixedReview,
    ).toBe(false);
  });
});
