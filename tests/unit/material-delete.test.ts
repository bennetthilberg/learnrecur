import { describe, expect, it } from "vitest";

import { getMaterialDeletionReturnPath } from "@/lib/materials/material-delete";

describe("material deletion return path", () => {
  it.each([
    "/skills/materials",
    "/skills/new/multiple",
  ] as const)("allows the known material screen %s", (path) => {
    expect(getMaterialDeletionReturnPath(path)).toBe(path);
  });

  it.each(["", "/dashboard", "https://example.com", "//example.com"])(
    "falls back safely for %s",
    (path) => {
      expect(getMaterialDeletionReturnPath(path)).toBe("/skills/materials");
    },
  );
});
