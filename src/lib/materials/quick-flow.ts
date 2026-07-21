import { MAX_SOURCE_UPLOAD_BYTES } from "@/lib/skills/source-upload-policy";

export const MAX_QUICK_PDF_PAGES = 20;

export type QuickPdfDisposition =
  | { route: "materials-required"; reason: "file-size" | "page-count" }
  | { route: "materials-recommended"; reason: "missing-focus" }
  | { route: "quick-allowed"; reason: null };

export function getQuickPdfDisposition(input: {
  byteSize: number;
  pageCount: number;
  focusNote: string | null | undefined;
}): QuickPdfDisposition {
  if (input.byteSize > MAX_SOURCE_UPLOAD_BYTES) {
    return { route: "materials-required", reason: "file-size" };
  }

  if (input.pageCount > MAX_QUICK_PDF_PAGES) {
    return { route: "materials-required", reason: "page-count" };
  }

  if ((input.focusNote ?? "").trim().length < 12) {
    return { route: "materials-recommended", reason: "missing-focus" };
  }

  return { route: "quick-allowed", reason: null };
}
