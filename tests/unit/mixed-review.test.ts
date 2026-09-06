import { describe, expect, it } from "vitest";
import {
  selectMixedReviewSkill,
  type MixedReviewSkill,
} from "@/lib/practice/mixed-review";
const skill = (
  id: string,
  day = 5,
  collectionId = "spanish",
  tags = ["grammar"],
): MixedReviewSkill => ({
  id,
  collectionId,
  tags,
  objective: null,
  dueAt: new Date(`2026-09-0${day}T12:00Z`),
});
describe("mixed review selection", () => {
  it("varies compatible due skills within the earliest due day", () => {
    expect(
      selectMixedReviewSkill([skill("old"), skill("varied")], skill("old"))?.id,
    ).toBe("varied");
  });
  it("skips same-day foreign candidates when a compatible alternative exists", () => {
    expect(
      selectMixedReviewSkill(
        [skill("foreign", 5, "math", ["math"]), skill("compatible", 5)],
        skill("previous"),
      )?.id,
    ).toBe("compatible");
  });
  it("keeps older overdue work first and falls back for insufficient alternatives", () => {
    expect(
      selectMixedReviewSkill(
        [skill("urgent", 4, "math", ["math"]), skill("other")],
        skill("prior"),
      )?.id,
    ).toBe("urgent");
    expect(selectMixedReviewSkill([skill("only")], skill("only"))?.id).toBe(
      "only",
    );
    expect(selectMixedReviewSkill([], skill("prior"))).toBeNull();
  });
});
