"use client";

import { useActionState } from "react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage } from "@/components/app/radix-form";

import {
  dismissFailedSourceUploadAction,
  requeueSourceUploadAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SourceProcessingControls({
  sourceFileId,
  sourceFileName,
  canRequeue,
  canDismiss,
}: {
  sourceFileId: string;
  sourceFileName: string;
  canRequeue: boolean;
  canDismiss: boolean;
}) {
  const [requeueState, requeueAction, requeuePending] = useActionState(
    requeueSourceUploadAction,
    idleState,
  );
  const [dismissState, dismissAction, dismissPending] = useActionState(
    dismissFailedSourceUploadAction,
    idleState,
  );

  if (!canRequeue && !canDismiss) {
    return null;
  }

  return (
    <div className="sourceProcessingControls">
      {canRequeue ? (
        <form action={requeueAction}>
          <input name="sourceFileId" type="hidden" value={sourceFileId} />
          <PressButton
            aria-label={`Try draft preparation again for ${sourceFileName}`}
            className="secondaryButton"
            disabled={requeuePending}
            type="submit"
            variant="white"
          >
            {requeuePending ? "Trying again" : "Try again"}
          </PressButton>
          {requeueState.message ? (
            <RadixFormMessage tone={requeueState.status === "saved" ? "saved" : "error"}>
              {requeueState.message}
            </RadixFormMessage>
          ) : null}
        </form>
      ) : null}

      {canDismiss ? (
        <form action={dismissAction}>
          <input name="sourceFileId" type="hidden" value={sourceFileId} />
          <PressButton
            aria-label={`Dismiss failed source upload ${sourceFileName}`}
            className="secondaryButton"
            data-tone="danger"
            disabled={dismissPending}
            type="submit"
            variant="white"
          >
            {dismissPending ? "Dismissing" : "Dismiss"}
          </PressButton>
          {dismissState.message ? (
            <RadixFormMessage tone={dismissState.status === "saved" ? "saved" : "error"}>
              {dismissState.message}
            </RadixFormMessage>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
