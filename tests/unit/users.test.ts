import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureDatabaseUser,
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
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
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
});
