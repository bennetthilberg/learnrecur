import { getAlphaAccessPolicy, isAlphaUserAllowed } from "./alpha-access";
import { formatEnvError, hasDatabaseEnv } from "./env";
import { getPrisma } from "./prisma";

export type ClerkUserSnapshot = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  imageUrl?: string | null;
  username?: string | null;
  primaryEmailAddress?: {
    emailAddress?: string | null;
  } | null;
};

export type DatabaseUserStatus =
  | {
      status: "ready";
      user: MirroredUserRecord;
    }
  | {
      status: "missing-env";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };

export type MirroredUserRecord = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type UserMirrorClient = {
  user: {
    upsert: (args: {
      where: { id: string };
      update: {
        email: string | null;
        name: string | null;
        imageUrl: string | null;
        lastSeenAt: Date;
      };
      create: {
        id: string;
        email: string | null;
        name: string | null;
        imageUrl: string | null;
        lastSeenAt: Date;
      };
      select: {
        id: true;
        email: true;
        name: true;
        createdAt: true;
        updatedAt: true;
      };
    }) => Promise<MirroredUserRecord>;
  };
  accountDeletionJob?: {
    findUnique: (args: {
      where: { userId: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

export type AuthenticatedUserClient = UserMirrorClient & {
  user: UserMirrorClient["user"] & {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        email: true;
        name: true;
        createdAt: true;
        updatedAt: true;
      };
    }) => Promise<MirroredUserRecord | null>;
  };
};

type EnsureDatabaseUserOptions = {
  prisma?: UserMirrorClient;
  skipEnvCheck?: boolean;
  skipAlphaCheck?: boolean;
};

type EnsureAuthenticatedDatabaseUserOptions = {
  prisma?: AuthenticatedUserClient;
  skipEnvCheck?: boolean;
};

export async function ensureAuthenticatedDatabaseUser(
  input: {
    userId: string;
    loadClerkUser: () => Promise<ClerkUserSnapshot | null>;
  },
  options: EnsureAuthenticatedDatabaseUserOptions = {},
): Promise<DatabaseUserStatus> {
  if (!options.skipEnvCheck && !hasDatabaseEnv()) {
    return missingDatabaseEnvStatus();
  }

  if (!(await isAlphaUserAllowed(input.userId, getAlphaAccessPolicy()))) {
    return alphaAccessDeniedStatus();
  }

  let clerkUser: ClerkUserSnapshot | null = null;
  let clerkLookupError: unknown;
  try {
    clerkUser = await input.loadClerkUser();
  } catch (error) {
    clerkLookupError = error;
  }

  if (clerkUser) {
    if (clerkUser.id !== input.userId) {
      return {
        status: "error",
        message: "Your account details could not be refreshed. Reload this page to try again.",
      };
    }
    return ensureDatabaseUser(clerkUser, {
      prisma: options.prisma,
      skipEnvCheck: true,
      skipAlphaCheck: true,
    });
  }

  try {
    const existing = options.prisma
      ? await findMirroredUser(options.prisma, input.userId)
      : await getPrisma().$transaction(async (transaction) => {
          await transaction.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
          return findMirroredUser(transaction, input.userId);
        });
    if (existing.status === "deletion-in-progress") {
      return deletionInProgressStatus();
    }
    if (existing.user) {
      console.warn("[users] Clerk user lookup failed; using mirrored user", {
        userId: input.userId,
        reason: clerkLookupError ? "lookup-error" : "user-not-found",
      });
      return { status: "ready", user: existing.user };
    }
  } catch (error) {
    return { status: "error", message: formatDatabaseUserError(error) };
  }

  return {
    status: "error",
    message: "Your account details could not be refreshed. Reload this page to try again.",
  };
}

async function findMirroredUser(
  prisma: AuthenticatedUserClient,
  userId: string,
): Promise<
  | { status: "found"; user: MirroredUserRecord | null }
  | { status: "deletion-in-progress" }
> {
  const deletionJob = await prisma.accountDeletionJob?.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (deletionJob) return { status: "deletion-in-progress" };
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return { status: "found", user };
}

export async function ensureDatabaseUser(
  clerkUser: ClerkUserSnapshot,
  options: EnsureDatabaseUserOptions = {},
): Promise<DatabaseUserStatus> {
  if (!options.skipEnvCheck && !hasDatabaseEnv()) {
    return missingDatabaseEnvStatus();
  }

  if (
    !options.skipAlphaCheck &&
    !(await isAlphaUserAllowed(clerkUser.id, getAlphaAccessPolicy()))
  ) {
    return alphaAccessDeniedStatus();
  }

  try {
    const email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
    const name = getDisplayName(clerkUser);
    const mirror = (prisma: UserMirrorClient) =>
      mirrorDatabaseUser(prisma, {
        id: clerkUser.id,
        email,
        name,
        imageUrl: clerkUser.imageUrl ?? null,
      });
    const result = options.prisma
      ? await mirror(options.prisma)
      : await getPrisma().$transaction(async (transaction) => {
          await transaction.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${clerkUser.id} FOR UPDATE`;
          return mirror(transaction);
        });

    return result.status === "ready"
      ? result
      : deletionInProgressStatus();
  } catch (error) {
    return {
      status: "error",
      message: formatDatabaseUserError(error),
    };
  }
}

async function mirrorDatabaseUser(
  prisma: UserMirrorClient,
  input: {
    id: string;
    email: string | null;
    name: string | null;
    imageUrl: string | null;
  },
): Promise<
  | Extract<DatabaseUserStatus, { status: "ready" }>
  | { status: "deletion-in-progress" }
> {
  const deletionJob = await prisma.accountDeletionJob?.findUnique({
    where: { userId: input.id },
    select: { id: true },
  });
  if (deletionJob) return { status: "deletion-in-progress" };

  const lastSeenAt = new Date();
  const user = await prisma.user.upsert({
    where: { id: input.id },
    update: {
      email: input.email,
      name: input.name,
      imageUrl: input.imageUrl,
      lastSeenAt,
    },
    create: { ...input, lastSeenAt },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return { status: "ready", user };
}

function deletionInProgressStatus(): DatabaseUserStatus {
  return {
    status: "error",
    message: "Account deletion is in progress. App access is disabled.",
  };
}

function alphaAccessDeniedStatus(): DatabaseUserStatus {
  return {
    status: "error",
    message: "This LearnRecur alpha is invitation-only.",
  };
}

function missingDatabaseEnvStatus(): DatabaseUserStatus {
  return {
    status: "missing-env",
    message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
  };
}

function formatDatabaseUserError(error: unknown): string {
  const message = formatEnvError(error);
  const collapsedMessage = message.replace(/\s+/g, " ").trim();

  if (/Authentication failed against the database server/i.test(collapsedMessage)) {
    return "Database authentication failed. Check DATABASE_URL in .env.local, restart the dev server, then reload this page.";
  }

  if (/Can't reach database server/i.test(collapsedMessage)) {
    return "Could not reach the database server. Check DATABASE_URL and network access, then reload this page.";
  }

  return message;
}

function getDisplayName(user: ClerkUserSnapshot): string | null {
  if (user.fullName) {
    return user.fullName;
  }

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

  if (name) {
    return name;
  }

  return user.username ?? null;
}
