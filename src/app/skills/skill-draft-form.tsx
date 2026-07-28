"use client";

import Link from "next/link";
import { forwardRef, useActionState, useEffect, useId, useRef } from "react";
import type React from "react";
import { CheckCircle, FloppyDisk, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

import { formatDisplayLabel } from "@/lib/formatters";

import {
  addSkillDraftToPracticeInlineAction,
  addSkillDraftToPracticeAction,
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

type SkillDraftFormProps =
  | {
      mode: "create";
      skillId?: never;
      initialValues: SkillDraftFormValues;
    }
  | {
      mode: "edit";
      skillId: string;
      initialValues: SkillDraftFormValues;
      activationMode?: "redirect" | "inline";
      cancelLabel?: string;
      onAdded?: (skillId: string) => void;
      onBack?: () => void;
      onSaved?: () => void;
      submitIntent?: "add" | "save";
    };

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const draftNotificationId = "skill-draft-form-notice";
const addSkillNotificationId = "skill-add-notice";

type SkillDuplicateMatch = NonNullable<
  SkillFormActionState["duplicateMatch"]
>;

export function SkillDraftForm(props: SkillDraftFormProps) {
  const { initialValues, mode } = props;
  const isEditMode = mode === "edit";
  const activationMode = isEditMode ? props.activationMode ?? "redirect" : "redirect";
  const isSaveOnlyEdit = isEditMode && props.submitIntent === "save";
  const cancelLabel = isEditMode ? props.cancelLabel ?? "Back" : undefined;
  const onAdded = isEditMode ? props.onAdded : undefined;
  const onBack = isEditMode ? props.onBack : undefined;
  const onSaved = isEditMode ? props.onSaved : undefined;
  const addSkillServerAction =
    activationMode === "inline" ? addSkillDraftToPracticeInlineAction : addSkillDraftToPracticeAction;
  const [draftState, saveAction, isSaving] = useActionState(saveSkillDraftAction, idleState);
  const [addSkillState, addSkillAction, isAddingSkill] = useActionState(
    addSkillServerAction,
    idleState,
  );
  const formAction = isSaveOnlyEdit ? saveAction : isEditMode ? addSkillAction : saveAction;
  const formState = isSaveOnlyEdit ? draftState : isEditMode ? addSkillState : draftState;
  const isSubmitting = isSaveOnlyEdit ? isSaving : isEditMode ? isAddingSkill : isSaving;
  const duplicateMatch =
    formState.status === "duplicate-warning"
      ? formState.duplicateMatch
      : undefined;
  const displayedValues = formState.draftValues ?? initialValues;
  const formRenderKey =
    formState.draftValues
      ? JSON.stringify([
          formState.draftValues.title,
          formState.draftValues.objective,
          formState.draftValues.collectionName,
          formState.draftValues.rules,
          formState.draftValues.examples,
          formState.draftValues.exerciseConstraints,
          formState.draftValues.tags,
        ])
      : "initial-skill-draft";
  const formRef = useRef<HTMLFormElement>(null);
  const duplicateDecisionRef = useRef<HTMLElement>(null);
  const submitLabel = isSubmitting
    ? isSaveOnlyEdit
      ? "Saving"
      : isEditMode
        ? duplicateMatch
          ? "Checking and adding"
          : "Adding"
        : "Saving"
    : isSaveOnlyEdit
      ? "Save changes"
      : isEditMode
        ? duplicateMatch
          ? "Check and add if distinct"
          : "Add skill"
        : "Create skill";

  useEffect(() => {
    if (!draftState.message || draftState.status === "idle") {
      return;
    }

    const isSaved = draftState.status === "saved";
    notifications.show({
      id: draftNotificationId,
      autoClose: isSaved ? 3500 : 8000,
      className: "learnrecurNotification",
      color: isSaved ? "leaf" : "amber",
      icon: isSaved ? (
        <CheckCircle size={18} weight="bold" />
      ) : (
        <WarningCircle size={18} weight="bold" />
      ),
      message: isSaved ? "Your changes are saved." : draftState.message,
      position: "top-right",
      title: isSaved ? "Changes saved" : "Could not save skill",
      withBorder: true,
      withCloseButton: true,
    });

    if (isSaved) {
      onSaved?.();
    }
  }, [draftState, onSaved]);

  useEffect(() => {
    if (
      addSkillState.status === "duplicate-warning" ||
      !addSkillState.message ||
      addSkillState.status === "idle"
    ) {
      return;
    }

    if (addSkillState.status === "activated" && addSkillState.activatedSkillId) {
      notifications.show({
        id: addSkillNotificationId,
        autoClose: 3500,
        className: "learnrecurNotification",
        color: "leaf",
        icon: <CheckCircle size={18} weight="bold" />,
        message: "The skill is active and in your review schedule.",
        position: "top-right",
        title: "Skill added",
        withBorder: true,
        withCloseButton: true,
      });
      onAdded?.(addSkillState.activatedSkillId);
      return;
    }

    const savedButNotAdded = addSkillState.status === "saved";
    notifications.show({
      id: addSkillNotificationId,
      autoClose: 8000,
      className: "learnrecurNotification",
      color: "amber",
      icon: <WarningCircle size={18} weight="bold" />,
      message: addSkillState.message,
      position: "top-right",
      title: savedButNotAdded ? "Changes saved, skill not added" : "Could not add skill",
      withBorder: true,
      withCloseButton: true,
    });
  }, [addSkillState, onAdded]);

  useEffect(() => {
    if (addSkillState.status === "duplicate-warning") {
      duplicateDecisionRef.current?.focus();
    }
  }, [addSkillState]);

  function focusDraftEditor() {
    const titleField = formRef.current?.elements.namedItem("title");
    if (titleField instanceof HTMLElement) {
      titleField.focus();
    }
  }

  return (
    <div className="skillDraftGrid">
      <form
        action={formAction}
        className="skillPanel skillDraftForm"
        key={formRenderKey}
        ref={formRef}
      >
        <div className="skillPanelHeader">
          <div>
            <h2>{isEditMode ? "Review the skill" : "Write the skill"}</h2>
          </div>
        </div>

        {isEditMode ? <input name="skillId" type="hidden" value={props.skillId} /> : null}

        {duplicateMatch ? (
          <SkillDuplicateDecision
            isSubmitting={isSubmitting}
            match={duplicateMatch}
            onKeepEditing={focusDraftEditor}
            ref={duplicateDecisionRef}
          />
        ) : null}

        <fieldset className="skillFormFieldset">
          <legend>Core definition</legend>
          <div className="skillFormFieldsetBody">
            <SkillTextField
              error={formState.fieldErrors?.title?.[0]}
              label="Title"
              name="title"
              placeholder="Ser vs. estar in everyday sentences"
              disabled={isSubmitting}
              required
              defaultValue={displayedValues.title}
            />

            <SkillTextArea
              error={formState.fieldErrors?.objective?.[0]}
              label="Objective"
              name="objective"
              placeholder="Choose whether ser or estar fits a short Spanish sentence, focusing on identity, location, and temporary state."
              disabled={isSubmitting}
              required
              defaultValue={displayedValues.objective}
              rows={4}
            />

            <div className="skillTwoColumnFields">
              <SkillTextField
                error={formState.fieldErrors?.collectionName?.[0]}
                label="Collection"
                name="collectionName"
                placeholder="Spanish grammar"
                disabled={isSubmitting}
                defaultValue={displayedValues.collectionName}
              />
              <SkillTextField
                error={formState.fieldErrors?.tags?.[0]}
                label="Tags"
                name="tags"
                placeholder="spanish, verbs, grammar"
                disabled={isSubmitting}
                defaultValue={displayedValues.tags}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="skillFormFieldset">
          <legend>Practice guidance</legend>
          <div className="skillFormFieldsetBody">
            <SkillTextArea
              error={formState.fieldErrors?.rules?.[0]}
              label="Rules"
              name="rules"
              placeholder={"Use ser for identity.\nUse estar for location and temporary state."}
              disabled={isSubmitting}
              defaultValue={displayedValues.rules}
              rows={4}
            />

            <SkillTextArea
              error={formState.fieldErrors?.examples?.[0]}
              label="Examples"
              name="examples"
              placeholder={"Soy estudiante.\nEstoy en casa."}
              disabled={isSubmitting}
              defaultValue={displayedValues.examples}
              rows={4}
            />

            <SkillTextArea
              error={formState.fieldErrors?.exerciseConstraints?.[0]}
              label="Exercise constraints"
              name="exerciseConstraints"
              placeholder="Use short choices, avoid trick questions, and keep starter exercises beginner-friendly."
              disabled={isSubmitting}
              defaultValue={displayedValues.exerciseConstraints}
              rows={3}
            />
          </div>
        </fieldset>

        <div className="skillFormActions">
          {onBack ? (
            <button
              className="secondaryButton"
              disabled={isSubmitting}
              onClick={onBack}
              type="button"
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            className={duplicateMatch ? "secondaryButton" : "primaryButton"}
            disabled={isSubmitting}
            type="submit"
          >
            {isEditMode && isSubmitting ? (
              <ButtonLoadingDots />
            ) : isSaveOnlyEdit ? (
              <FloppyDisk size={18} weight="bold" aria-hidden="true" />
            ) : isEditMode ? (
              <CheckCircle size={18} weight="bold" aria-hidden="true" />
            ) : (
              <FloppyDisk size={18} weight="bold" aria-hidden="true" />
            )}
            <span>{submitLabel}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export const SkillDuplicateDecision = forwardRef<
  HTMLElement,
  {
    isSubmitting: boolean;
    match: SkillDuplicateMatch;
    onKeepEditing: () => void;
  }
>(function SkillDuplicateDecision(
  { isSubmitting, match, onKeepEditing },
  ref,
) {
  const headingId = useId();
  const objective =
    match.skill.objective?.trim() || "No objective has been saved.";
  const collection =
    match.skill.collectionName?.trim() || "No collection";
  const tags =
    match.skill.tags.length > 0
      ? match.skill.tags.join(", ")
      : "No tags";

  return (
    <section
      aria-labelledby={headingId}
      className="skillDuplicateDecision"
      ref={ref}
      tabIndex={-1}
    >
      <WarningCircle
        aria-hidden="true"
        className="skillDuplicateDecisionIcon"
        size={24}
        weight="fill"
      />
      <div className="skillDuplicateDecisionBody">
        <div className="skillDuplicateDecisionCopy">
          <h3 id={headingId}>You may already have this skill</h3>
          <p>
            This draft looks similar to a skill already in your library.
            Compare the two before adding another review schedule.
          </p>
        </div>

        <div className="skillDuplicatePreview">
          <h4>{match.skill.title}</h4>
          <p>{objective}</p>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{formatDisplayLabel(match.skill.status)}</dd>
            </div>
            <div>
              <dt>Collection</dt>
              <dd>{collection}</dd>
            </div>
            <div>
              <dt>Tags</dt>
              <dd>{tags}</dd>
            </div>
          </dl>
        </div>

        <div className="skillDuplicateDecisionActions">
          <Link
            className="primaryButton"
            href={`/skills/${match.skill.id}`}
          >
            Open existing skill
          </Link>
          <button
            className="secondaryButton"
            disabled={isSubmitting}
            onClick={onKeepEditing}
            type="button"
          >
            Edit this draft
          </button>
          <button
            className="skillDuplicateOverride"
            disabled={isSubmitting}
            name="duplicateOverrideSkillId"
            type="submit"
            value={match.skill.id}
          >
            {isSubmitting
              ? "Checking and adding"
              : "Add as a separate skill anyway"}
          </button>
        </div>
      </div>
    </section>
  );
});

function ButtonLoadingDots() {
  return (
    <span className="buttonLoadingDots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
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
