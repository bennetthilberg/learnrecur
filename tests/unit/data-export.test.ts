import { describe, expect, it } from "vitest";

import {
  buildUserDataExportFilename,
  serializeExportDate,
  toExportSourceFile,
} from "@/lib/settings/data-export";

describe("study data export helpers", () => {
  it("serializes dates to stable ISO strings", () => {
    expect(serializeExportDate(new Date("2026-06-07T14:15:16.789Z"))).toBe(
      "2026-06-07T14:15:16.789Z",
    );
    expect(serializeExportDate(null)).toBeNull();
  });

  it("builds deterministic dated export filenames", () => {
    expect(buildUserDataExportFilename(new Date("2026-06-07T23:59:59.000Z"))).toBe(
      "learnrecur-export-2026-06-07.json",
    );
  });

  it("omits storage location fields from exported source files", () => {
    const exported = toExportSourceFile({
      id: "source_1",
      collectionId: "collection_1",
      kind: "PDF",
      status: "READY",
      originalName: "worksheet.pdf",
      mimeType: "application/pdf",
      byteSize: 1234,
      storageBucket: "learnrecur-dev",
      storageKey: "source-uploads/user/source.pdf",
      publicUrl: "https://storage.example/source.pdf",
      extractedText: "Stored study text.",
      metadata: {
        label: "Worksheet",
        objectKey: "source-uploads/user/source.pdf",
        nested: {
          storageBucket: "learnrecur-dev",
          publicUrl: "https://storage.example/source.pdf",
        },
      },
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
      updatedAt: new Date("2026-06-01T11:00:00.000Z"),
    });

    expect(exported).toEqual({
      id: "source_1",
      collectionId: "collection_1",
      kind: "PDF",
      status: "READY",
      originalName: "worksheet.pdf",
      mimeType: "application/pdf",
      byteSize: 1234,
      extractedText: "Stored study text.",
      metadata: {
        label: "Worksheet",
        nested: {},
      },
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T11:00:00.000Z",
    });
    expect("storageBucket" in exported).toBe(false);
    expect("storageKey" in exported).toBe(false);
    expect("publicUrl" in exported).toBe(false);
  });
});
