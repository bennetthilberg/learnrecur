"use client";

import { useActionState } from "react";

import { refillChoiceExercisesAction, type SkillFormActionState } from "./actions";

type SkillRefillFormProps = {
  skillId: string;
  canRefill: boolean;
  buttonLabel?: string;
};

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillRefillForm({
  skillId,
  canRefill,
  buttonLabel = "Queue more exercises",
}: SkillRefillFormProps) {
  const [state, action, isPending] = useActionState(refillChoiceExercisesAction, idleState);

  return (
    <form action={action} className="skillRefillForm">
      <input name="skillId" type="hidden" value={skillId} />
      <button
        className={canRefill || isPending ? "primaryButton" : "secondaryButton"}
        disabled={!canRefill || isPending}
        type="submit"
      >
        {isPending ? "Queuing" : buttonLabel}
      </button>
      {state.message ? (
        <p className="skillFormMessage" data-tone={state.status} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
