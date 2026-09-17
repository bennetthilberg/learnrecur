import { expect, it } from "vitest";
import { missingDraftFiles, reconcileDraftFiles } from "@/lib/forms/creation-drafts";

it("keeps unselected restored files when only part of a selection is restored", () => {
  const names = reconcileDraftFiles(["worksheet.png", "notes.png"], ["worksheet.png"]);
  expect(names).toEqual(["worksheet.png", "notes.png"]);
  expect(missingDraftFiles(names, ["worksheet.png"])).toEqual(["notes.png"]);
});

it("accounts for files with identical names and newly selected files", () => {
  expect(missingDraftFiles(["page.png", "page.png"], ["page.png"])).toEqual(["page.png"]);
  expect(reconcileDraftFiles(["page.png"], ["page.png", "page.png", "new.png"])).toEqual(["page.png", "page.png", "new.png"]);
  expect(missingDraftFiles(["page.png"], ["page.png", "new.png"])).toEqual([]);
});
