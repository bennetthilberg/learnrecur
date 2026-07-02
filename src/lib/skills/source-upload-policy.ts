export const SOURCE_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

export const MAX_SOURCE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_UPLOAD_FILES = 5;
export const MAX_TOTAL_SOURCE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_UPLOAD_LABEL_LENGTH = 160;
export const SOURCE_UPLOAD_MIME_TYPE_ERROR = "Upload a PNG, JPEG, WebP, or PDF file.";
export const SOURCE_UPLOAD_MAX_BYTES_ERROR = "Upload a file smaller than 10 MB.";
export const SOURCE_UPLOAD_MAX_FILES_ERROR = "Upload up to 5 files.";
export const SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR =
  "Upload files totaling 20 MB or less.";

export type SourceUploadMimeType = (typeof SOURCE_UPLOAD_MIME_TYPES)[number];

export function isSourceUploadMimeType(mimeType: string): mimeType is SourceUploadMimeType {
  return SOURCE_UPLOAD_MIME_TYPES.includes(mimeType as SourceUploadMimeType);
}

export function buildSourceUploadFileLabel(
  sourceLabel: string,
  fileIndex: number,
  fileCount: number,
) {
  if (!sourceLabel || fileCount <= 1) {
    return sourceLabel;
  }

  const suffix = ` ${fileIndex + 1}`;
  const maxBaseLength = MAX_SOURCE_UPLOAD_LABEL_LENGTH - suffix.length;
  const baseLabel =
    sourceLabel.length > maxBaseLength ? sourceLabel.slice(0, maxBaseLength).trimEnd() : sourceLabel;

  return `${baseLabel}${suffix}`;
}
