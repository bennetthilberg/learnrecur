"use client";

import { useActionState, useId } from "react";
import type React from "react";

import {
  activateSkillDraftAction,
  saveSkillDraftAction,
  type SkillFormActionState,
} from "./actions";

export type SkillDraftFormValues = {
  title: string;
  objective: string;
  collectionName: string;
  rules: string;
  examples: string;
  exerciseConstraints: string;
  tags: string;
};

type SkillDraftFormProps = {
  mode: "create" | "edit";
  skillId?: string;
  initialValues: SkillDraftFormValues;
};

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillDraftForm({ mode, skillId, initialValues }: SkillDraftFormProps) {
  const [draftState, saveAction, isSaving] = useActionState(saveSkillDraftAction, idleState);
  const [activationState, activateAction, isActivating] = useActionState(
    activateSkillDraftAction,
    idleState,
  );

  return (
    <div className="skillDraftGrid">
      <form action={saveAction} className="skillPanel skillDraftForm">
        <div className="skillPanelHeader">
          <div>
            <p className="eyebrow">Skill definition</p>
            <h2>{mode === "create" ? "Create a draft." : "Review the draft."}</h2>
          </div>
        </div>

        {skillId ? <input name="skillId" type="hidden" value={skillId} /> : null}

        <fieldset className="skillFormFieldset">
          <legend>Core definition</legend>
          <div className="skillFormFieldsetBody">
            <SkillTextField
              error={draftState.fieldErrors?.title?.[0]}
              label="Title"
              name="title"
              placeholder="Ser vs. estar in everyday sentences"
              required
              defaultValue={initialValues.title}
            />

            <SkillTextArea
              error={draftState.fieldErrors?.objective?.[0]}
              label="Objective"
              name="objective"
              placeholder="Choose whether ser or estar fits a short Spanish sentence, focusing on identity, location, and temporary state."
              required
              defaultValue={initialValues.objective}
              rows={4}
            />

            <div className="skillTwoColumnFields">
              <SkillTextField
                error={draftState.fieldErrors?.collectionName?.[0]}
                label="Collection"
                name="collectionName"
                placeholder="Spanish grammar"
                defaultValue={initialValues.collectionName}
              />
              <SkillTextField
                error={draftState.fieldErrors?.tags?.[0]}
                label="Tags"
                name="tags"
                placeholder="spanish, verbs, grammar"
                defaultValue={initialValues.tags}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="skillFormFieldset">
          <legend>Practice guidance</legend>
          <div className="skillFormFieldsetBody">
            <SkillTextArea
              error={draftState.fieldErrors?.rules?.[0]}
              label="Rules"
              name="rules"
              placeholder={"Use ser for identity.\nUse estar for location and temporary state."}
              defaultValue={initialValues.rules}
              rows={4}
            />

            <SkillTextArea
              error={draftState.fieldErrors?.examples?.[0]}
              label="Examples"
              name="examples"
              placeholder={"Soy estudiante.\nEstoy en casa."}
              defaultValue={initialValues.examples}
              rows={4}
            />

            <SkillTextArea
              error={draftState.fieldErrors?.exerciseConstraints?.[0]}
              label="Exercise constraints"
              name="exerciseConstraints"
              placeholder="Use short choices, avoid trick questions, and keep the first batch beginner-friendly."
              defaultValue={initialValues.exerciseConstraints}
              rows={3}
            />
          </div>
        </fieldset>

        {draftState.message ? (
          <p className="skillFormMessage" data-tone={draftState.status} role="status">
            {draftState.message}
          </p>
        ) : null}

        <div className="skillFormActions">
          <button
            className={mode === "create" ? "secondaryButton" : "primaryButton"}
            disabled={isSaving}
            type="submit"
          >
            {isSaving ? "Saving..." : mode === "create" ? "Create draft" : "Save draft"}
          </button>
        </div>
      </form>

      {mode === "edit" && skillId ? (
        <section className="skillPanel skillActivationPanel" aria-labelledby="activate-skill-title">
          <div className="skillPanelHeader">
            <div>
              <p className="eyebrow">Activation</p>
              <h2 id="activate-skill-title">Generate starter practice.</h2>
            </div>
          </div>
          <p>
            Activation asks Gemini for a first batch of multiple-choice exercises, validates
            the structure, then schedules this skill for practice.
          </p>

          {activationState.message ? (
            <p className="skillFormMessage" data-tone="error" role="status">
              {activationState.message}
            </p>
          ) : null}

          <form action={activateAction} className="skillActivationForm">
            <input name="skillId" type="hidden" value={skillId} />
            <button className="primaryButton" disabled={isActivating} type="submit">
              {isActivating ? "Activating..." : "Activate with Gemini"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
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
