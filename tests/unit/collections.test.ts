import { describe, expect, it } from "vitest";

import {
  normalizeCollectionInput,
  normalizeCollectionName,
} from "@/lib/collections";

describe("normalizeCollectionName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeCollectionName("  Spanish   grammar\tpractice  ")).toBe(
      "Spanish grammar practice",
    );
  });
});

describe("normalizeCollectionInput", () => {
  it("normalizes collection names and optional descriptions", () => {
    expect(
      normalizeCollectionInput({
        name: "  Spanish   grammar  ",
        description: "  Practice from class notes.  ",
      }),
    ).toEqual({
      status: "ready",
      value: {
        name: "Spanish grammar",
        description: "Practice from class notes.",
        nameKey: "spanish grammar",
      },
    });
  });

  it("converts empty descriptions to null", () => {
    expect(
      normalizeCollectionInput({
        name: "Spanish",
        description: "  ",
      }),
    ).toEqual({
      status: "ready",
      value: {
        name: "Spanish",
        description: null,
        nameKey: "spanish",
      },
    });
  });

  it("rejects missing and oversized fields with stable field errors", () => {
    const result = normalizeCollectionInput({
      name: " ",
      description: "x".repeat(501),
      extra: "unknown",
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.name).toEqual(["Collection name is required."]);
      expect(result.fieldErrors.description).toEqual([
        "Keep the description to 500 characters or fewer.",
      ]);
    }
  });
});
