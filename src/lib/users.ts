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
};

type EnsureDatabaseUserOptions = {
  prisma?: UserMirrorClient;
  skipEnvCheck?: boolean;
};

export async function ensureDatabaseUser(
  clerkUser: ClerkUserSnapshot,
  options: EnsureDatabaseUserOptions = {},
): Promise<DatabaseUserStatus> {
  if (!options.skipEnvCheck && !hasDatabaseEnv()) {
    return {
      status: "missing-env",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    };
  }

  try {
    const email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
    const name = getDisplayName(clerkUser);
    const prisma = options.prisma ?? getPrisma();

    const user = await prisma.user.upsert({
      where: { id: clerkUser.id },
      update: {
        email,
        name,
        imageUrl: clerkUser.imageUrl ?? null,
        lastSeenAt: new Date(),
      },
      create: {
        id: clerkUser.id,
        email,
        name,
        imageUrl: clerkUser.imageUrl ?? null,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { status: "ready", user };
  } catch (error) {
    return {
      status: "error",
      message: formatDatabaseUserError(error),
    };
  }
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
