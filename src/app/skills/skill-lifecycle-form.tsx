"use client";

import { useActionState } from "react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage } from "@/components/app/radix-form";

import { updateSkillLifecycleAction, type SkillFormActionState } from "./actions";

type SkillLifecycleFormProps = {
  actionType: "pause" | "resume" | "archive" | "restore";
  buttonLabel: string;
  pendingLabel: string;
  skillId: string;
  description?: string;
  confirmationLabel?: string;
  summaryLabel?: string;
  tone?: "default" | "danger";
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillLifecycleForm({
  actionType,
  buttonLabel,
  pendingLabel,
  skillId,
  description,
  confirmationLabel,
  summaryLabel,
  tone = "default",
}: SkillLifecycleFormProps) {
  const [state, formAction, pending] = useActionState(
    updateSkillLifecycleAction,
    initialState,
  );
  const form = (
    <form className="skillLifecycleForm" action={formAction}>
      <input name="skillId" type="hidden" value={skillId} />
      <input name="lifecycleAction" type="hidden" value={actionType} />
      {confirmationLabel ? (
        <label className="skillLifecycleConfirm">
          <input name="confirmLifecycle" required type="checkbox" value="yes" />
          <span>{confirmationLabel}</span>
        </label>
      ) : null}
      {description ? <p>{description}</p> : null}
      {state.message ? (
        <RadixFormMessage tone={state.status === "saved" ? "saved" : "error"}>
          {state.message}
        </RadixFormMessage>
      ) : null}
      <PressButton
        className="secondaryButton"
        data-tone={tone === "danger" ? "danger" : undefined}
        disabled={pending}
        type="submit"
        variant="white"
      >
        {pending ? pendingLabel : buttonLabel}
      </PressButton>
    </form>
  );

  if (!confirmationLabel) {
    return form;
  }

  return (
    <details className="skillLifecycleDetails">
      <summary>{summaryLabel ?? buttonLabel}</summary>
      {form}
    </details>
  );
}
