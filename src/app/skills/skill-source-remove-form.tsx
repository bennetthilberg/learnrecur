"use client";

import { useActionState, useEffect } from "react";
import { CheckCircle, Trash, WarningCircle } from "@phosphor-icons/react";
import { Checkbox } from "@radix-ui/themes";
import { notifications } from "@/components/app/notifications";
import { PressButton } from "@/components/app/open-water";

import {
  removeSkillSourceAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const sourceRemoveNotificationId = "skill-source-remove-notice";

export function SkillSourceRemoveForm({
  skillId,
  sourceLabel,
  sourceRefId,
}: {
  skillId: string;
  sourceLabel: string;
  sourceRefId: string;
}) {
  const [state, action, isPending] = useActionState(removeSkillSourceAction, idleState);

  useEffect(() => {
    if (!state.message || state.status === "idle") {
      return;
    }

    const isSaved = state.status === "saved";
    notifications.show({
      id: sourceRemoveNotificationId,
      autoClose: isSaved ? 3500 : 8000,
      className: "learnrecurNotification",
      color: isSaved ? "leaf" : "amber",
      icon: isSaved ? (
        <CheckCircle size={18} weight="bold" />
      ) : (
        <WarningCircle size={18} weight="bold" />
      ),
      message: state.message,
      position: "top-right",
      title: isSaved ? "Source removed" : "Could not remove source",
      withBorder: true,
      withCloseButton: true,
    });
  }, [state]);

  return (
    <details className="skillSourceRemove">
      <summary aria-label={`Remove source ${sourceLabel}`}>
        <Trash size={16} weight="bold" aria-hidden="true" />
        <span>Remove source</span>
      </summary>
      <form action={action}>
        <input name="skillId" type="hidden" value={skillId} />
        <input name="sourceRefId" type="hidden" value={sourceRefId} />
        <label className="skillSourceConfirm">
          <Checkbox
            color="blue"
            highContrast
            name="confirmRemove"
            required
            size="2"
            value="yes"
            variant="surface"
          />
          <span>Remove {sourceLabel} from this skill.</span>
        </label>
        <p>
          Existing exercises and review history will stay. Future exercise preparation will use
          the skill definition without this source.
        </p>
        <PressButton className="secondaryButton" data-tone="danger" disabled={isPending} type="submit" variant="white">
          <Trash size={16} weight="bold" aria-hidden="true" />
          <span>{isPending ? "Removing" : "Remove"}</span>
        </PressButton>
      </form>
    </details>
  );
}
