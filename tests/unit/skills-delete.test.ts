import { describe, expect, it } from "vitest";

import {
  getOrphanSourceFileIdsForSkillDelete,
  isSkillDeleteTitleConfirmed,
} from "@/lib/skills/delete";

describe("skill permanent delete helpers", () => {
  it("trims the submitted confirmation but requires the exact current title", () => {
    expect(
      isSkillDeleteTitleConfirmed({
        skillTitle: "Ser vs. estar",
        confirmationTitle: "  Ser vs. estar  ",
      }),
    ).toBe(true);
    expect(
      isSkillDeleteTitleConfirmed({
        skillTitle: "Ser vs. estar",
        confirmationTitle: "ser vs. estar",
      }),
    ).toBe(false);
    expect(
      isSkillDeleteTitleConfirmed({
        skillTitle: "Ser vs. estar",
        confirmationTitle: "Ser  vs. estar",
      }),
    ).toBe(false);
  });

  it("selects only final-ref source files as orphan delete candidates", () => {
    expect(
      getOrphanSourceFileIdsForSkillDelete([
        { sourceFileId: "source-final", referenceCount: 1 },
        { sourceFileId: "source-shared", referenceCount: 2 },
        { sourceFileId: "source-final", referenceCount: 1 },
      ]),
    ).toEqual(["source-final"]);
  });
});
