"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type React from "react";
import { CheckCircle, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";
import { useRouter } from "next/navigation";

import { SOURCE_UPLOAD_MIME_TYPES } from "@/lib/skills/source-upload-policy";

import {
  completeSourceUploadAction,
  generateSkillDraftFromSourceAction,
  prepareSourceUploadAction,
  type PrepareSourceUploadActionResult,
  type SkillFormActionState,
} from "./actions";
import { getClipboardSourceFile, getSourceUploadFileError } from "./source-upload-clipboard";

export type SourceGenerationStatus = {
  title: string;
  detail: string;
};

export type SourceCreationNotice = {
  tone: "error" | "success";
  message: string;
};

type UploadStatus = "idle" | "preparing" | "uploading" | "generating" | "error";

const sourceCreationNotificationId = "source-creation-notice";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const defaultGenerationStatus: SourceGenerationStatus = {
  title: "Creating your skill",
  detail: "Reading your material and turning it into a focused practice skill.",
};

export function SourceCreationWorkspace() {
  const router = useRouter();
  const fileInputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [textState, textAction, isGeneratingFromText] = useActionState(
    generateSkillDraftFromSourceAction,
    idleState,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [isSubmittingUpload, setIsSubmittingUpload] = useState(false);
  const [isPendingUpload, startUploadTransition] = useTransition();

  const uploadBusy =
    isSubmittingUpload ||
    isPendingUpload ||
    uploadStatus === "preparing" ||
    uploadStatus === "uploading" ||
    uploadStatus === "generating";
  const busy = isGeneratingFromText || uploadBusy;
  const generationStatus = getGenerationStatus({
    isGeneratingFromText,
    uploadBusy,
    uploadStatus,
  });
  const activeFieldErrors =
    textState.status === "error" ? textState.fieldErrors ?? fieldErrors : fieldErrors;

  const showNotice = useCallback((nextNotice: SourceCreationNotice | null) => {
    notifications.hide(sourceCreationNotificationId);

    if (!nextNotice) {
      return;
    }

    notifications.show({
      id: sourceCreationNotificationId,
      autoClose: nextNotice.tone === "error" ? 8000 : 4500,
      className: "learnrecurNotification",
      color: nextNotice.tone === "error" ? "amber" : "leaf",
      icon:
        nextNotice.tone === "error" ? (
          <WarningCircle size={18} weight="bold" />
        ) : (
          <CheckCircle size={18} weight="bold" />
        ),
      message: nextNotice.message,
      position: "top-right",
      title: nextNotice.tone === "error" ? "Could not create skill" : "Ready",
      withBorder: true,
      withCloseButton: true,
    });
  }, []);

  const selectUploadFile = useCallback((file: File, successMessage: string | null = null) => {
    const fileError = getSourceUploadFileError(file);

    if (fileError) {
      clearFileInput(fileInputRef.current);
      setSelectedFile(null);
      setUploadStatus("error");
      setFieldErrors({
        [fileError.field]: [fileError.message],
      });
      showNotice({
        tone: "error",
        message: fileError.message,
      });
      return false;
    }

    if (!fileInputRef.current) {
      return false;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInputRef.current.files = transfer.files;
    setSelectedFile(file);
    setUploadStatus("idle");
    setFieldErrors(undefined);

    if (successMessage) {
      showNotice({
        tone: "success",
        message: successMessage,
      });
    }

    return true;
  }, [showNotice]);

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
      selectUploadFile(pastedFile, "Pasted file added.");
    }

    document.addEventListener("paste", handleDocumentPaste);

    return () => {
      document.removeEventListener("paste", handleDocumentPaste);
    };
  }, [busy, selectUploadFile]);

  useEffect(() => {
    if (!textState.message || textState.status === "idle") {
      return;
    }

    if (textState.status === "error") {
      showNotice({
        tone: "error",
        message: textState.message,
      });
    }
  }, [showNotice, textState.message, textState.status]);

  if (generationStatus) {
    return <SourceGenerationPanel status={generationStatus} />;
  }

  return (
    <form
      action={textAction}
      className="skillCreateStack"
      onSubmit={(event) => {
        if (selectedFile) {
          event.preventDefault();

          if (uploadBusy) {
            return;
          }

          const form = event.currentTarget;
          setIsSubmittingUpload(true);
          startUploadTransition(() => {
            void submitUpload(form);
          });
          return;
        }

        setFieldErrors(undefined);
        showNotice(null);
      }}
      ref={formRef}
    >
      <section className="skillPanel createSkillPanel" aria-labelledby="create-skill-input-title">
        <div className="createSkillPanelHeader">
          <h2 id="create-skill-input-title">Add learning material</h2>
          <button
            className="secondaryButton createSkillFileButton"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <UploadSimple size={16} weight="bold" aria-hidden="true" />
            <span>Choose file</span>
          </button>
        </div>

        <div
          className="createSkillInputBox"
          data-dragging={isDraggingFile ? "true" : "false"}
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

            if (file) {
              selectUploadFile(file);
            }
          }}
        >
          <textarea
            aria-describedby="create-skill-input-help"
            aria-invalid={activeFieldErrors?.sourceText ? "true" : undefined}
            className="createSkillTextarea"
            disabled={busy}
            name="sourceText"
            placeholder="Paste notes, describe the skill, or drop a worksheet here."
            rows={10}
          />
          <input
            aria-hidden="true"
            accept={SOURCE_UPLOAD_MIME_TYPES.join(",")}
            className="skillFileInput"
            id={fileInputId}
            name="sourceFile"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              setFieldErrors(undefined);
              showNotice(null);

              if (file) {
                selectUploadFile(file);
              } else {
                setSelectedFile(null);
              }
            }}
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
          />
          <div className="createSkillInputFooter">
            <p id="create-skill-input-help">
              Text, screenshots, images, and PDFs work here.
            </p>
            {selectedFile ? (
              <div className="createSkillFilePill">
                <span>{selectedFile.name}</span>
                <button
                  aria-label={`Remove ${selectedFile.name}`}
                  disabled={busy}
                  onClick={() => {
                    clearFileInput(fileInputRef.current);
                    setSelectedFile(null);
                    setFieldErrors(undefined);
                  }}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {activeFieldErrors?.sourceText?.[0] ? (
          <p className="skillFormMessage" data-tone="error">
            {activeFieldErrors.sourceText[0]}
          </p>
        ) : null}
        {fileErrorMessage(activeFieldErrors) ? (
          <p className="skillFormMessage" data-tone="error">
            {fileErrorMessage(activeFieldErrors)}
          </p>
        ) : null}

        <details
          className="skillFormDetails createSkillOptions"
          open={
            activeFieldErrors?.sourceLabel?.length ||
              activeFieldErrors?.collectionName?.length ||
              activeFieldErrors?.focusNote?.length ||
              activeFieldErrors?.tags?.length
              ? true
              : undefined
          }
        >
          <summary>
            <span>More options</span>
            <small>Collection, focus, and tags</small>
          </summary>
          <div className="skillFormFieldsetBody">
            <div className="skillTwoColumnFields">
              <SkillTextField
                error={activeFieldErrors?.sourceLabel?.[0]}
                label="Source name"
                name="sourceLabel"
                placeholder="Chapter 4 notes"
              />
              <SkillTextField
                error={activeFieldErrors?.collectionName?.[0]}
                label="Collection"
                name="collectionName"
                placeholder="Spanish grammar"
              />
            </div>

            <SkillTextArea
              error={activeFieldErrors?.focusNote?.[0]}
              label="Focus"
              name="focusNote"
              placeholder="Focus on the rule, not vocabulary memorization."
              rows={3}
            />

            <SkillTextField
              error={activeFieldErrors?.tags?.[0]}
              label="Tags"
              name="tags"
              placeholder="spanish, verbs, grammar"
            />
          </div>
        </details>

        <div className="skillFormActions createSkillActions">
          <button className="primaryButton" disabled={busy} type="submit">
            {submitButtonLabel({
              isGeneratingFromText,
              selectedFile,
              uploadStatus,
            })}
          </button>
        </div>
      </section>
    </form>
  );

  async function submitUpload(form: HTMLFormElement) {
    try {
      await handleUploadSubmit(form);
    } catch (error) {
      setUploadStatus("error");
      showNotice({
        tone: "error",
        message: formatClientError(error),
      });
    } finally {
      setIsSubmittingUpload(false);
    }
  }

  async function handleUploadSubmit(form: HTMLFormElement) {
    if (!selectedFile) {
      return;
    }

    showNotice(null);
    setFieldErrors(undefined);

    const fileError = getSourceUploadFileError(selectedFile);

    if (fileError) {
      setUploadStatus("error");
      setFieldErrors({
        [fileError.field]: [fileError.message],
      });
      showNotice({
        tone: "error",
        message: fileError.message,
      });
      return;
    }

    const formData = new FormData(form);
    const sourceText = stringFormValue(formData.get("sourceText"));
    const existingFocus = stringFormValue(formData.get("focusNote"));

    formData.set("originalName", selectedFile.name);
    formData.set("mimeType", selectedFile.type);
    formData.set("byteSize", String(selectedFile.size));
    formData.delete("sourceFile");
    formData.delete("sourceText");

    if (!existingFocus && sourceText) {
      formData.set("focusNote", sourceText);
    }

    setUploadStatus("preparing");
    const prepared = await prepareSourceUploadAction(formData);

    if (prepared.status !== "prepared") {
      handleActionError(prepared);
      return;
    }

    setUploadStatus("uploading");
    const uploadResponse = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: prepared.headers,
      body: selectedFile,
    });

    if (!uploadResponse.ok) {
      setUploadStatus("error");
      showNotice({
        tone: "error",
        message: "The private upload failed. Check file upload settings, then try again.",
      });
      return;
    }

    setUploadStatus("generating");
    const completed = await completeSourceUploadAction({
      sourceFileId: prepared.sourceFileId,
    });

    if (completed.status === "created") {
      router.push(completed.redirectTo);
      return;
    }

    setUploadStatus("error");
    showNotice({
      tone: "error",
      message: completed.message,
    });
  }

  function handleActionError(result: Extract<PrepareSourceUploadActionResult, { status: "error" }>) {
    setUploadStatus("error");
    setFieldErrors(result.fieldErrors);
    showNotice({
      tone: "error",
      message: result.message,
    });
  }
}

function SourceGenerationPanel({ status }: { status: SourceGenerationStatus }) {
  return (
    <section className="skillPanel sourceGenerationPanel createSkillGenerationPanel" aria-live="polite" role="status">
      <div className="sourceGenerationSpinner" aria-hidden="true" />
      <div>
        <h2>{status.title || defaultGenerationStatus.title}</h2>
        <p>{status.detail || defaultGenerationStatus.detail}</p>
      </div>
    </section>
  );
}

function getGenerationStatus({
  isGeneratingFromText,
  uploadBusy,
  uploadStatus,
}: {
  isGeneratingFromText: boolean;
  uploadBusy: boolean;
  uploadStatus: UploadStatus;
}): SourceGenerationStatus | null {
  if (uploadBusy) {
    if (uploadStatus === "uploading") {
      return {
        title: "Uploading your file",
        detail: "Keeping the file private while LearnRecur prepares the skill.",
      };
    }

    if (uploadStatus === "generating") {
      return {
        title: "Creating a skill",
        detail: "Reading your material and preparing a focused skill for review.",
      };
    }

    return {
      title: "Creating a skill",
      detail: "Preparing the upload and checking the file.",
    };
  }

  if (isGeneratingFromText) {
    return {
      title: "Creating a skill",
      detail: "Reading your material and preparing a focused skill for review.",
    };
  }

  return null;
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

function submitButtonLabel({
  isGeneratingFromText,
  selectedFile,
  uploadStatus,
}: {
  isGeneratingFromText: boolean;
  selectedFile: File | null;
  uploadStatus: UploadStatus;
}) {
  if (isGeneratingFromText) {
    return "Creating";
  }

  if (selectedFile) {
    switch (uploadStatus) {
      case "preparing":
        return "Preparing";
      case "uploading":
        return "Uploading";
      case "generating":
        return "Creating";
      default:
        return "Create skill";
    }
  }

  return "Create skill";
}

function fileErrorMessage(fieldErrors: Record<string, string[]> | undefined) {
  return (
    fieldErrors?.originalName?.[0] ?? fieldErrors?.mimeType?.[0] ?? fieldErrors?.byteSize?.[0] ?? null
  );
}

function clearFileInput(input: HTMLInputElement | null) {
  if (input) {
    input.value = "";
  }
}

function stringFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function formatClientError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Upload failed before the skill could be created. Check the file and try again.";
}
