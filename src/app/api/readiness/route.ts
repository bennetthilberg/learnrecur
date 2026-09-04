import { handleReadinessRequest } from "@/lib/observability/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleReadinessRequest(request);
}
