import { z } from "zod";

const emailSchema = z.string().email();

export function normalizeAlphaEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return !normalized.includes("*") && emailSchema.safeParse(normalized).success
    ? normalized
    : null;
}

// A domain rule matches that exact domain, never its subdomains or suffixes.
// Share parsing with deployment validation so malformed rules fail closed.
export function parseAlphaAllowlist(value: string | undefined): string[] | null {
  const entries = (value ?? "").split(/[,\n]/u).map((entry) => entry.normalize("NFKC").trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (entry.startsWith("*@")) {
      if (!normalizeAlphaEmail(`alpha@${entry.slice(2)}`)) return null;
    } else if (!normalizeAlphaEmail(entry)) {
      return null;
    }
  }
  return [...new Set(entries)];
}
