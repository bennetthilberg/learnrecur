"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type React from "react";
import { useRouter } from "next/navigation";
import { UploadSimple } from "@phosphor-icons/react";

import {
  completeSourceUploadAction,
  prepareSourceUploadAction,
  type PrepareSourceUploadActionResult,
} from "./actions";
import { SOURCE_UPLOAD_MIME_TYPES } from "@/lib/skills/source-upload-policy";
import type {
  SourceCreationNotice,
  SourceGenerationStatus,
} from "./source-creation-workspace";
import { getClipboardSourceFile, getSourceUploadFileError } from "./source-upload-clipboard";

type SourceUploadFormProps = {
  onGenerationEnd?: () => void;
  onGenerationStart?: (status: SourceGenerationStatus) => void;
  onNotice?: (notice: SourceCreationNotice | null) => void;
};

type UploadStatus = "idle" | "preparing" | "uploading" | "generating" | "error";

export function SourceUploadForm({
  onGenerationEnd,
  onGenerationStart,
  onNotice,
}: SourceUploadFormProps) {
  const router = useRouter();
  const fileInputId = useId();
  const fileErrorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();

  const busy =
    isSubmitting ||
    status === "preparing" ||
    status === "uploading" ||
    status === "generating" ||
    isPending;
  const fileError = fileErrorMessage(fieldErrors);
  const selectUploadFile = useCallback((file: File, successMessage: string | null = null) => {
    const fileError = getSourceUploadFileError(file);

    if (fileError) {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      setSelectedFileName(null);
      setStatus("error");
      onNotice?.({
        tone: "error",
        message: fileError.message,
      });
      setFieldErrors({
        [fileError.field]: [fileError.message],
      });
      return false;
    }

    if (!fileInputRef.current) {
      return false;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInputRef.current.files = transfer.files;
    setSelectedFileName(file.name);
    setStatus("idle");
    if (successMessage) {
      onNotice?.({
        tone: "success",
        message: successMessage,
      });
    }
    setFieldErrors(undefined);
    return true;
  }, [onNotice]);

  useEffect(() => {
    function handleDocumentPaste(event: ClipboardEvent) {
      if (busy) {
        return;
      }

      const pastedFile = getClipboardSourceFile(event.clipboardData);

      if (!pastedFile) {
        return;
      }

      event.preventDefault();
      selectUploadFile(pastedFile, "Pasted file added. Create the skill when ready.");
    }

    document.addEventListener("paste", handleDocumentPaste);

    return () => {
      document.removeEventListener("paste", handleDocumentPaste);
    };
  }, [busy, selectUploadFile]);

  return (
    <form
      className="skillPanel skillUploadForm"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;

        if (submittingRef.current) {
          return;
        }

        submittingRef.current = true;
        setIsSubmitting(true);
        startTransition(() => {
          void submitForm(form);
        });
      }}
    >
      <div className="skillPanelHeader">
        <div>
          <h2>Use an image or PDF</h2>
        </div>
        <span className="skillPanelHeaderIcon" aria-hidden="true">
          <UploadSimple size={18} weight="bold" />
        </span>
      </div>
      <p className="skillUploadIntro">
        Upload a small worksheet, notes photo, screenshot, or PDF. You will review
        the generated skill before adding it.
      </p>

      <fieldset className="skillFormFieldset">
        <legend>Source file</legend>
        <div className="skillFormFieldsetBody">
          <div className="skillField">
            <span>File</span>
            <label
              className="skillFileControl skillFileDropzone"
              data-dragging={isDraggingFile ? "true" : "false"}
              htmlFor={fileInputId}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDraggingFile(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();

                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setIsDraggingFile(false);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDraggingFile(false);

                const file = event.dataTransfer.files.item(0);

                if (!file || !fileInputRef.current) {
                  return;
                }

                selectUploadFile(file);
              }}
            >
              <input
                accept={SOURCE_UPLOAD_MIME_TYPES.join(",")}
                aria-describedby={fileError ? fileErrorId : undefined}
                aria-invalid={hasFileError(fieldErrors) ? "true" : undefined}
                className="skillFileInput"
                id={fileInputId}
                name="sourceFile"
                onChange={(event) => {
                  setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null);
                  setStatus("idle");
                  onNotice?.(null);
                  setFieldErrors(undefined);
                }}
                ref={fileInputRef}
                required
                type="file"
              />
              <span className="skillFileDropzoneIcon" aria-hidden="true">
                <UploadSimple aria-hidden="true" size={19} weight="bold" />
              </span>
              <span className="secondaryButton skillFileButton">
                Choose file
              </span>
              <span className="skillFileDropzoneText">Drag a file here, or paste a screenshot.</span>
              <span className="skillFileName" data-state={selectedFileName ? "selected" : "empty"}>
                {selectedFileName ?? "No file selected"}
              </span>
            </label>
            {fileError ? <em id={fileErrorId}>{fileError}</em> : null}
          </div>
          <p className="skillUploadMeta">PNG, JPEG, WebP, or PDF. Maximum 10 MB.</p>
        </div>
      </fieldset>

      <details
        className="skillFormDetails"
        open={
          fieldErrors?.sourceLabel?.length ||
            fieldErrors?.collectionName?.length ||
            fieldErrors?.focusNote?.length ||
            fieldErrors?.tags?.length
            ? true
            : undefined
        }
      >
        <summary>
          <span>Optional context</span>
          <small>Collection, focus, and tags</small>
        </summary>
        <div className="skillFormFieldsetBody">
          <div className="skillTwoColumnFields">
            <SkillTextField
              error={fieldErrors?.sourceLabel?.[0]}
              label="Source label"
              name="sourceLabel"
              placeholder="Worksheet page 3"
            />
            <SkillTextField
              error={fieldErrors?.collectionName?.[0]}
              label="Collection"
              name="collectionName"
              placeholder="Spanish grammar"
            />
          </div>

          <SkillTextArea
            error={fieldErrors?.focusNote?.[0]}
            label="Focus note"
            name="focusNote"
            placeholder="Focus on the grammar rules, not the vocabulary list."
            rows={3}
          />

          <SkillTextField
            error={fieldErrors?.tags?.[0]}
            label="Tags"
            name="tags"
            placeholder="spanish, worksheet, grammar"
          />
        </div>
      </details>

      <div className="skillFormActions">
        <button className="primaryButton" disabled={busy} type="submit">
          {buttonText(status)}
        </button>
      </div>
    </form>
  );

  async function submitForm(form: HTMLFormElement) {
    try {
      await handleSubmit(form);
    } catch (error) {
      onGenerationEnd?.();
      setStatus("error");
      onNotice?.({
        tone: "error",
        message: formatClientError(error),
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(form: HTMLFormElement) {
    onNotice?.(null);
    setFieldErrors(undefined);

    const fileInput = form.elements.namedItem("sourceFile");
    const file =
      fileInput instanceof HTMLInputElement && fileInput.files?.length
        ? fileInput.files[0]
        : null;

    if (!file) {
      onGenerationEnd?.();
      setStatus("error");
      setFieldErrors({
        originalName: ["Choose a file to upload."],
      });
      onNotice?.({
        tone: "error",
        message: "Choose a file to upload.",
      });
      return;
    }

    const fileError = getSourceUploadFileError(file);

    if (fileError) {
      onGenerationEnd?.();
      setStatus("error");
      setFieldErrors({
        [fileError.field]: [fileError.message],
      });
      onNotice?.({
        tone: "error",
        message: fileError.message,
      });
      return;
    }

    const formData = new FormData(form);
    formData.set("originalName", file.name);
    formData.set("mimeType", file.type);
    formData.set("byteSize", String(file.size));
    formData.delete("sourceFile");

    onGenerationStart?.({
      title: "Creating a skill from your file",
      detail: "Uploading the source material, then Gemini will read it and write a focused skill.",
    });
    setStatus("preparing");
    const prepared = await prepareSourceUploadAction(formData);

    if (prepared.status !== "prepared") {
      onGenerationEnd?.();
      handleActionError(prepared);
      return;
    }

    setStatus("uploading");
    const uploadResponse = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: prepared.headers,
      body: file,
    });

    if (!uploadResponse.ok) {
      onGenerationEnd?.();
      setStatus("error");
      onNotice?.({
        tone: "error",
        message: "The private upload failed. Check file upload settings, then try again.",
      });
      return;
    }

    setStatus("generating");
    onNotice?.(null);
    const completed = await completeSourceUploadAction({
      sourceFileId: prepared.sourceFileId,
    });

    if (completed.status === "created") {
      router.push(completed.redirectTo);
      return;
    }

    onGenerationEnd?.();
    setStatus("error");
    onNotice?.({
      tone: "error",
      message: completed.message,
    });
  }

  function handleActionError(result: Extract<PrepareSourceUploadActionResult, { status: "error" }>) {
    setStatus("error");
    onNotice?.({
      tone: "error",
      message: result.message,
    });
    setFieldErrors(result.fieldErrors);
  }
}

function formatClientError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Upload failed before the skill could be created. Check the file and try again.";
}

function buttonText(status: UploadStatus) {
  switch (status) {
    case "preparing":
      return "Preparing upload";
    case "uploading":
      return "Uploading";
    case "generating":
      return "Creating skill";
    default:
      return "Create skill from file";
  }
}

function hasFileError(fieldErrors: Record<string, string[]> | undefined) {
  return Boolean(fileErrorMessage(fieldErrors));
}

function fileErrorMessage(fieldErrors: Record<string, string[]> | undefined) {
  return (
    fieldErrors?.originalName?.[0] ?? fieldErrors?.mimeType?.[0] ?? fieldErrors?.byteSize?.[0] ?? null
  );
}

function SkillTextField({
  label,
  name,
  error,
  "aria-describedby": ariaDescribedBy,
  ...props
}: {
  label: string;
  name: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const errorId = useId();
  const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <label className="skillField">
      <span>{label}</span>
      <input
        aria-describedby={describedBy}
        aria-invalid={error ? "true" : undefined}
        name={name}
        {...props}
      />
      {error ? <em id={errorId}>{error}</em> : null}
    </label>
  );
}

function SkillTextArea({
  label,
  name,
  error,
  "aria-describedby": ariaDescribedBy,
  ...props
}: {
  label: string;
  name: string;
  error?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const errorId = useId();
  const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <label className="skillField">
      <span>{label}</span>
      <textarea
        aria-describedby={describedBy}
        aria-invalid={error ? "true" : undefined}
        name={name}
        {...props}
      />
      {error ? <em id={errorId}>{error}</em> : null}
    </label>
  );
}
