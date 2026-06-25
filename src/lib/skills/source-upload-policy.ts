export const SOURCE_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

export const MAX_SOURCE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SOURCE_UPLOAD_MIME_TYPE_ERROR = "Upload a PNG, JPEG, WebP, or PDF file.";
export const SOURCE_UPLOAD_MAX_BYTES_ERROR = "Upload a file smaller than 10 MB.";

export type SourceUploadMimeType = (typeof SOURCE_UPLOAD_MIME_TYPES)[number];

export function isSourceUploadMimeType(mimeType: string): mimeType is SourceUploadMimeType {
  return SOURCE_UPLOAD_MIME_TYPES.includes(mimeType as SourceUploadMimeType);
}
