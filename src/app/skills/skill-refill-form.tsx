"use client";

import { useActionState } from "react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage } from "@/components/app/radix-form";

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
      <PressButton
        className={canRefill || isPending ? "primaryButton" : "secondaryButton"}
        disabled={!canRefill || isPending}
        type="submit"
        variant={canRefill || isPending ? "blue" : "white"}
      >
        {isPending ? "Preparing" : buttonLabel}
      </PressButton>
      {state.message ? (
        <RadixFormMessage tone={state.status === "saved" ? "saved" : "error"}>
          {state.message}
        </RadixFormMessage>
      ) : null}
    </form>
  );
}
