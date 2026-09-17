import { z } from "zod";

export const sourceCreationDraftSchema = z.object({
  pendingFileNames: z.array(z.string().max(1000)).max(1000),
  sourceText: z.string().max(100_000), sourceLabel: z.string().max(1000),
  collectionName: z.string().max(1000), focusNote: z.string().max(20_000),
  tags: z.string().max(5000), recoveredSourceFileId: z.string().max(200),
});

// Names are reminders only; the browser's actual File objects remain the upload source.
export function missingDraftFiles(expected: string[], selected: string[]): string[] {
  const remaining = [...selected];
  return expected.filter((name) => {
    const index = remaining.indexOf(name);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function reconcileDraftFiles(expected: string[], selected: string[]): string[] {
  return [...expected, ...missingDraftFiles(selected, expected)];
}
