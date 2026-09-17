import { describe, expect, it } from "vitest";
import { filterLibraryItems, parseLibraryFilters } from "@/lib/skills/library-filters";

const skills = [
  { title: "Ser vs estar", status: "ACTIVE", collectionId: "spanish" },
  { title: "Past tense", status: "PAUSED", collectionId: "spanish" },
  { title: "Linear equations", status: "ARCHIVED", collectionId: null },
];
describe("library filters", () => {
  it("combines title, collection and status without changing order", () => {
    expect(filterLibraryItems(skills, { query: "  SER VS  ", collection: "spanish", status: "ACTIVE" })).toEqual([skills[0]]);
    expect(filterLibraryItems(skills, { query: "", collection: "spanish", status: "ALL" })).toEqual(skills.slice(0, 2));
    expect(filterLibraryItems(skills, { query: "", collection: "uncollected", status: "ARCHIVED" })).toEqual([skills[2]]);
  });
  it("defaults invalid URL statuses and preserves a literal search", () => {
    expect(parseLibraryFilters(new URLSearchParams("status=invalid&q=%25&collection=x"))).toEqual({ query: "%", status: "ACTIVE", collection: "x" });
    expect(filterLibraryItems(skills, { query: "missing", collection: "", status: "ALL" })).toEqual([]);
  });
});
