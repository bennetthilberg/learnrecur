"use client";

import { useActionState } from "react";

import { refillChoiceExercisesAction, type SkillFormActionState } from "./actions";

type SkillRefillFormProps = {
  skillId: string;
  canRefill: boolean;
};

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillRefillForm({ skillId, canRefill }: SkillRefillFormProps) {
  const [state, action, isPending] = useActionState(refillChoiceExercisesAction, idleState);

  return (
    <form action={action} className="skillRefillForm">
      <input name="skillId" type="hidden" value={skillId} />
      <button className="primaryButton" disabled={!canRefill || isPending} type="submit">
        {isPending ? "Generating..." : canRefill ? "Generate more exercises" : "Queue full"}
      </button>
      {state.message ? (
        <p className="skillFormMessage" data-tone={state.status}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
