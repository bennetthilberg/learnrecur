import { expect, it } from "vitest";
import { customExerciseCount, matchingCustomSkills, type CustomSetupDraft } from "@/lib/practice/custom-setup";
const filters: CustomSetupDraft = { mode: "PRACTICE_ONLY", targetCount: "10", collectionId: "", selectedTags: [], selectedSkills: [], recentlyMissed: false };
const skills = [
  { id: "a", title: "Due", collectionId: "c", tags: ["spanish", "verbs"], dueAt: "2026-01-01", recentlyMissed: true },
  { id: "b", title: "Future", collectionId: "c", tags: ["spanish"], dueAt: "2027-01-01", recentlyMissed: false },
  { id: "d", title: "Other", collectionId: null, tags: [], dueAt: null, recentlyMissed: true },
];
it("combines filters with all-tags semantics and due-only scheduled review", () => {
  expect(matchingCustomSkills(skills, filters, Date.parse("2026-06-01"))).toHaveLength(3);
  expect(matchingCustomSkills(skills, { ...filters, collectionId: "c", selectedTags: ["spanish", "verbs"], recentlyMissed: true }, Date.now())).toEqual([skills[0]]);
  expect(matchingCustomSkills(skills, { ...filters, mode: "SCHEDULED" }, Date.parse("2026-06-01"))).toEqual([skills[0]]);
  expect(matchingCustomSkills(skills, { ...filters, collectionId: "missing" }, Date.now())).toEqual([]);
});
it("allows editing an empty count but only accepts whole counts from 1 to 100", () => {
  for (const value of ["", "0", "101", "1.5", "wrong"]) expect(customExerciseCount(value)).toBeNull();
  expect(customExerciseCount("10")).toBe(10);
  expect(customExerciseCount("100")).toBe(100);
});
