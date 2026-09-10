"use client";

import { ActionNotification } from "@/components/app/action-notification";

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
  buttonLabel = "Prepare more exercises",
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
        {isPending ? "Preparing" : buttonLabel}
      </button>
      {state.message ? (
        <ActionNotification
          id={`choice-refill-${skillId}`}
          message={isPending ? null : state.message}
          title="Prepare exercises"
          tone={state.status === "error" ? "error" : "success"}
        />
      ) : null}
    </form>
  );
}
