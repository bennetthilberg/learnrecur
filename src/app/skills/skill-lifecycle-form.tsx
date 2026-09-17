"use client";

import { ActionNotification } from "@/components/app/action-notification";

import { useActionState } from "react";

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
        <ActionNotification
          id={`skill-lifecycle-${skillId}-${actionType}`}
          message={pending ? null : state.message}
          title="Update skill"
          tone={state.status === "error" ? "error" : "success"}
        />
      ) : null}
      <button
        className="secondaryButton"
        data-tone={tone === "danger" ? "danger" : undefined}
        disabled={pending}
        type="submit"
      >
        {pending ? pendingLabel : buttonLabel}
      </button>
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
