"use client";

import { useId, useRef, useState, useTransition } from "react";
import type React from "react";
import { useRouter } from "next/navigation";

import {
  completeSourceUploadAction,
  prepareSourceUploadAction,
  type PrepareSourceUploadActionResult,
} from "./actions";

const acceptedMimeTypes = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const maxUploadBytes = 10 * 1024 * 1024;

type UploadStatus = "idle" | "preparing" | "uploading" | "queueing" | "error";

export function SourceUploadForm() {
  const router = useRouter();
  const fileInputId = useId();
  const fileErrorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const submittingRef = useRef(false);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();

  const busy =
    isSubmitting ||
    status === "preparing" ||
    status === "uploading" ||
    status === "queueing" ||
    isPending;
  const fileError = fileErrorMessage(fieldErrors);

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
          <p className="eyebrow">Upload source</p>
          <h2>Use an image or PDF</h2>
        </div>
        <span className="skillPathBadge">Private file</span>
      </div>
      <p className="skillUploadIntro">
        Upload a small worksheet, notes photo, screenshot, or PDF. The file stays private;
        LearnRecur reads it and prepares one to three editable drafts.
      </p>

      <fieldset className="skillFormFieldset">
        <legend>Source file</legend>
        <div className="skillFormFieldsetBody">
          <div className="skillField">
            <span>File</span>
            <div className="skillFileControl">
              <input
                accept={acceptedMimeTypes.join(",")}
                aria-describedby={fileError ? fileErrorId : undefined}
                aria-invalid={hasFileError(fieldErrors) ? "true" : undefined}
                className="skillFileInput"
                id={fileInputId}
                name="sourceFile"
                onChange={(event) => {
                  setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null);
                }}
                required
                type="file"
              />
              <label className="secondaryButton skillFileButton" htmlFor={fileInputId}>
                Choose file
              </label>
              <span className="skillFileName" data-state={selectedFileName ? "selected" : "empty"}>
                {selectedFileName ?? "No file selected"}
              </span>
            </div>
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
          <span>Draft context</span>
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

      {message ? (
        <p
          className="skillFormMessage"
          data-tone={status === "error" ? "error" : "saved"}
          role="status"
        >
          {message}
        </p>
      ) : null}

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
      setStatus("error");
      setMessage(formatClientError(error));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(form: HTMLFormElement) {
    setMessage(null);
    setFieldErrors(undefined);

    const fileInput = form.elements.namedItem("sourceFile");
    const file =
      fileInput instanceof HTMLInputElement && fileInput.files?.length
        ? fileInput.files[0]
        : null;

    if (!file) {
      setStatus("error");
      setFieldErrors({
        originalName: ["Choose a file to upload."],
      });
      return;
    }

    if (!acceptedMimeTypes.includes(file.type)) {
      setStatus("error");
      setFieldErrors({
        mimeType: ["Upload a PNG, JPEG, WebP, or PDF file."],
      });
      return;
    }

    if (file.size > maxUploadBytes) {
      setStatus("error");
      setFieldErrors({
        byteSize: ["Upload a file smaller than 10 MB."],
      });
      return;
    }

    const formData = new FormData(form);
    formData.set("originalName", file.name);
    formData.set("mimeType", file.type);
    formData.set("byteSize", String(file.size));
    formData.delete("sourceFile");

    setStatus("preparing");
    const prepared = await prepareSourceUploadAction(formData);

    if (prepared.status !== "prepared") {
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
      setStatus("error");
      setMessage("The private upload failed. Check file upload settings, then try again.");
      return;
    }

    setStatus("queueing");
    setMessage("Upload complete. Draft preparation will start shortly.");
    const completed = await completeSourceUploadAction({
      sourceFileId: prepared.sourceFileId,
    });

    if (completed.status === "queued") {
      router.push(completed.redirectTo);
      return;
    }

    setStatus("error");
    setMessage(completed.message);
  }

  function handleActionError(result: Extract<PrepareSourceUploadActionResult, { status: "error" }>) {
    setStatus("error");
    setMessage(result.message);
    setFieldErrors(result.fieldErrors);
  }
}

function formatClientError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Upload failed before drafts could be created. Check the file and try again.";
}

function buttonText(status: UploadStatus) {
  switch (status) {
    case "preparing":
      return "Preparing upload";
    case "uploading":
      return "Uploading";
    case "queueing":
      return "Preparing drafts";
    default:
      return "Create drafts from file";
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
