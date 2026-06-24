import { describe, expect, it } from "vitest";

import {
  getClipboardSourceFile,
  getSourceUploadFileError,
  maxSourceUploadBytes,
} from "@/app/skills/source-upload-clipboard";

describe("source upload clipboard helpers", () => {
  it("turns generic pasted image names into stable source upload names", () => {
    const file = new File(["image-bytes"], "image.png", {
      lastModified: new Date("2026-06-24T12:00:00.000Z").getTime(),
      type: "image/png",
    });

    const pastedFile = getClipboardSourceFile(
      {
        items: [
          {
            kind: "file",
            getAsFile: () => file,
          },
        ],
        files: [],
      },
      new Date("2026-06-24T16:05:06.000Z"),
    );

    expect(pastedFile).toBeInstanceOf(File);
    expect(pastedFile?.name).toBe("pasted-source-2026-06-24-160506.png");
    expect(pastedFile?.type).toBe("image/png");
  });

  it("keeps descriptive pasted file names", () => {
    const file = new File(["image-bytes"], "worksheet-page-3.png", {
      type: "image/png",
    });

    expect(
      getClipboardSourceFile(
        {
          files: [file],
        },
        new Date("2026-06-24T16:05:06.000Z"),
      ),
    ).toBe(file);
  });

  it("validates pasted files with the same upload rules as selected files", () => {
    expect(getSourceUploadFileError(new File(["text"], "notes.txt", { type: "text/plain" }))).toEqual({
      field: "mimeType",
      message: "Upload a PNG, JPEG, WebP, or PDF file.",
    });

    expect(
      getSourceUploadFileError(
        new File(["x".repeat(maxSourceUploadBytes + 1)], "large.png", {
          type: "image/png",
        }),
      ),
    ).toEqual({
      field: "byteSize",
      message: "Upload a file smaller than 10 MB.",
    });
  });
});
