"use client";

import { useActionState } from "react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage } from "@/components/app/radix-form";

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
      <PressButton className="secondaryButton" type="submit" disabled={!canRefill || pending} variant="white">
        {pending ? "Preparing" : buttonLabel}
      </PressButton>
      {state.message ? (
        <RadixFormMessage tone={state.status === "error" ? "error" : "saved"}>
          {state.message}
        </RadixFormMessage>
      ) : null}
    </form>
  );
}
