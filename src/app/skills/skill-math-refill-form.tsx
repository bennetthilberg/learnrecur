"use client";

import { ActionNotification } from "@/components/app/action-notification";

import { useActionState } from "react";

import { refillMathExercisesAction, type SkillFormActionState } from "./actions";

type SkillMathRefillFormProps = {
  buttonLabel: string;
  canRefill: boolean;
  skillId: string;
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillMathRefillForm({
  buttonLabel,
  canRefill,
  skillId,
}: SkillMathRefillFormProps) {
  const [state, formAction, pending] = useActionState(
    refillMathExercisesAction,
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
          id={`math-refill-${skillId}`}
          message={pending ? null : state.message}
          title="Prepare exercises"
          tone={state.status === "error" ? "error" : "success"}
        />
      ) : null}
    </form>
  );
}
