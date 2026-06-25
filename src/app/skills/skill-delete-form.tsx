"use client";

import { useActionState } from "react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage, RadixTextField } from "@/components/app/radix-form";

import { deleteSkillPermanentlyAction, type SkillFormActionState } from "./actions";

type SkillDeleteFormProps = {
  skillId: string;
  skillTitle: string;
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillDeleteForm({ skillId, skillTitle }: SkillDeleteFormProps) {
  const [state, formAction, pending] = useActionState(
    deleteSkillPermanentlyAction,
    initialState,
  );

  return (
    <details className="skillLifecycleDetails skillDeleteDetails">
      <summary aria-label={`Delete skill ${skillTitle} permanently`}>Delete permanently</summary>
      <form className="skillLifecycleForm skillDeleteForm" action={formAction}>
        <input name="skillId" type="hidden" value={skillId} />
        <p>
          Permanent delete removes this skill, its exercises, and its practice history. Shared
          source material stays linked to any other skills.
        </p>
        <RadixTextField
          autoComplete="off"
          disabled={pending}
          error={state.fieldErrors?.confirmationTitle?.[0]}
          label="Type the skill title to confirm."
          name="confirmationTitle"
          placeholder={skillTitle}
          required
          type="text"
        />
        {state.message ? (
          <RadixFormMessage tone={state.status === "saved" ? "saved" : "error"}>
            {state.message}
          </RadixFormMessage>
        ) : null}
        <PressButton className="secondaryButton" data-tone="danger" disabled={pending} type="submit" variant="white">
          {pending ? "Deleting" : "Delete skill"}
        </PressButton>
      </form>
    </details>
  );
}
