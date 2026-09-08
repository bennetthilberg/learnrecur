import { describe, expect, it } from "vitest";

import {
  agentCompleteMaterialUploadSchema,
  agentGetMaterialStatusSchema,
  agentImportMaterialUrlSchema,
  agentPrepareMaterialUploadSchema,
  agentRetryMaterialIngestionSchema,
} from "@/lib/agent-access/material-ingestion-contracts";
import { MAX_MATERIAL_PDF_BYTES } from "@/lib/materials/pdf-upload";
import { MAX_WEBSITE_REVISION_PAGES } from "@/lib/materials/contracts";

describe("agent material ingestion contracts", () => {
  it("accepts a bounded PDF preparation request", () => {
    expect(
      agentPrepareMaterialUploadSchema.parse({
        idempotency_key: "material-upload-1",
        title: "Spanish grammar notes",
        original_name: "chapter-4.pdf",
        mime_type: "application/pdf",
        byte_size: 4_096,
      }),
    ).toMatchObject({ title: "Spanish grammar notes", byte_size: 4_096 });
  });

  it("rejects non-PDF uploads, oversized files, and caller-owned storage fields", () => {
    expect(() =>
      agentPrepareMaterialUploadSchema.parse({
        idempotency_key: "material-upload-1",
        title: "Notes",
        original_name: "notes.txt",
        mime_type: "text/plain",
        byte_size: 10,
      }),
    ).toThrow();
    expect(() =>
      agentPrepareMaterialUploadSchema.parse({
        idempotency_key: "material-upload-1",
        title: "Notes",
        original_name: "notes.pdf",
        mime_type: "application/pdf",
        byte_size: MAX_MATERIAL_PDF_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      agentPrepareMaterialUploadSchema.parse({
        idempotency_key: "material-upload-1",
        title: "Notes",
        original_name: "notes.pdf",
        mime_type: "application/pdf",
        byte_size: 10,
        storage_key: "user-controlled/private-key",
      }),
    ).toThrow();
  });

  it("allows completion with the revision returned by preparation", () => {
    expect(
      agentCompleteMaterialUploadSchema.parse({
        idempotency_key: "material-complete-1",
        material_revision_id: "revision-1",
      }),
    ).toEqual({
      idempotency_key: "material-complete-1",
      material_revision_id: "revision-1",
    });
  });

  it("bounds URL imports and requires HTTPS", () => {
    expect(
      agentImportMaterialUrlSchema.parse({
        idempotency_key: "material-url-1",
        source_url: "https://textbook.example/chapter-1",
      }).source_url,
    ).toBe("https://textbook.example/chapter-1");
    expect(() =>
      agentImportMaterialUrlSchema.parse({
        idempotency_key: "material-url-1",
        source_url: "http://textbook.example/chapter-1",
      }),
    ).toThrow();
    expect(() =>
      agentImportMaterialUrlSchema.parse({
        idempotency_key: "material-url-1",
        source_url: "https://textbook.example/chapter-1",
        selected_urls: Array.from(
          { length: MAX_WEBSITE_REVISION_PAGES + 1 },
          (_, index) => `https://textbook.example/chapter-${index + 1}`,
        ),
      }),
    ).toThrow();
  });

  it("keeps status and retry reads narrow", () => {
    expect(
      agentGetMaterialStatusSchema.parse({ material_id: "material-1" }),
    ).toEqual({
      material_id: "material-1",
    });
    expect(
      agentRetryMaterialIngestionSchema.parse({
        idempotency_key: "material-retry-1",
        material_revision_id: "revision-1",
        material_id: "material-1",
      }),
    ).toMatchObject({ material_revision_id: "revision-1" });
    expect(() =>
      agentGetMaterialStatusSchema.parse({
        material_id: "material-1",
        storage_key: "private",
      }),
    ).toThrow();
  });
});
