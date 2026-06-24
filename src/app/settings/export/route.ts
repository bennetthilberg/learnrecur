import { auth, currentUser } from "@clerk/nextjs/server";

import { getUserDataExport } from "@/lib/settings/data-export";
import { ensureDatabaseUser } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk returned no authenticated user.");
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return jsonError(databaseUser.message, databaseUser.status === "access-denied" ? 403 : 503);
  }

  const result = await getUserDataExport({
    userId,
    generatedAt: new Date(),
  });

  if (result.status !== "ready") {
    return jsonError(result.message, 404);
  }

  return new Response(`${JSON.stringify(result.export, null, 2)}\n`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
