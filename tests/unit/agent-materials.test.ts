import { describe, expect, it } from "vitest";

import { sanitizeLocator } from "@/lib/agent-access/materials";

describe("sanitizeLocator", () => {
  it("keeps bounded learner-facing location fields", () => {
    expect(
      sanitizeLocator({ page: 4, pageEnd: 6, heading: "Recursion", storageKey: "private/key.pdf", url: "https://secret" }),
    ).toEqual({ page: 4, pageEnd: 6, heading: "Recursion" });
  });

  it("drops malformed or oversized values", () => {
    expect(sanitizeLocator({ heading: "x".repeat(301), page: Number.NaN, sourceUrl: "secret" })).toBeNull();
    expect(sanitizeLocator("page 1")).toBeNull();
  });
});
