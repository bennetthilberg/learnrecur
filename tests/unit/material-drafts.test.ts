import { expect, it } from "vitest";
import { emptyMaterialWebsiteDraft, materialWebsiteDraftSchema } from "@/lib/forms/material-drafts";

it("restores website selection metadata without fetching or retaining page bodies", () => {
  const value = { ...emptyMaterialWebsiteDraft, url: "https://example.com/book", selectedUrls: ["https://example.com/chapter"], discovery: {
    title: "Book", sourceUrl: "https://example.com/book", preferredPdf: null,
    pages: [{ title: "Chapter", url: "https://example.com/chapter", level: 1, body: "Not draft metadata" }],
  } };
  const restored = materialWebsiteDraftSchema.parse(value);
  expect(restored.selectedUrls).toEqual(value.selectedUrls);
  expect(restored.discovery?.pages[0]).not.toHaveProperty("body");
});

it.each(["javascript:alert(1)", "http://example.com/book", "not a URL"])("rejects unsafe restored links: %s", (url) => {
  expect(materialWebsiteDraftSchema.safeParse({ ...emptyMaterialWebsiteDraft, discovery: {
    title: "Book", sourceUrl: "https://example.com/book", pages: [], preferredPdf: { title: "PDF", url },
  } }).success).toBe(false);
});
