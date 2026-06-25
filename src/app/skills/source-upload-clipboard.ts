import {
  MAX_SOURCE_UPLOAD_BYTES,
  SOURCE_UPLOAD_MAX_BYTES_ERROR,
  SOURCE_UPLOAD_MIME_TYPE_ERROR,
  isSourceUploadMimeType,
} from "@/lib/skills/source-upload-policy";

type ClipboardFileItem = {
  kind?: string;
  getAsFile?: () => File | null;
};

type ClipboardFileData = {
  items?: ArrayLike<ClipboardFileItem>;
  files?: ArrayLike<File>;
};

export type SourceUploadFileError = {
  field: "mimeType" | "byteSize";
  message: string;
};

const pastedFileNameByMimeType = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);

const genericClipboardFileNamePattern = /^(?:image|clipboard|pasted-image)\.(?:png|jpe?g|webp|pdf)$/i;

export function getClipboardSourceFile(
  clipboardData: ClipboardFileData | null,
  now = new Date(),
): File | null {
  const file = getClipboardFile(clipboardData);
  return file ? normalizePastedSourceFile(file, now) : null;
}

export function getSourceUploadFileError(file: File): SourceUploadFileError | null {
  if (!isSourceUploadMimeType(file.type)) {
    return {
      field: "mimeType",
      message: SOURCE_UPLOAD_MIME_TYPE_ERROR,
    };
  }

  if (file.size > MAX_SOURCE_UPLOAD_BYTES) {
    return {
      field: "byteSize",
      message: SOURCE_UPLOAD_MAX_BYTES_ERROR,
    };
  }

  return null;
}

function getClipboardFile(clipboardData: ClipboardFileData | null): File | null {
  if (!clipboardData) {
    return null;
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile?.();

    if (file) {
      return file;
    }
  }

  return Array.from(clipboardData.files ?? [])[0] ?? null;
}

function normalizePastedSourceFile(file: File, now: Date): File {
  const name = file.name.trim();

  if (name && !genericClipboardFileNamePattern.test(name)) {
    return file;
  }

  const extension = pastedFileNameByMimeType.get(file.type) ?? "bin";
  return new File([file], `pasted-source-${formatPastedFileTimestamp(now)}.${extension}`, {
    lastModified: file.lastModified,
    type: file.type,
  });
}

function formatPastedFileTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "");
}
