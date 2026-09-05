import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkMocks = vi.hoisted(() => ({
  clerkClient: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: clerkMocks.clerkClient,
}));
vi.mock("@/lib/clerk/backend", () => ({
  createClerkServiceClient: clerkMocks.clerkClient,
}));

import {
  ensureAuthenticatedDatabaseUser,
  ensureDatabaseUser,
  type AuthenticatedUserClient,
  type ClerkUserSnapshot,
  type MirroredUserRecord,
  type UserMirrorClient,
} from "@/lib/users";

type UserUpsertArgs = Parameters<UserMirrorClient["user"]["upsert"]>[0];

const originalEnv = process.env;

function makeMirrorClient(
  implementation?: (args: UserUpsertArgs) => Promise<MirroredUserRecord>,
) {
  const upsert = vi.fn(async (args: UserUpsertArgs): Promise<MirroredUserRecord> => {
    if (implementation) {
      return implementation(args);
    }

    return {
      id: args.create.id,
      email: args.create.email,
      name: args.create.name,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  });

  return {
    client: { user: { upsert } } satisfies UserMirrorClient,
    upsert,
  };
}

const baseClerkUser: ClerkUserSnapshot = {
  id: "user_test_123",
  fullName: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  username: "ada",
  imageUrl: "https://img.clerk.com/user_test_123",
  primaryEmailAddress: {
    emailAddress: "ada@example.com",
  },
};

describe("ensureDatabaseUser", () => {
  beforeEach(() => {
    clerkMocks.clerkClient.mockReset();
    clerkMocks.getUser.mockReset();
    clerkMocks.clerkClient.mockResolvedValue({ users: { getUser: clerkMocks.getUser } });
    clerkMocks.getUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "ada@example.com",
        verification: { status: "verified" },
      },
    });
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.ALPHA_ALLOWED_EMAILS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it("reports missing database configuration before touching Prisma", async () => {
    await expect(ensureDatabaseUser(baseClerkUser)).resolves.toEqual({
      status: "missing-env",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    });
  });

  it("mirrors signed-in users in Vercel preview deployments", async () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    process.env.ALPHA_ALLOWED_EMAILS = "ada@example.com";
    const { client, upsert } = makeMirrorClient();

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("mirrors signed-in users in Vercel production deployments", async () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    process.env.ALPHA_ALLOWED_EMAILS = "ada@example.com";
    const { client, upsert } = makeMirrorClient();

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("mirrors signed-in users in production Node deployments", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALPHA_ALLOWED_EMAILS = "ada@example.com";
    const { client, upsert } = makeMirrorClient();

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("creates or updates the mirrored user by Clerk ID", async () => {
    const { client, upsert } = makeMirrorClient();

    const result = await ensureDatabaseUser(baseClerkUser, {
      prisma: client,
      skipEnvCheck: true,
    });

    expect(result).toEqual({
      status: "ready",
      user: {
        id: "user_test_123",
        email: "ada@example.com",
        name: "Ada Lovelace",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith({
      where: { id: "user_test_123" },
      update: {
        email: "ada@example.com",
        name: "Ada Lovelace",
        imageUrl: "https://img.clerk.com/user_test_123",
        lastSeenAt: expect.any(Date),
      },
      create: {
        id: "user_test_123",
        email: "ada@example.com",
        name: "Ada Lovelace",
        imageUrl: "https://img.clerk.com/user_test_123",
        lastSeenAt: expect.any(Date),
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("does not recreate a user after a durable deletion request exists", async () => {
    const { client, upsert } = makeMirrorClient();
    const findDeletionJob = vi.fn().mockResolvedValue({ id: "deletion-job-1" });

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: {
          ...client,
          accountDeletionJob: { findUnique: findDeletionJob },
        },
        skipEnvCheck: true,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "Account deletion is in progress. App access is disabled.",
    });
    expect(findDeletionJob).toHaveBeenCalledWith({
      where: { userId: baseClerkUser.id },
      select: { id: true },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("blocks a direct server mutation for a non-allowlisted production user", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALPHA_ALLOWED_EMAILS = "approved@example.com";
    clerkMocks.getUser.mockResolvedValue({
      primaryEmailAddress: {
        emailAddress: "not-approved@example.com",
        verification: { status: "verified" },
      },
    });
    const { client, upsert } = makeMirrorClient();

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "This LearnRecur alpha is invitation-only.",
    });
    expect(clerkMocks.getUser).toHaveBeenCalledWith(baseClerkUser.id);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("falls back from full name to first/last name, then username, then null", async () => {
    const cases: Array<{
      clerkUser: ClerkUserSnapshot;
      expectedName: string | null;
    }> = [
      {
        clerkUser: {
          id: "user_name_parts",
          firstName: "Grace",
          lastName: "Hopper",
          primaryEmailAddress: null,
        },
        expectedName: "Grace Hopper",
      },
      {
        clerkUser: {
          id: "user_username",
          username: "katherine",
          primaryEmailAddress: null,
        },
        expectedName: "katherine",
      },
      {
        clerkUser: {
          id: "user_no_name",
          primaryEmailAddress: null,
        },
        expectedName: null,
      },
    ];

    for (const { clerkUser, expectedName } of cases) {
      const { client, upsert } = makeMirrorClient();

      await expect(
        ensureDatabaseUser(clerkUser, {
          prisma: client,
          skipEnvCheck: true,
        }),
      ).resolves.toMatchObject({
        status: "ready",
        user: {
          id: clerkUser.id,
          email: null,
          name: expectedName,
        },
      });
      expect(upsert.mock.calls[0]?.[0].create.name).toBe(expectedName);
      expect(upsert.mock.calls[0]?.[0].update.name).toBe(expectedName);
    }
  });

  it("normalizes absent optional Clerk fields to null for database writes", async () => {
    const { client, upsert } = makeMirrorClient();

    await ensureDatabaseUser(
      {
        id: "user_sparse",
        fullName: null,
        imageUrl: null,
        primaryEmailAddress: null,
      },
      {
        prisma: client,
        skipEnvCheck: true,
      },
    );

    expect(upsert.mock.calls[0]?.[0].create).toMatchObject({
      id: "user_sparse",
      email: null,
      name: null,
      imageUrl: null,
    });
    expect(upsert.mock.calls[0]?.[0].update).toMatchObject({
      email: null,
      name: null,
      imageUrl: null,
    });
  });

  it("returns a dashboard-safe error when the database write fails", async () => {
    const { client } = makeMirrorClient(async () => {
      throw new Error("database is unavailable");
    });

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "database is unavailable",
    });
  });

  it("uses the existing mirrored user when Clerk's server lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mirroredUser = {
      id: baseClerkUser.id,
      email: "preserved@example.com",
      name: "Preserved Name",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const { client, upsert } = makeMirrorClient();
    const findUnique = vi.fn(async () => mirroredUser);
    const prisma = {
      user: { ...client.user, findUnique },
    } satisfies AuthenticatedUserClient;

    await expect(
      ensureAuthenticatedDatabaseUser(
        {
          userId: baseClerkUser.id,
          loadClerkUser: async () => {
            throw new Error("fetch failed");
          },
        },
        { prisma, skipEnvCheck: true },
      ),
    ).resolves.toEqual({ status: "ready", user: mirroredUser });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: baseClerkUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[users] Clerk user lookup failed; using mirrored user",
      {
        userId: baseClerkUser.id,
        reason: "lookup-error",
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fetch failed");
  });

  it("does not use a mirrored fallback after account deletion starts", async () => {
    const { client } = makeMirrorClient();
    const findUnique = vi.fn();
    const prisma = {
      user: { ...client.user, findUnique },
      accountDeletionJob: { findUnique: vi.fn().mockResolvedValue({ id: "deletion-job-1" }) },
    } satisfies AuthenticatedUserClient;

    await expect(
      ensureAuthenticatedDatabaseUser(
        {
          userId: baseClerkUser.id,
          loadClerkUser: async () => {
            throw new Error("fetch failed");
          },
        },
        { prisma, skipEnvCheck: true },
      ),
    ).resolves.toEqual({
      status: "error",
      message: "Account deletion is in progress. App access is disabled.",
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns a safe error when Clerk fails before the user was mirrored", async () => {
    const { client } = makeMirrorClient();
    const prisma = {
      user: { ...client.user, findUnique: vi.fn(async () => null) },
    } satisfies AuthenticatedUserClient;

    await expect(
      ensureAuthenticatedDatabaseUser(
        {
          userId: "user_not_mirrored",
          loadClerkUser: async () => {
            throw new Error("private upstream detail");
          },
        },
        { prisma, skipEnvCheck: true },
      ),
    ).resolves.toEqual({
      status: "error",
      message: "Your account details could not be refreshed. Reload this page to try again.",
    });
  });

  it("removes Prisma invocation noise from database authentication errors", async () => {
    const { client } = makeMirrorClient(async () => {
      throw new Error(
        "Invalid `prisma.user.upsert()` invocation in /Users/main/repos/learnrecur/.next/dev/server/chunks/ssr/app.js:5378:40\n\n" +
          "5375 const prisma = options.prisma\n" +
          "5376 const email = clerkUser.primaryEmailAddress?.emailAddress ?? null\n" +
          "→ 5378 const user = await prisma.user.upsert(\n" +
          "Authentication failed against the database server, the provided database credentials for `(not available)` are not valid",
      );
    });

    await expect(
      ensureDatabaseUser(baseClerkUser, {
        prisma: client,
        skipEnvCheck: true,
      }),
    ).resolves.toEqual({
      status: "error",
      message:
        "Database authentication failed. Check DATABASE_URL in .env.local, restart the dev server, then reload this page.",
    });
  });
});
