"use client";

import { useActionState, useEffect, useId } from "react";
import type React from "react";
import { CheckCircle, FloppyDisk, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

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
      onAdded?: (skillId: string) => void;
      onBack?: () => void;
    };

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const draftNotificationId = "skill-draft-form-notice";
const addSkillNotificationId = "skill-add-notice";

export function SkillDraftForm(props: SkillDraftFormProps) {
  const { initialValues, mode } = props;
  const isEditMode = mode === "edit";
  const activationMode = isEditMode ? props.activationMode ?? "redirect" : "redirect";
  const onAdded = isEditMode ? props.onAdded : undefined;
  const onBack = isEditMode ? props.onBack : undefined;
  const addSkillServerAction =
    activationMode === "inline" ? addSkillDraftToPracticeInlineAction : addSkillDraftToPracticeAction;
  const [draftState, saveAction, isSaving] = useActionState(saveSkillDraftAction, idleState);
  const [addSkillState, addSkillAction, isAddingSkill] = useActionState(
    addSkillServerAction,
    idleState,
  );
  const formAction = isEditMode ? addSkillAction : saveAction;
  const formState = isEditMode ? addSkillState : draftState;
  const isSubmitting = isEditMode ? isAddingSkill : isSaving;

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
  }, [draftState]);

  useEffect(() => {
    if (!addSkillState.message || addSkillState.status === "idle") {
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

  return (
    <div className="skillDraftGrid">
      <form action={formAction} className="skillPanel skillDraftForm">
        <div className="skillPanelHeader">
          <div>
            <h2>{isEditMode ? "Review the skill" : "Write the skill"}</h2>
          </div>
        </div>

        {isEditMode ? <input name="skillId" type="hidden" value={props.skillId} /> : null}

        <fieldset className="skillFormFieldset">
          <legend>Core definition</legend>
          <div className="skillFormFieldsetBody">
            <SkillTextField
              error={formState.fieldErrors?.title?.[0]}
              label="Title"
              name="title"
              placeholder="Ser vs. estar in everyday sentences"
              required
              defaultValue={initialValues.title}
            />

            <SkillTextArea
              error={formState.fieldErrors?.objective?.[0]}
              label="Objective"
              name="objective"
              placeholder="Choose whether ser or estar fits a short Spanish sentence, focusing on identity, location, and temporary state."
              required
              defaultValue={initialValues.objective}
              rows={4}
            />

            <div className="skillTwoColumnFields">
              <SkillTextField
                error={formState.fieldErrors?.collectionName?.[0]}
                label="Collection"
                name="collectionName"
                placeholder="Spanish grammar"
                defaultValue={initialValues.collectionName}
              />
              <SkillTextField
                error={formState.fieldErrors?.tags?.[0]}
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
              error={formState.fieldErrors?.rules?.[0]}
              label="Rules"
              name="rules"
              placeholder={"Use ser for identity.\nUse estar for location and temporary state."}
              defaultValue={initialValues.rules}
              rows={4}
            />

            <SkillTextArea
              error={formState.fieldErrors?.examples?.[0]}
              label="Examples"
              name="examples"
              placeholder={"Soy estudiante.\nEstoy en casa."}
              defaultValue={initialValues.examples}
              rows={4}
            />

            <SkillTextArea
              error={formState.fieldErrors?.exerciseConstraints?.[0]}
              label="Exercise constraints"
              name="exerciseConstraints"
              placeholder="Use short choices, avoid trick questions, and keep starter exercises beginner-friendly."
              defaultValue={initialValues.exerciseConstraints}
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
              Back
            </button>
          ) : null}
          <button
            className="primaryButton"
            disabled={isSubmitting}
            type="submit"
          >
            {isEditMode ? (
              <CheckCircle size={18} weight="bold" aria-hidden="true" />
            ) : (
              <FloppyDisk size={18} weight="bold" aria-hidden="true" />
            )}
            <span>
              {isSubmitting
                ? isEditMode
                  ? "Adding"
                  : "Saving"
                : isEditMode
                  ? "Add skill"
                  : "Create skill"}
            </span>
          </button>
        </div>
      </form>
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
