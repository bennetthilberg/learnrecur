import { PDFDocument } from "pdf-lib";
import { expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  throw new Error("PDF.js rendering dependencies are unavailable in the web function");
});

import { inspectPdfPageCount } from "@/lib/materials/pdf";

it("counts uploaded PDF pages without a rendering worker or native canvas", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  document.addPage();
  await expect(inspectPdfPageCount(Buffer.from(await document.save()))).resolves.toBe(2);
});

it("rejects content that is not a PDF", async () => {
  await expect(inspectPdfPageCount(Buffer.from("not a PDF"))).rejects.toThrow();
});
