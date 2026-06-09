"use client";

import { useActionState } from "react";

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
          <button
            aria-label={`Requeue source upload ${sourceFileName}`}
            className="secondaryButton"
            disabled={requeuePending}
            type="submit"
          >
            {requeuePending ? "Requeueing" : "Requeue"}
          </button>
          {requeueState.message ? (
            <p className="skillFormMessage" data-tone={requeueState.status} role="status">
              {requeueState.message}
            </p>
          ) : null}
        </form>
      ) : null}

      {canDismiss ? (
        <form action={dismissAction}>
          <input name="sourceFileId" type="hidden" value={sourceFileId} />
          <button
            aria-label={`Dismiss failed source upload ${sourceFileName}`}
            className="secondaryButton"
            data-tone="danger"
            disabled={dismissPending}
            type="submit"
          >
            {dismissPending ? "Dismissing" : "Dismiss"}
          </button>
          {dismissState.message ? (
            <p className="skillFormMessage" data-tone={dismissState.status} role="status">
              {dismissState.message}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
