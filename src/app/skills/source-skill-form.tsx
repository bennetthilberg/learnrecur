"use client";

import { useActionState } from "react";
import type React from "react";

import {
  generateSkillDraftFromSourceAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SourceSkillForm() {
  const [state, action, isGenerating] = useActionState(
    generateSkillDraftFromSourceAction,
    idleState,
  );

  return (
    <form action={action} className="skillPanel skillSourceForm">
      <div className="skillPanelHeader">
        <div>
          <p className="eyebrow">Source draft</p>
          <h2>Paste learning material.</h2>
        </div>
      </div>

      <SkillTextArea
        error={state.fieldErrors?.sourceText?.[0]}
        label="Source text"
        name="sourceText"
        placeholder="Paste notes, a copied textbook excerpt, worksheet instructions, or a short explanation from class."
        required
        rows={9}
      />

      <div className="skillTwoColumnFields">
        <SkillTextField
          error={state.fieldErrors?.sourceLabel?.[0]}
          label="Source label"
          name="sourceLabel"
          placeholder="Spanish chapter notes"
        />
        <SkillTextField
          error={state.fieldErrors?.collectionName?.[0]}
          label="Collection"
          name="collectionName"
          placeholder="Spanish grammar"
        />
      </div>

      <SkillTextArea
        error={state.fieldErrors?.focusNote?.[0]}
        label="Focus note"
        name="focusNote"
        placeholder="Focus on when to choose ser vs. estar, not vocabulary memorization."
        rows={3}
      />

      <SkillTextField
        error={state.fieldErrors?.tags?.[0]}
        label="Tags"
        name="tags"
        placeholder="spanish, verbs, grammar"
      />

      {state.message ? (
        <p className="skillFormMessage" data-tone={state.status}>
          {state.message}
        </p>
      ) : null}

      <div className="skillFormActions">
        <button className="primaryButton" disabled={isGenerating} type="submit">
          {isGenerating ? "Generating..." : "Generate draft"}
        </button>
      </div>
    </form>
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
