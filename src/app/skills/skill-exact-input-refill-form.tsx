"use client";

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
