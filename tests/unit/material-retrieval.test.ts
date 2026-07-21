import { describe, expect, it } from "vitest";

import { toSimplePrefixTsQuery } from "@/lib/materials/retrieval";

describe("material lexical retrieval", () => {
  it("matches language-neutral word variants for focused topic searches", () => {
    expect(toSimplePrefixTsQuery("reflexive verb")).toBe("reflexive:* & verb:*");
    expect(toSimplePrefixTsQuery("prepositional pronouns")).toBe(
      "prepositional:* & pronouns:*",
    );
  });

  it("normalizes punctuation and accents without creating tsquery syntax", () => {
    expect(toSimplePrefixTsQuery("  Números: 21–99! ")).toBe(
      "números:* & 21:* & 99:*",
    );
    expect(toSimplePrefixTsQuery("!? ")).toBe("");
  });
});
