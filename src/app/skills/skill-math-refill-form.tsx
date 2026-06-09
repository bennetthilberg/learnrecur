"use client";

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
        {pending ? "Queuing" : buttonLabel}
      </button>
      {state.message ? (
        <p
          className="skillFormMessage"
          data-tone={state.status === "error" ? "error" : "saved"}
          role="status"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
