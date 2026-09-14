import { z } from "zod";

export function formDraftKey(userId: string, scope: string) {
  return `learnrecur:form:v1:${userId}:${scope}`;
}

export function readFormDraft<T>(key: string, baseline: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 200_000) return null;
    const parsed = z.object({ baseline: z.string(), value: schema }).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.baseline === baseline ? parsed.data.value : null;
  } catch { return null; }
}

export function writeFormDraft<T>(key: string, baseline: string, value: T | null): boolean {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else {
      const encoded = JSON.stringify({ baseline, value });
      if (encoded.length > 200_000) return false;
      sessionStorage.setItem(key, encoded);
    }
    return true;
  } catch { return false; }
}
