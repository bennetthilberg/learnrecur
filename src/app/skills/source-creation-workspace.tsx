"use client";

import { useCallback, useState } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";

import { notifications } from "@/components/app/notifications";
import { SourceSkillForm } from "./source-skill-form";
import { SourceUploadForm } from "./source-upload-form";

export type SourceGenerationStatus = {
  title: string;
  detail: string;
};

export type SourceCreationNotice = {
  tone: "error" | "success";
  message: string;
};

const sourceCreationNotificationId = "source-creation-notice";

const defaultGenerationStatus: SourceGenerationStatus = {
  title: "Creating your skill",
  detail: "Reading the source material and writing a focused skill for review.",
};

export function SourceCreationWorkspace() {
  const [generationStatus, setGenerationStatus] = useState<SourceGenerationStatus | null>(null);
  const showGenerationStatus = useCallback((status: SourceGenerationStatus) => {
    notifications.hide(sourceCreationNotificationId);
    setGenerationStatus(status);
  }, []);
  const hideGenerationStatus = useCallback(() => {
    setGenerationStatus(null);
  }, []);
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
      title: nextNotice.tone === "error" ? "Could not create skill" : "Source added",
      withBorder: true,
      withCloseButton: true,
    });
  }, []);

  return (
    <>
      {generationStatus ? <SourceGenerationPanel status={generationStatus} /> : null}
      <section
        aria-label="Source-backed skill creation options"
        className="skillSourceEntryGrid"
        hidden={Boolean(generationStatus)}
      >
        <SourceUploadForm
          onGenerationEnd={hideGenerationStatus}
          onGenerationStart={showGenerationStatus}
          onNotice={showNotice}
        />
        <SourceSkillForm
          onGenerationEnd={hideGenerationStatus}
          onGenerationStart={showGenerationStatus}
          onNotice={showNotice}
        />
      </section>
    </>
  );
}

function SourceGenerationPanel({ status }: { status: SourceGenerationStatus }) {
  return (
    <section className="skillPanel sourceGenerationPanel" aria-live="polite" role="status">
      <div className="sourceGenerationSpinner" aria-hidden="true" />
      <div>
        <h2>{status.title || defaultGenerationStatus.title}</h2>
        <p>{status.detail || defaultGenerationStatus.detail}</p>
      </div>
    </section>
  );
}
