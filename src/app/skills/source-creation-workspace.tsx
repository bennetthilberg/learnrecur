"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type React from "react";
import { Stepper } from "@mantine/core";
import {
  CheckCircle,
  File as FileIcon,
  FilePdf,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SOURCE_UPLOAD_MIME_TYPES } from "@/lib/skills/source-upload-policy";

import {
  completeSourceUploadAction,
  generateSkillDraftFromSourceAction,
  prepareSourceUploadAction,
  restoreSourceTextAction,
  type CreatedSkillDraftForReview,
  type PrepareSourceUploadActionResult,
  type SkillFormActionState,
} from "./actions";
import { getClipboardSourceFile, getSourceUploadFileError } from "./source-upload-clipboard";
import { SkillDraftForm } from "./skill-draft-form";
import { SourceProcessingControls } from "./source-processing-controls";

export type SourceGenerationStatus = {
  title: string;
  detail?: string;
};

export type SourceCreationNotice = {
  tone: "error" | "success";
  message: string;
};

type UploadStatus = "idle" | "preparing" | "uploading" | "generating" | "error";
type SkillCreationStep = 0 | 1 | 2;
type MaterialSnapshot = {
  sourceText: string;
  sourceLabel: string;
  collectionName: string;
  focusNote: string;
  tags: string;
  recoveredSourceFileId: string;
};
export type RecoverableSourceUpload = {
  id: string;
  kind: "IMAGE" | "PDF" | "TEXT";
  originalName: string;
  status: "UPLOADED" | "PROCESSING" | "FAILED";
  errorMessage: string | null;
  isStaleProcessing: boolean;
  canRequeue: boolean;
  hasSourceText: boolean;
};

const sourceCreationNotificationId = "source-creation-notice";
const emptySourceTextMessage =
  "Add learning material first. Paste text, describe the skill, or choose a PDF or image.";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const defaultGenerationStatus: SourceGenerationStatus = {
  title: "Creating your skill",
};

const skillStatusMessages = [
  "Finding the smallest useful skill...",
  "Pulling out rules and examples...",
  "Keeping it narrow enough to practice...",
  "Shaping it into a review target...",
];

const emptyMaterialSnapshot: MaterialSnapshot = {
  sourceText: "",
  sourceLabel: "",
  collectionName: "",
  focusNote: "",
  recoveredSourceFileId: "",
  tags: "",
};

const createSkillStepperClassNames = {
  content: "createSkillStepperContent",
  separator: "createSkillStepperSeparator",
  step: "createSkillStepperStep",
  stepBody: "createSkillStepperBody",
  stepDescription: "createSkillStepperDescription",
  stepIcon: "createSkillStepperIcon",
  stepLabel: "createSkillStepperLabel",
  steps: "createSkillStepperSteps",
} as const;

export function SourceCreationWorkspace({
  recoverableSourceUploads = [],
}: {
  recoverableSourceUploads?: RecoverableSourceUpload[];
}) {
  const router = useRouter();
  const fileInputId = useId();
  const sourceTextId = useId();
  const sourceTextErrorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedFilePreviewUrlRef = useRef<string | null>(null);
  const [textState, textAction, isGeneratingFromText] = useActionState(
    generateSkillDraftFromSourceAction,
    idleState,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFilePreviewUrl, setSelectedFilePreviewUrl] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [isSubmittingUpload, setIsSubmittingUpload] = useState(false);
  const [isPendingUpload, startUploadTransition] = useTransition();
  const [materialSnapshot, setMaterialSnapshot] = useState<MaterialSnapshot>(emptyMaterialSnapshot);
  const [createdSkill, setCreatedSkill] = useState<CreatedSkillDraftForReview | null>(null);
  const [activatedSkillId, setActivatedSkillId] = useState<string | null>(null);
  const [dismissedSkillId, setDismissedSkillId] = useState<string | null>(null);
  const [restoringSourceId, setRestoringSourceId] = useState<string | null>(null);
  const [ignoreTextStateErrors, setIgnoreTextStateErrors] = useState(false);

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
  });
  const textCreatedSkill = textState.status === "saved" ? textState.createdSkill ?? null : null;
  const reviewSkill =
    createdSkill ?? (textCreatedSkill?.skillId === dismissedSkillId ? null : textCreatedSkill);
  let activeStep: SkillCreationStep = 0;

  if (generationStatus) {
    activeStep = 1;
  } else if (reviewSkill || activatedSkillId) {
    activeStep = 2;
  }

  const textActionFieldErrors =
    !ignoreTextStateErrors && textState.status === "error" ? textState.fieldErrors : undefined;
  const activeFieldErrors = selectedFile
    ? fieldErrors
    : fieldErrors ?? textActionFieldErrors;
  const sourceTextError = activeFieldErrors?.sourceText?.[0];
  const sourceTextDescribedBy = ["create-skill-input-help", sourceTextError ? sourceTextErrorId : null]
    .filter(Boolean)
    .join(" ");

  const clearSelectedFilePreview = useCallback(() => {
    if (selectedFilePreviewUrlRef.current) {
      URL.revokeObjectURL(selectedFilePreviewUrlRef.current);
      selectedFilePreviewUrlRef.current = null;
    }

    setSelectedFilePreviewUrl(null);
  }, []);

  const setSelectedFilePreview = useCallback(
    (file: File) => {
      clearSelectedFilePreview();

      if (!file.type.startsWith("image/")) {
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      selectedFilePreviewUrlRef.current = previewUrl;
      setSelectedFilePreviewUrl(previewUrl);
    },
    [clearSelectedFilePreview],
  );

  const clearSelectedFile = useCallback(() => {
    clearFileInput(fileInputRef.current);
    setSelectedFile(null);
    clearSelectedFilePreview();
    setFieldErrors(undefined);
  }, [clearSelectedFilePreview]);

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
      clearSelectedFilePreview();
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
    setSelectedFilePreview(file);
    setUploadStatus("idle");
    setFieldErrors(undefined);

    if (successMessage) {
      showNotice({
        tone: "success",
        message: successMessage,
      });
    }

    return true;
  }, [clearSelectedFilePreview, setSelectedFilePreview, showNotice]);

  const restoreSavedSourceText = useCallback(
    async (upload: RecoverableSourceUpload) => {
      if (!upload.hasSourceText || restoringSourceId) {
        return;
      }

      setRestoringSourceId(upload.id);
      showNotice(null);

      try {
        const restored = await restoreSourceTextAction({
          sourceFileId: upload.id,
        });

        if (restored.status === "error") {
          showNotice({
            tone: "error",
            message: restored.message,
          });
          return;
        }

        clearSelectedFile();
        setFieldErrors(undefined);
        setIgnoreTextStateErrors(true);
        setMaterialSnapshot((currentSnapshot) => ({
          ...currentSnapshot,
          recoveredSourceFileId: upload.id,
          sourceText: restored.sourceText,
          sourceLabel: currentSnapshot.sourceLabel || restored.sourceLabel,
        }));

        const sourceTextControl = formRef.current?.elements.namedItem("sourceText");
        const sourceLabelControl = formRef.current?.elements.namedItem("sourceLabel");

        if (sourceTextControl instanceof HTMLTextAreaElement) {
          sourceTextControl.value = restored.sourceText;
          sourceTextControl.focus();
        }

        if (
          sourceLabelControl instanceof HTMLInputElement &&
          !sourceLabelControl.value.trim()
        ) {
          sourceLabelControl.value = restored.sourceLabel;
        }

        showNotice({
          tone: "success",
          message: restored.message,
        });
      } catch (error) {
        showNotice({
          tone: "error",
          message: formatClientError(error),
        });
      } finally {
        setRestoringSourceId(null);
      }
    },
    [clearSelectedFile, restoringSourceId, showNotice],
  );

  useEffect(() => {
    if (activeStep !== 0) {
      return undefined;
    }

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
  }, [activeStep, busy, selectUploadFile]);

  useEffect(() => {
    return () => {
      if (selectedFilePreviewUrlRef.current) {
        URL.revokeObjectURL(selectedFilePreviewUrlRef.current);
        selectedFilePreviewUrlRef.current = null;
      }
    };
  }, []);

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

  useEffect(() => {
    if (textState.status !== "saved" || !textState.createdSkill) {
      return;
    }

    showNotice({
      tone: "success",
      message: "Skill ready to review.",
    });
  }, [showNotice, textState.createdSkill, textState.status]);

  useEffect(() => {
    if (textState.status !== "saved" || textState.createdSkill || !textState.message) {
      return;
    }

    showNotice({
      tone: "success",
      message: textState.message,
    });
  }, [showNotice, textState.createdSkill, textState.message, textState.status]);

  const handleActionError = useCallback(
    (result: Extract<PrepareSourceUploadActionResult, { status: "error" }>) => {
      setUploadStatus("error");
      setFieldErrors(result.fieldErrors);
      showNotice({
        tone: "error",
        message: result.message,
      });
    },
    [showNotice],
  );

  const handleUploadSubmit = useCallback(
    async (form: HTMLFormElement) => {
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
        setUploadStatus("idle");
        setActivatedSkillId(null);
        setDismissedSkillId(null);
        showNotice({
          tone: "success",
          message: completed.message,
        });

        if (!completed.skill) {
          router.push(completed.redirectTo);
          return;
        }

        setCreatedSkill(completed.skill);
        return;
      }

      setUploadStatus("error");
      showNotice({
        tone: "error",
        message: completed.message,
      });
    },
    [handleActionError, router, selectedFile, showNotice],
  );

  const submitUpload = useCallback(
    async (form: HTMLFormElement) => {
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
    },
    [handleUploadSubmit, showNotice],
  );

  const canReturnToMaterial = !busy && Boolean(reviewSkill) && !activatedSkillId;
  const creationContent = generationStatus ? (
    <SourceGenerationPanel status={generationStatus} />
  ) : activatedSkillId ? (
    <SkillAddedPanel
      onAddAnother={() => {
        clearFileInput(fileInputRef.current);
        setActivatedSkillId(null);
        setCreatedSkill(null);
        setDismissedSkillId(textCreatedSkill?.skillId ?? null);
        clearSelectedFile();
        setUploadStatus("idle");
        setMaterialSnapshot(emptyMaterialSnapshot);
        showNotice(null);
      }}
      skillId={activatedSkillId}
    />
  ) : reviewSkill ? (
    <SkillDraftForm
      activationMode="inline"
      initialValues={reviewSkill.values}
      mode="edit"
      onAdded={(skillId) => {
        setActivatedSkillId(skillId);
        setCreatedSkill(null);
        setDismissedSkillId(skillId);
      }}
      onBack={() => {
        setCreatedSkill(null);
        setDismissedSkillId(reviewSkill.skillId);
        showNotice(null);
      }}
      skillId={reviewSkill.skillId}
    />
  ) : (
    <div className="skillCreateStack createSkillMaterialStack">
      <form
        action={textAction}
        className="createSkillMaterialForm"
        onSubmit={(event) => {
          const formData = new FormData(event.currentTarget);
          setMaterialSnapshot(formDataToMaterialSnapshot(formData));
          setDismissedSkillId(null);

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

          const sourceText = stringFormValue(formData.get("sourceText"));

          if (!sourceText) {
            event.preventDefault();
            setFieldErrors({
              sourceText: [emptySourceTextMessage],
            });
            showNotice({
              tone: "error",
              message: emptySourceTextMessage,
            });
            focusSourceText(event.currentTarget);
            return;
          }

          setFieldErrors(undefined);
          setIgnoreTextStateErrors(false);
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
              aria-describedby={sourceTextDescribedBy}
              aria-invalid={sourceTextError ? "true" : undefined}
              aria-labelledby="create-skill-input-title"
              className="createSkillTextarea"
              disabled={busy}
              defaultValue={materialSnapshot.sourceText}
              id={sourceTextId}
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
                  clearSelectedFile();
                }
              }}
              ref={fileInputRef}
              tabIndex={-1}
              type="file"
            />
            {selectedFile ? (
              <CreateSkillAttachmentPreview
                disabled={busy}
                file={selectedFile}
                onRemove={clearSelectedFile}
                previewUrl={selectedFilePreviewUrl}
              />
            ) : null}
            <div className="createSkillInputFooter">
              <p id="create-skill-input-help">
                Text, screenshots, images, and PDFs work here.
              </p>
            </div>
          </div>

          {sourceTextError ? (
            <p className="skillFormMessage" data-tone="error" id={sourceTextErrorId}>
              {sourceTextError}
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
                  defaultValue={materialSnapshot.sourceLabel}
                />
                <SkillTextField
                  error={activeFieldErrors?.collectionName?.[0]}
                  label="Collection"
                  name="collectionName"
                  placeholder="Spanish grammar"
                  defaultValue={materialSnapshot.collectionName}
                />
              </div>

              <SkillTextArea
                error={activeFieldErrors?.focusNote?.[0]}
                label="Focus"
                name="focusNote"
                placeholder="Focus on the rule, not vocabulary memorization."
                defaultValue={materialSnapshot.focusNote}
                rows={3}
              />

              <SkillTextField
                error={activeFieldErrors?.tags?.[0]}
                label="Tags"
                name="tags"
                placeholder="spanish, verbs, grammar"
                defaultValue={materialSnapshot.tags}
              />
            </div>
          </details>

          <input
            name="recoveredSourceFileId"
            type="hidden"
            value={materialSnapshot.recoveredSourceFileId}
          />

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
      {recoverableSourceUploads.length > 0 ? (
        <RecoverableSourceUploads
          onUseText={restoreSavedSourceText}
          restoringSourceId={restoringSourceId}
          uploads={recoverableSourceUploads}
        />
      ) : null}
    </div>
  );

  return (
    <div className="skillCreateFlow" data-step={activeStep}>
      <SkillCreationStepper
        activeStep={activeStep}
        canReturnToMaterial={canReturnToMaterial}
        onReturnToMaterial={() => {
          setCreatedSkill(null);
          setDismissedSkillId(reviewSkill?.skillId ?? null);
          showNotice(null);
        }}
      />
      {creationContent}
    </div>
  );
}

function RecoverableSourceUploads({
  onUseText,
  restoringSourceId,
  uploads,
}: {
  onUseText: (upload: RecoverableSourceUpload) => Promise<void>;
  restoringSourceId: string | null;
  uploads: RecoverableSourceUpload[];
}) {
  return (
    <section
      className="skillPanel createSkillRecoveryUploads"
      aria-labelledby="create-skill-recovery-title"
    >
      <div>
        <h3 id="create-skill-recovery-title">Saved material</h3>
        <p>Material that did not finish creating a skill can be picked up here.</p>
      </div>
      <div className="createSkillRecoveryList">
        {uploads.map((upload) => (
          <article className="createSkillRecoveryRow" key={upload.id}>
            <div>
              <strong>{upload.originalName}</strong>
              <p>{recoverableSourceCopy(upload)}</p>
            </div>
            {upload.canRequeue ? (
              <SourceProcessingControls
                canRequeue
                sourceFileId={upload.id}
                sourceFileName={upload.originalName}
              />
            ) : upload.hasSourceText ? (
              <button
                aria-label={`Use saved text from ${upload.originalName}`}
                className="secondaryButton"
                disabled={restoringSourceId !== null}
                onClick={() => {
                  void onUseText(upload);
                }}
                type="button"
              >
                {restoringSourceId === upload.id ? "Loading text" : "Use text"}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function recoverableSourceCopy(upload: RecoverableSourceUpload) {
  if (upload.errorMessage) {
    return upload.errorMessage;
  }

  if (upload.hasSourceText) {
    return "Pasted material was saved. Load it here, then create the skill again.";
  }

  if (upload.status === "FAILED") {
    return "Preparation failed before a skill was created.";
  }

  if (upload.isStaleProcessing) {
    return "Preparation has been running longer than expected.";
  }

  return "Preparation has not finished yet.";
}

function SkillCreationStepper({
  activeStep,
  canReturnToMaterial,
  onReturnToMaterial,
}: {
  activeStep: SkillCreationStep;
  canReturnToMaterial: boolean;
  onReturnToMaterial: () => void;
}) {
  return (
    <Stepper
      active={activeStep}
      allowNextStepsSelect={false}
      className="createSkillStepper"
      classNames={createSkillStepperClassNames}
      color="blue"
      iconSize={28}
      onStepClick={(stepIndex) => {
        if (stepIndex === 0 && canReturnToMaterial) {
          onReturnToMaterial();
        }
      }}
      size="sm"
      wrap={false}
    >
      <Stepper.Step
        allowStepClick={canReturnToMaterial}
        description="Add source"
        label="Material"
      />
      <Stepper.Step allowStepClick={false} description="Reading material" label="Processing" />
      <Stepper.Step allowStepClick={false} description="Edit and create skill" label="Review" />
    </Stepper>
  );
}

function SkillAddedPanel({
  onAddAnother,
  skillId,
}: {
  onAddAnother: () => void;
  skillId: string;
}) {
  return (
    <section className="skillPanel createSkillDonePanel">
      <div className="createSkillDoneCopy">
        <CheckCircle size={34} weight="fill" aria-hidden="true" />
        <div>
          <h2>Skill added</h2>
          <p>It is active now and included in your review schedule.</p>
        </div>
      </div>
      <div className="skillFormActions createSkillDoneActions">
        <Link className="primaryButton" href={`/skills/${skillId}`}>
          View skill
        </Link>
        <Link className="secondaryButton" href="/practice">
          Open practice
        </Link>
        <button className="secondaryButton" onClick={onAddAnother} type="button">
          Add another
        </button>
      </div>
    </section>
  );
}

function CreateSkillAttachmentPreview({
  disabled,
  file,
  onRemove,
  previewUrl,
}: {
  disabled: boolean;
  file: File;
  onRemove: () => void;
  previewUrl: string | null;
}) {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const FilePreviewIcon = isPdf ? FilePdf : FileIcon;

  return (
    <div className="createSkillAttachmentPreview">
      <div className="createSkillAttachmentTile" data-kind={previewUrl ? "image" : "file"}>
        {previewUrl ? (
          <Image
            alt={`Preview of ${file.name}`}
            className="createSkillAttachmentImage"
            height={184}
            src={previewUrl}
            unoptimized
            width={260}
          />
        ) : (
          <div className="createSkillAttachmentFile">
            <FilePreviewIcon size={38} weight="duotone" aria-hidden="true" />
            <span title={file.name}>{file.name}</span>
          </div>
        )}
        <button
          aria-label={`Remove ${file.name}`}
          className="createSkillAttachmentRemove"
          disabled={disabled}
          onClick={onRemove}
          type="button"
        >
          <Trash size={16} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SourceGenerationPanel({ status }: { status: SourceGenerationStatus }) {
  const messages = skillStatusMessages;
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setMessageIndex((currentIndex) => (currentIndex + 1) % messages.length);
    }, 3600);

    return () => window.clearInterval(intervalId);
  }, [messages]);

  return (
    <section className="skillPanel sourceGenerationPanel createSkillGenerationPanel" aria-live="polite" role="status">
      <div className="sourceGenerationSpinner" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="sourceGenerationCopy">
        <h2>{status.title || defaultGenerationStatus.title}</h2>
        <p aria-hidden="true" className="sourceGenerationStatusLine">
          {messages[messageIndex % messages.length]}
        </p>
      </div>
    </section>
  );
}

function getGenerationStatus({
  isGeneratingFromText,
  uploadBusy,
}: {
  isGeneratingFromText: boolean;
  uploadBusy: boolean;
}): SourceGenerationStatus | null {
  if (uploadBusy) {
    return {
      title: "Creating a skill",
    };
  }

  if (isGeneratingFromText) {
    return {
      title: "Creating a skill",
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

function formDataToMaterialSnapshot(formData: FormData): MaterialSnapshot {
  return {
    sourceText: stringFormValue(formData.get("sourceText")),
    sourceLabel: stringFormValue(formData.get("sourceLabel")),
    collectionName: stringFormValue(formData.get("collectionName")),
    focusNote: stringFormValue(formData.get("focusNote")),
    recoveredSourceFileId: stringFormValue(formData.get("recoveredSourceFileId")),
    tags: stringFormValue(formData.get("tags")),
  };
}

function focusSourceText(form: HTMLFormElement) {
  const sourceText = form.elements.namedItem("sourceText");

  if (sourceText instanceof HTMLTextAreaElement) {
    sourceText.focus();
  }
}

function formatClientError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Upload failed before the skill could be created. Check the file and try again.";
}
