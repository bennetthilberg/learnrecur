"use client";

import { useActionState } from "react";

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
      <summary>Delete permanently</summary>
      <form className="skillLifecycleForm skillDeleteForm" action={formAction}>
        <input name="skillId" type="hidden" value={skillId} />
        <p>
          Permanent delete removes this skill and its generated practice history. Shared source
          material stays linked to any other skills.
        </p>
        <label className="skillDeleteConfirm">
          <span>Type the skill title to confirm.</span>
          <input
            autoComplete="off"
            disabled={pending}
            name="confirmationTitle"
            placeholder={skillTitle}
            required
            type="text"
          />
        </label>
        {state.message ? (
          <p className="skillFormMessage" data-tone={state.status}>
            {state.message}
          </p>
        ) : null}
        <button className="secondaryButton" data-tone="danger" disabled={pending} type="submit">
          {pending ? "Deleting..." : "Delete skill"}
        </button>
      </form>
    </details>
  );
}
