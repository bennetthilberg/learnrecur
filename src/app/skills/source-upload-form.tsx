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
          <h2>Use an image or PDF.</h2>
        </div>
      </div>
      <p className="skillUploadIntro">
        Upload a small worksheet, notes photo, screenshot, or PDF. The file stays private in S3;
        LearnRecur processes it in the background and creates one or more editable drafts.
      </p>

      <div className="skillField">
        <span>File</span>
        <div className="skillFileControl">
          <input
            accept={acceptedMimeTypes.join(",")}
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
          <span className="skillFileName">{selectedFileName ?? "No file selected"}</span>
        </div>
        {fileErrorMessage(fieldErrors) ? <em>{fileErrorMessage(fieldErrors)}</em> : null}
      </div>

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

      <p className="skillUploadMeta">PNG, JPEG, WebP, or PDF. Maximum 10 MB.</p>

      {message ? (
        <p className="skillFormMessage" data-tone={status === "error" ? "error" : "saved"}>
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
      setMessage("S3 did not accept the upload. Check the bucket CORS settings and try again.");
      return;
    }

    setStatus("queueing");
    setMessage("Upload complete. Queueing source processing...");
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
      return "Preparing upload...";
    case "uploading":
      return "Uploading...";
    case "queueing":
      return "Queueing...";
    default:
      return "Upload and queue drafts";
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
  ...props
}: {
  label: string;
  name: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="skillField">
      <span>{label}</span>
      <input aria-invalid={error ? "true" : undefined} name={name} {...props} />
      {error ? <em>{error}</em> : null}
    </label>
  );
}

function SkillTextArea({
  label,
  name,
  error,
  ...props
}: {
  label: string;
  name: string;
  error?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="skillField">
      <span>{label}</span>
      <textarea aria-invalid={error ? "true" : undefined} name={name} {...props} />
      {error ? <em>{error}</em> : null}
    </label>
  );
}
