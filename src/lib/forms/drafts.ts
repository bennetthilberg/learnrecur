import { z } from "zod";

// Browser-only fallback for SPA navigation when storage is full or unavailable.
// It cannot survive a document reload; callers still warn before unloading.
const memoryDrafts = new Map<string, string | null>();
export function hasMemoryFormDraft(key: string): boolean {
  return typeof window !== "undefined" && memoryDrafts.has(key);
}

export function formDraftKey(userId: string, scope: string) {
  return `learnrecur:form:v1:${userId}:${scope}`;
}

export function readFormDraft<T>(key: string, baseline: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = hasMemoryFormDraft(key) ? memoryDrafts.get(key) : sessionStorage.getItem(key);
    if (!raw || raw.length > 200_000) return null;
    const parsed = z.object({ baseline: z.string(), value: schema }).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.baseline === baseline ? parsed.data.value : null;
  } catch { return null; }
}

export function writeFormDraft<T>(key: string, baseline: string, value: T | null): boolean {
  if (typeof window === "undefined") return false;
  let encoded: string | null;
  try {
    encoded = value === null ? null : JSON.stringify({ baseline, value });
    if (encoded !== null && encoded.length > 200_000) { memoryDrafts.delete(key); return false; }
  } catch { memoryDrafts.delete(key); return false; }
  try {
    if (encoded === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, encoded);
    memoryDrafts.delete(key);
    return true;
  } catch {
    // Prefer this latest value over stale storage; null also masks a failed removal.
    memoryDrafts.set(key, encoded);
    return false;
  }
}
