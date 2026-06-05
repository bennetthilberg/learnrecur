"use client";

import { useActionState } from "react";

import {
  removeSkillSourceAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillSourceRemoveForm({
  skillId,
  sourceRefId,
}: {
  skillId: string;
  sourceRefId: string;
}) {
  const [state, action, isPending] = useActionState(removeSkillSourceAction, idleState);

  return (
    <details className="skillSourceRemove">
      <summary>Remove source</summary>
      <form action={action}>
        <input name="skillId" type="hidden" value={skillId} />
        <input name="sourceRefId" type="hidden" value={sourceRefId} />
        <label className="skillSourceConfirm">
          <input name="confirmRemove" required type="checkbox" value="yes" />
          <span>Remove the stored source text from this skill.</span>
        </label>
        <p>
          Existing exercises and review history will stay. Future generation will use the skill
          definition without this source.
        </p>
        {state.message ? (
          <p className="skillFormMessage" data-tone={state.status}>
            {state.message}
          </p>
        ) : null}
        <button className="secondaryButton" data-tone="danger" disabled={isPending} type="submit">
          {isPending ? "Removing..." : "Remove"}
        </button>
      </form>
    </details>
  );
}
