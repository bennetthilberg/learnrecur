"use client";

import { useCallback, useState } from "react";

import { SourceSkillForm } from "./source-skill-form";
import { SourceUploadForm } from "./source-upload-form";

export type SourceGenerationStatus = {
  title: string;
  detail: string;
};

const defaultGenerationStatus: SourceGenerationStatus = {
  title: "Creating your skill",
  detail: "Reading the source material and writing a focused skill for review.",
};

export function SourceCreationWorkspace() {
  const [generationStatus, setGenerationStatus] = useState<SourceGenerationStatus | null>(null);
  const showGenerationStatus = useCallback((status: SourceGenerationStatus) => {
    setGenerationStatus(status);
  }, []);
  const hideGenerationStatus = useCallback(() => {
    setGenerationStatus(null);
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
        />
        <SourceSkillForm
          onGenerationEnd={hideGenerationStatus}
          onGenerationStart={showGenerationStatus}
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
