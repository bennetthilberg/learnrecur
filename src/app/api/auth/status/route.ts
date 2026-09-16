import { auth } from "@clerk/nextjs/server";

export async function GET() {
  const { userId } = await auth();
  return Response.json({ signedIn: Boolean(userId) }, { headers: { "Cache-Control": "no-store" } });
}
