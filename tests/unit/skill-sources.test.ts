import { describe, expect, it } from "vitest";

import {
  buildSourcePreview,
  SOURCE_PREVIEW_CHAR_LIMIT,
} from "@/lib/skills/sources";

describe("buildSourcePreview", () => {
  it("normalizes whitespace and caps long source text deterministically", () => {
    const preview = buildSourcePreview(
      `  ${"source ".repeat(120)}\n\n${"detail ".repeat(120)}  `,
    );

    expect(preview).not.toBeNull();
    expect(preview).toHaveLength(SOURCE_PREVIEW_CHAR_LIMIT);
    expect(preview?.endsWith(" [truncated]")).toBe(true);
    expect(preview).not.toContain("\n");
    expect(preview).not.toContain("  ");
  });

  it("returns no preview for empty or missing extracted text", () => {
    expect(buildSourcePreview(null)).toBeNull();
    expect(buildSourcePreview(undefined)).toBeNull();
    expect(buildSourcePreview(" \n\t ")).toBeNull();
  });
});
