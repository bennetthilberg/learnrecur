import { z } from "zod";

import {
  MAX_MATERIAL_PDF_BYTES,
  MAX_MATERIAL_PDF_FILENAME_LENGTH,
  MAX_MATERIAL_TITLE_LENGTH,
} from "@/lib/materials/pdf-upload";
import {
  MAX_WEBSITE_REVISION_PAGES,
  httpsUrlSchema,
} from "@/lib/materials/contracts";

const identifierSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const collectionIdSchema = identifierSchema.nullable().optional();

/**
 * Prepare one reusable PDF material and return a private upload lease.
 *
 * The agent never supplies a storage key. The server derives it from the
 * user, material, revision, and sanitized filename after ownership checks.
 */
export const agentPrepareMaterialUploadSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  title: z.string().trim().min(1).max(MAX_MATERIAL_TITLE_LENGTH),
  collection_id: collectionIdSchema,
  original_name: z.string().trim().min(1).max(MAX_MATERIAL_PDF_FILENAME_LENGTH),
  mime_type: z.literal("application/pdf"),
  byte_size: z.number().int().min(1).max(MAX_MATERIAL_PDF_BYTES),
});

/** Complete the upload created by materials.prepare_upload. */
export const agentCompleteMaterialUploadSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  material_revision_id: identifierSchema,
  material_id: identifierSchema.optional(),
  source_file_id: identifierSchema.optional(),
  operation_id: identifierSchema.optional(),
});

/**
 * Import a public HTTPS textbook page or same-origin page selection into the
 * reusable material library. When selected_urls is omitted, the server uses
 * its bounded, SSRF-safe discovery result and selects the discovered pages.
 */
export const agentImportMaterialUrlSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  title: z.string().trim().min(1).max(MAX_MATERIAL_TITLE_LENGTH).optional(),
  collection_id: collectionIdSchema,
  source_url: httpsUrlSchema,
  selected_urls: z
    .array(httpsUrlSchema)
    .min(1)
    .max(MAX_WEBSITE_REVISION_PAGES)
    .optional(),
});

/** Read processing state for one owned material revision. */
export const agentGetMaterialStatusSchema = z.strictObject({
  material_id: identifierSchema,
  expected_revision_id: identifierSchema.optional(),
});

/** Retry a failed or stalled owned material revision. */
export const agentRetryMaterialIngestionSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  material_revision_id: identifierSchema,
  material_id: identifierSchema.optional(),
  operation_id: identifierSchema.optional(),
});

export type AgentPrepareMaterialUploadInput = z.infer<
  typeof agentPrepareMaterialUploadSchema
>;
export type AgentCompleteMaterialUploadInput = z.infer<
  typeof agentCompleteMaterialUploadSchema
>;
export type AgentImportMaterialUrlInput = z.infer<
  typeof agentImportMaterialUrlSchema
>;
export type AgentGetMaterialStatusInput = z.infer<
  typeof agentGetMaterialStatusSchema
>;
export type AgentRetryMaterialIngestionInput = z.infer<
  typeof agentRetryMaterialIngestionSchema
>;

// Keep the shorter aliases available to MCP registration code and callers that
// refer to material uploads without the tool-specific suffix.
export const agentPrepareMaterialSchema = agentPrepareMaterialUploadSchema;
export const agentCompleteMaterialSchema = agentCompleteMaterialUploadSchema;
export const agentImportMaterialSchema = agentImportMaterialUrlSchema;
export const agentMaterialStatusSchema = agentGetMaterialStatusSchema;
export const agentRetryMaterialSchema = agentRetryMaterialIngestionSchema;
