import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return { ...actual, ...joseMocks };
});

import { AgentConnectionStatus } from "@/generated/prisma/client";
import { verifyAgentBearerToken } from "@/lib/agent-access/auth";
import { getPrisma } from "@/lib/prisma";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const runId = `agent_auth_reconsent_${randomUUID()}`;
const resourceUrl = "https://learnrecur.com/mcp";
const clientId = "https://agent.example/client.json";
const originalEnvironment = new Map<string, string | undefined>();
const environment = {
  AGENT_SKILL_CREATION_ENABLED: "1",
  MCP_RESOURCE_URL: resourceUrl,
  MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
  MCP_ALLOWED_CLIENT_IDS: `${clientId},https://other.example/client.json`,
  MCP_ALLOW_VERIFIED_CIMD_CLIENTS: "0",
  WORKOS_AUTHKIT_ISSUER: "https://test.authkit.example",
  WORKOS_API_KEY: "sk_test_reconsent",
  AGENT_OAUTH_COOKIE_SECRET: "a-secure-cookie-secret-at-least-32-bytes",
  AGENT_PERMISSION_VERSION: "1",
};

type TokenPayload = {
  sub: string;
  sid: string;
  client_id: string;
  exp: number;
  scope: string;
};

describeDatabase("native agent reconsent scope reconciliation", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];
  const tokenPayloads = new Map<string, TokenPayload>();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    for (const [key, value] of Object.entries(environment)) {
      originalEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  beforeEach(() => {
    tokenPayloads.clear();
    joseMocks.createRemoteJWKSet.mockClear();
    joseMocks.jwtVerify.mockReset();
    joseMocks.jwtVerify.mockImplementation(async (token: string) => {
      const payload = tokenPayloads.get(token);
      if (!payload) throw new Error(`missing test token ${token}`);
      return { payload };
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.accountDeletionJob.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createFixture(label: string) {
    const userId = `${runId}_${label}_${randomUUID().slice(0, 8)}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, email: `${label}@example.test` } });
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `${runId}_${label}_workos`,
        externalId: userId,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: identity.externalId,
        workosSessionId: `${runId}_${label}_session`,
        workosApplicationId: `${runId}_${label}_application`,
        clientId,
        clientName: "Reconsent test agent",
        clientDomain: "agent.example",
        resourceUrl,
        scopes: ["skills:create", "materials:read", "sources:upload"],
      },
    });
    return { userId, identity, connection };
  }

  function tokenFor(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    token: string,
    scopes: string[],
    overrides: Partial<TokenPayload> = {},
  ) {
    tokenPayloads.set(token, {
      sub: fixture.identity.externalId,
      sid: fixture.connection.workosSessionId,
      client_id: clientId,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      scope: scopes.join(" "),
      ...overrides,
    });
    return token;
  }

  function grantResponse(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    options: {
      status?: number;
      resource?: string | null;
      applicationId?: string;
      usesPkce?: boolean;
      count?: number;
    } = {},
  ) {
    const count = options.count ?? 1;
    return new Response(
      JSON.stringify({
        data: Array.from({ length: count }, () => ({
          oauth_resource: options.resource === undefined ? resourceUrl : options.resource,
          granted_scopes: [],
          application: {
            id: options.applicationId ?? fixture.connection.workosApplicationId,
            client_id: clientId,
            name: "Reconsent test agent",
            uses_pkce: options.usesPkce ?? true,
          },
        })),
      }),
      {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  async function verify(token: string) {
    return verifyAgentBearerToken(
      new Request(`${resourceUrl}/tools`),
      token,
    );
  }

  it("accepts an existing session after exact reconsent and keeps old tokens narrow", async () => {
    const fixture = await createFixture("expand");
    fetchMock.mockResolvedValue(grantResponse(fixture));

    const oldToken = tokenFor(fixture, "old-token", ["skills:create"]);
    await expect(verify(oldToken)).resolves.toMatchObject({
      clientId,
      scopes: ["skills:create"],
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const newToken = tokenFor(fixture, "new-token", [
      "skills:create",
      "practice:read",
      "practice:write",
    ]);
    await expect(verify(newToken)).resolves.toMatchObject({
      clientId,
      scopes: ["practice:read", "practice:write", "skills:create"],
    });
    await expect(verify(oldToken)).resolves.toMatchObject({
      clientId,
      scopes: ["skills:create"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      userId: fixture.userId,
      workosIdentityId: fixture.identity.id,
      workosSubject: fixture.identity.externalId,
      workosSessionId: fixture.connection.workosSessionId,
      workosApplicationId: fixture.connection.workosApplicationId,
      clientId,
      resourceUrl,
      permissionVersion: 1,
      status: AgentConnectionStatus.ACTIVE,
      scopes: ["skills:create", "materials:read", "sources:upload", "practice:read", "practice:write"],
    });
  });

  it("unions concurrent reconsents without losing either scope expansion", async () => {
    const fixture = await createFixture("concurrent");
    fetchMock.mockImplementation(async () => grantResponse(fixture));
    const first = tokenFor(fixture, "concurrent-first", ["skills:create", "practice:read"]);
    const second = tokenFor(fixture, "concurrent-second", ["skills:create", "practice:write"]);

    const results = await Promise.all([verify(first), verify(second)]);

    expect(results.map((result) => result?.scopes)).toEqual(
      expect.arrayContaining([
        ["practice:read", "skills:create"],
        ["practice:write", "skills:create"],
      ]),
    );
    const stored = await prisma.agentConnection.findUniqueOrThrow({
      where: { id: fixture.connection.id },
    });
    expect(stored.scopes).toHaveLength(5);
    expect(stored.scopes).toEqual(
      expect.arrayContaining([
        "skills:create",
        "materials:read",
        "sources:upload",
        "practice:read",
        "practice:write",
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["client", { client_id: "https://other.example/client.json" }],
    ["resource", { resourceUrl: "https://other.example/mcp" }],
  ] as const)("rejects an existing session with a changed %s binding", async (_label, change) => {
    const fixture = await createFixture(`binding-${_label}`);
    if ("resourceUrl" in change) {
      await prisma.agentConnection.update({
        where: { id: fixture.connection.id },
        data: { resourceUrl: change.resourceUrl },
      });
    }
    fetchMock.mockResolvedValue(grantResponse(fixture));
    const tokenOverrides: Partial<TokenPayload> = "client_id" in change ? change : {};
    const token = tokenFor(
      fixture,
      `binding-token-${_label}`,
      ["skills:create", "practice:read"],
      tokenOverrides,
    );

    await expect(verify(token)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      scopes: ["skills:create", "materials:read", "sources:upload"],
    });
  });

  it.each([
    ["grant denied", (fixture: Awaited<ReturnType<typeof createFixture>>) => new Response(JSON.stringify({ fixture: fixture.connection.id }), { status: 403 })],
    ["wrong resource", (fixture: Awaited<ReturnType<typeof createFixture>>) => grantResponse(fixture, { resource: "https://other.example/mcp" })],
    ["multiple matching grants", (fixture: Awaited<ReturnType<typeof createFixture>>) => grantResponse(fixture, { count: 2 })],
    ["missing PKCE", (fixture: Awaited<ReturnType<typeof createFixture>>) => grantResponse(fixture, { usesPkce: false })],
    ["changed application binding", (fixture: Awaited<ReturnType<typeof createFixture>>) => grantResponse(fixture, { applicationId: "different-application" })],
  ] as const)("rejects %s without mutating stored scopes", async (_label, makeResponse) => {
    const fixture = await createFixture(`grant-${String(_label).replaceAll(" ", "-")}`);
    fetchMock.mockResolvedValue(makeResponse(fixture));
    const token = tokenFor(fixture, `token-${_label}`, ["skills:create", "practice:read"]);

    await expect(verify(token)).resolves.toBeUndefined();
    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      status: AgentConnectionStatus.ACTIVE,
      scopes: ["skills:create", "materials:read", "sources:upload"],
    });
  });

  it("rechecks revocation after the provider lookup before expanding scopes", async () => {
    const fixture = await createFixture("revocation-race");
    let releaseProvider: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      await providerStarted;
      return grantResponse(fixture);
    });
    const token = tokenFor(fixture, "revocation-race-token", ["skills:create", "practice:read"]);
    const pending = verify(token);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await prisma.agentConnection.update({
      where: { id: fixture.connection.id },
      data: { status: AgentConnectionStatus.REVOKED, revokedAt: new Date() },
    });
    releaseProvider?.();

    await expect(pending).resolves.toBeUndefined();
    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      status: AgentConnectionStatus.REVOKED,
      scopes: ["skills:create", "materials:read", "sources:upload"],
    });
  });

  it.each([
    ["disabled", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await prisma.user.update({ where: { id: fixture.userId }, data: { agentAccessDisabledAt: new Date() } });
    }],
    ["deleted", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await prisma.accountDeletionJob.create({ data: { userId: fixture.userId, manifest: {} } });
    }],
    ["revoked", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await prisma.agentConnection.update({ where: { id: fixture.connection.id }, data: { status: AgentConnectionStatus.REVOKED } });
    }],
    ["permission version mismatch", async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await prisma.agentConnection.update({ where: { id: fixture.connection.id }, data: { permissionVersion: 2 } });
    }],
  ] as const)("rejects a %s connection fence before scope expansion", async (_label, mutate) => {
    const fixture = await createFixture(`fence-${String(_label).replaceAll(" ", "-")}`);
    await mutate(fixture);
    fetchMock.mockResolvedValue(grantResponse(fixture));
    const token = tokenFor(fixture, `fence-token-${_label}`, ["skills:create", "practice:read"]);

    await expect(verify(token)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      scopes: ["skills:create", "materials:read", "sources:upload"],
    });
  });

  it("rejects an expired reconsent token before provider access", async () => {
    const fixture = await createFixture("expired");
    fetchMock.mockResolvedValue(grantResponse(fixture));
    const token = tokenFor(fixture, "expired-token", ["skills:create", "practice:read"], {
      exp: Math.floor(Date.now() / 1_000) - 1,
    });

    await expect(verify(token)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
