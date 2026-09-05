import "server-only";
import { createClerkClient } from "@clerk/backend";

// Background jobs have no Next.js request or React rendering context. Resolve
// the secret at call time because Lambda loads its configuration during startup.
export function createClerkServiceClient() {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is required");
  return createClerkClient({ secretKey });
}
