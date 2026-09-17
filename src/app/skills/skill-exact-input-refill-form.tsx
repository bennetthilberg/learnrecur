"use client";

import { ActionNotification } from "@/components/app/action-notification";

import { useActionState } from "react";

import { refillExactInputExercisesAction, type SkillFormActionState } from "./actions";

type SkillExactInputRefillFormProps = {
  buttonLabel: string;
  canRefill: boolean;
  skillId: string;
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillExactInputRefillForm({
  buttonLabel,
  canRefill,
  skillId,
}: SkillExactInputRefillFormProps) {
  const [state, formAction, pending] = useActionState(
    refillExactInputExercisesAction,
    initialState,
  );

  return (
    <form className="skillRefillForm" action={formAction}>
      <input name="skillId" type="hidden" value={skillId} />
      <button className="secondaryButton" type="submit" disabled={!canRefill || pending}>
        {pending ? "Preparing" : buttonLabel}
      </button>
      {state.message ? (
        <ActionNotification
          id={`exact-input-refill-${skillId}`}
          message={pending ? null : state.message}
          title="Prepare exercises"
          tone={state.status === "error" ? "error" : "success"}
        />
      ) : null}
    </form>
  );
}
