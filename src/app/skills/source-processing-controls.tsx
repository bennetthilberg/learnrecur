"use client";

import { useActionState, useEffect } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

import {
  requeueSourceUploadAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const sourceProcessingNotificationId = "source-processing-controls-notice";

export function SourceProcessingControls({
  sourceFileId,
  sourceFileName,
  canRequeue,
}: {
  sourceFileId: string;
  sourceFileName: string;
  canRequeue: boolean;
}) {
  const [requeueState, requeueAction, requeuePending] = useActionState(
    requeueSourceUploadAction,
    idleState,
  );

  useEffect(() => {
    if (!requeueState.message || requeueState.status === "idle") {
      return;
    }

    const saved = requeueState.status === "saved";

    notifications.show({
      id: sourceProcessingNotificationId,
      autoClose: saved ? 4500 : 9000,
      className: "learnrecurNotification",
      color: saved ? "leaf" : "amber",
      icon: saved ? (
        <CheckCircle size={18} weight="bold" />
      ) : (
        <WarningCircle size={18} weight="bold" />
      ),
      message: requeueState.message,
      position: "top-right",
      title: saved ? "Skill preparation restarted" : "Could not restart preparation",
      withBorder: true,
      withCloseButton: true,
    });
  }, [requeueState]);

  if (!canRequeue) {
    return null;
  }

  return (
    <div className="sourceProcessingControls">
      <form action={requeueAction}>
        <input name="sourceFileId" type="hidden" value={sourceFileId} />
        <button
          aria-label={`Try skill preparation again for ${sourceFileName}`}
          className="secondaryButton"
          disabled={requeuePending}
          type="submit"
        >
          {requeuePending ? "Trying again" : "Try again"}
        </button>
      </form>
    </div>
  );
}
