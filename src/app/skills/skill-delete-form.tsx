"use client";

import { ActionNotification } from "@/components/app/action-notification";

import { useActionState, useState } from "react";

import {
  deleteSkillPermanentlyAction,
  type SkillFormActionState,
} from "./actions";

type SkillDeleteFormProps = {
  skillId: string;
  skillTitle: string;
  inline?: boolean;
  onCancel?: () => void;
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillDeleteForm({
  skillId,
  skillTitle,
  inline = false,
  onCancel,
}: SkillDeleteFormProps) {
  const [state, formAction, pending] = useActionState(
    deleteSkillPermanentlyAction,
    initialState,
  );

  const [confirmation, setConfirmation] = useState("");
  const form = (
    <form className="skillLifecycleForm skillDeleteForm" action={formAction}>
      <input name="skillId" type="hidden" value={skillId} />
      <p>
        Permanent delete removes this skill, its exercises, and its practice
        history. Shared source material stays linked to any other skills.
      </p>
      <label className="skillDeleteConfirm">
        <span>Type the skill title to confirm.</span>
        <input
          autoComplete="off"
          disabled={pending}
          name="confirmationTitle"
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          placeholder={skillTitle}
          required
          type="text"
        />
      </label>
      {state.message ? (
        <ActionNotification
          id={`skill-delete-${skillId}`}
          message={pending ? null : state.message}
          title="Delete skill"
          tone={state.status === "error" ? "error" : "success"}
        />
      ) : null}
      <div className="skillActionDialogActions">
        {onCancel ? (
          <button
            className="secondaryButton"
            data-autofocus
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        ) : null}
        <button
          className="secondaryButton"
          data-tone="danger"
          disabled={pending || confirmation.trim() !== skillTitle.trim()}
          type="submit"
        >
          {pending ? "Deleting" : "Delete skill"}
        </button>
      </div>
    </form>
  );
  return inline ? (
    form
  ) : (
    <details className="skillLifecycleDetails skillDeleteDetails">
      <summary aria-label={`Delete skill ${skillTitle} permanently`}>
        Delete permanently
      </summary>
      {form}
    </details>
  );
}
