import { z } from "zod";

const supportEmailSchema = z.string().trim().email();

export function getSupportEmail(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const parsed = supportEmailSchema.safeParse(env.SUPPORT_EMAIL);
  return parsed.success ? parsed.data.toLowerCase() : null;
}
