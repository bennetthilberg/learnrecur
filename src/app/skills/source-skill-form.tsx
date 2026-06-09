"use client";

import { useActionState, useId } from "react";
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
        <span className="skillPathBadge">Copied text</span>
      </div>
      <p className="skillUploadIntro">
        Paste copied notes, excerpts, or worksheet text. Broad material can become up
        to three narrow drafts.
      </p>

      <fieldset className="skillFormFieldset">
        <legend>Source text</legend>
        <div className="skillFormFieldsetBody">
          <SkillTextArea
            error={state.fieldErrors?.sourceText?.[0]}
            label="Learning material"
            name="sourceText"
            placeholder="Paste notes, a copied textbook excerpt, worksheet instructions, or a short explanation from class."
            required
            rows={9}
          />
        </div>
      </fieldset>

      <details
        className="skillFormDetails"
        open={
          state.fieldErrors?.sourceLabel?.length ||
            state.fieldErrors?.collectionName?.length ||
            state.fieldErrors?.focusNote?.length ||
            state.fieldErrors?.tags?.length
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
        </div>
      </details>

      {state.message ? (
        <p className="skillFormMessage" data-tone={state.status} role="status">
          {state.message}
        </p>
      ) : null}

      <div className="skillFormActions">
        <button className="primaryButton" disabled={isGenerating} type="submit">
          {isGenerating ? "Creating" : "Create drafts from text"}
        </button>
      </div>
    </form>
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
