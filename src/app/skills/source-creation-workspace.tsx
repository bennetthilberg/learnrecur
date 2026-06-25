"use client";

import { useCallback, useState } from "react";
import { X } from "@phosphor-icons/react";

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

const defaultGenerationStatus: SourceGenerationStatus = {
  title: "Creating your skill",
  detail: "Reading the source material and writing a focused skill for review.",
};

export function SourceCreationWorkspace() {
  const [generationStatus, setGenerationStatus] = useState<SourceGenerationStatus | null>(null);
  const [notice, setNotice] = useState<SourceCreationNotice | null>(null);
  const showGenerationStatus = useCallback((status: SourceGenerationStatus) => {
    setNotice(null);
    setGenerationStatus(status);
  }, []);
  const hideGenerationStatus = useCallback(() => {
    setGenerationStatus(null);
  }, []);
  const showNotice = useCallback((nextNotice: SourceCreationNotice | null) => {
    setNotice(nextNotice);
  }, []);

  return (
    <>
      {notice ? <SourceCreationToast notice={notice} onDismiss={() => setNotice(null)} /> : null}
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

function SourceCreationToast({
  notice,
  onDismiss,
}: {
  notice: SourceCreationNotice;
  onDismiss: () => void;
}) {
  return (
    <div
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
      className="sourceCreationToast"
      data-tone={notice.tone}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <p>{notice.message}</p>
      <button aria-label="Dismiss message" onClick={onDismiss} type="button">
        <X size={16} weight="bold" />
      </button>
    </div>
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
