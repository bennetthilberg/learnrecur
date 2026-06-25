"use client";

import { Card } from "@radix-ui/themes";
import { useActionState, useEffect } from "react";
import {
  CheckCircle,
  FloppyDisk,
  PlusCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import { notifications } from "@/components/app/notifications";
import { PressButton } from "@/components/app/open-water";
import { RadixTextArea, RadixTextField } from "@/components/app/radix-form";

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

const draftNotificationId = "skill-draft-form-notice";
const activationNotificationId = "skill-draft-activation-notice";

export function SkillDraftForm({ mode, skillId, initialValues }: SkillDraftFormProps) {
  const [draftState, saveAction, isSaving] = useActionState(saveSkillDraftAction, idleState);
  const [activationState, activateAction, isActivating] = useActionState(
    activateSkillDraftAction,
    idleState,
  );

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
      title: isSaved ? "Draft saved" : "Could not save draft",
      withBorder: true,
      withCloseButton: true,
    });
  }, [draftState]);

  useEffect(() => {
    if (!activationState.message || activationState.status === "idle") {
      return;
    }

    notifications.show({
      id: activationNotificationId,
      autoClose: 8000,
      className: "learnrecurNotification",
      color: "amber",
      icon: <WarningCircle size={18} weight="bold" />,
      message: activationState.message,
      position: "top-right",
      title: "Could not add skill",
      withBorder: true,
      withCloseButton: true,
    });
  }, [activationState]);

  return (
    <div className="skillDraftGrid">
      <Card asChild size="3" variant="surface">
        <form action={saveAction} className="skillPanel skillDraftForm">
          <div className="skillPanelHeader">
            <div>
              <h2>{mode === "create" ? "Write the skill" : "Review generated skill"}</h2>
            </div>
          </div>

          {skillId ? <input name="skillId" type="hidden" value={skillId} /> : null}

          <fieldset className="skillFormFieldset">
            <legend>Core definition</legend>
            <div className="skillFormFieldsetBody">
              <RadixTextField
                error={draftState.fieldErrors?.title?.[0]}
                label="Title"
                name="title"
                placeholder="Ser vs. estar in everyday sentences"
                required
                defaultValue={initialValues.title}
              />

              <RadixTextArea
                error={draftState.fieldErrors?.objective?.[0]}
                label="Objective"
                name="objective"
                placeholder="Choose whether ser or estar fits a short Spanish sentence, focusing on identity, location, and temporary state."
                required
                defaultValue={initialValues.objective}
                rows={4}
              />

              <div className="skillTwoColumnFields">
                <RadixTextField
                  error={draftState.fieldErrors?.collectionName?.[0]}
                  label="Collection"
                  name="collectionName"
                  placeholder="Spanish grammar"
                  defaultValue={initialValues.collectionName}
                />
                <RadixTextField
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
              <RadixTextArea
                error={draftState.fieldErrors?.rules?.[0]}
                label="Rules"
                name="rules"
                placeholder={"Use ser for identity.\nUse estar for location and temporary state."}
                defaultValue={initialValues.rules}
                rows={4}
              />

              <RadixTextArea
                error={draftState.fieldErrors?.examples?.[0]}
                label="Examples"
                name="examples"
                placeholder={"Soy estudiante.\nEstoy en casa."}
                defaultValue={initialValues.examples}
                rows={4}
              />

              <RadixTextArea
                error={draftState.fieldErrors?.exerciseConstraints?.[0]}
                label="Exercise constraints"
                name="exerciseConstraints"
                placeholder="Use short choices, avoid trick questions, and keep starter exercises beginner-friendly."
                defaultValue={initialValues.exerciseConstraints}
                rows={3}
              />
            </div>
          </fieldset>

          <div className="skillFormActions">
            <PressButton
              className={mode === "create" ? "secondaryButton" : "primaryButton"}
              disabled={isSaving}
              type="submit"
              variant={mode === "create" ? "white" : "blue"}
            >
              <FloppyDisk size={18} weight="bold" aria-hidden="true" />
              <span>
                {isSaving ? "Saving" : mode === "create" ? "Create skill" : "Save changes"}
              </span>
            </PressButton>
          </div>
        </form>
      </Card>

      {mode === "edit" && skillId ? (
        <Card asChild size="3" variant="surface">
          <section className="skillPanel skillActivationPanel" aria-labelledby="activate-skill-title">
            <div className="skillPanelHeader">
              <div>
                <h2 id="activate-skill-title">Add to practice</h2>
              </div>
            </div>
            <p>
              LearnRecur prepares and verifies starter exercises, then schedules this skill
              for practice.
            </p>

            <form action={activateAction} className="skillActivationForm">
              <input name="skillId" type="hidden" value={skillId} />
              <PressButton className="primaryButton" disabled={isActivating} type="submit">
                <PlusCircle size={18} weight="bold" aria-hidden="true" />
                <span>{isActivating ? "Adding" : "Add skill"}</span>
              </PressButton>
            </form>
          </section>
        </Card>
      ) : null}
    </div>
  );
}
