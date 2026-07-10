export const MAX_MATERIAL_TITLE_LENGTH = 72;
export const MAX_MATERIAL_PDF_FILENAME_LENGTH = 255;
export const MAX_MATERIAL_PDF_BYTES = 100 * 1024 * 1024;

type MaterialPdfFieldErrors = Record<string, string[] | undefined> | undefined;

const MATERIAL_PDF_ERROR_FIELD_ORDER = [
  "title",
  "collectionId",
  "originalName",
  "mimeType",
  "byteSize",
] as const;

export function materialTitleFromPdfFileName(fileName: string) {
  const normalized = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateMaterialTitle(normalized);
}

export function truncateMaterialTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();

  if (normalized.length <= MAX_MATERIAL_TITLE_LENGTH) {
    return normalized;
  }

  const rawCandidate = normalized.slice(0, MAX_MATERIAL_TITLE_LENGTH);
  const candidate = rawCandidate.trimEnd();
  if (
    candidate.length < rawCandidate.length ||
    /\s/.test(normalized[MAX_MATERIAL_TITLE_LENGTH] ?? "")
  ) {
    return candidate;
  }
  const wordBreak = candidate.lastIndexOf(" ");

  return wordBreak >= Math.floor(MAX_MATERIAL_TITLE_LENGTH * 0.75)
    ? candidate.slice(0, wordBreak)
    : candidate;
}

export function materialPdfErrorMessage(
  fieldErrors: MaterialPdfFieldErrors,
  fallback: string,
) {
  for (const field of MATERIAL_PDF_ERROR_FIELD_ORDER) {
    const error = fieldErrors?.[field]?.find((message) => message.trim().length > 0);
    if (error) {
      return error;
    }
  }

  return fallback;
}

export function materialPdfFileErrorMessage(fieldErrors: MaterialPdfFieldErrors) {
  return (
    fieldErrors?.originalName?.[0] ??
    fieldErrors?.mimeType?.[0] ??
    fieldErrors?.byteSize?.[0] ??
    null
  );
}

export function validateMaterialPdfFile(file: {
  name: string;
  type: string;
  size: number;
}) {
  if (file.name.trim().length > MAX_MATERIAL_PDF_FILENAME_LENGTH) {
    return materialPdfFileNameTooLongMessage(file.name.trim().length);
  }
  if (file.type !== "application/pdf") {
    return materialPdfMimeTypeMessage(file.type);
  }
  if (file.size < 1) {
    return materialPdfEmptyMessage;
  }
  if (file.size > MAX_MATERIAL_PDF_BYTES) {
    return materialPdfTooLargeMessage;
  }

  return null;
}

export function materialTitleTooLongMessage(length: number) {
  return `The material title is ${length.toLocaleString("en-US")} characters. Shorten it to ${MAX_MATERIAL_TITLE_LENGTH} characters or fewer.`;
}

export function materialPdfFileNameTooLongMessage(length: number) {
  return `The PDF filename is ${length.toLocaleString("en-US")} characters. Rename it to ${MAX_MATERIAL_PDF_FILENAME_LENGTH} characters or fewer, then choose it again.`;
}

export function materialPdfMimeTypeMessage(mimeType: string) {
  return mimeType
    ? `This file was reported as ${mimeType}, not a PDF. Choose a PDF file.`
    : "The browser could not confirm that this is a PDF. Choose the file again, or save it as a PDF first.";
}

export const materialPdfEmptyMessage =
  "This PDF is empty. Choose a PDF that contains pages and try again.";

export const materialPdfTooLargeMessage =
  "This PDF is over the 100 MB limit. Choose a smaller PDF and try again.";
