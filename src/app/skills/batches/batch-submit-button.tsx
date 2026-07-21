"use client";

import { Kbd } from "@mantine/core";
import type { PropsWithChildren } from "react";
import { useFormStatus } from "react-dom";

import { useBatchDescribeShortcut } from "./batch-describe-form";

type BatchSubmitButtonProps = PropsWithChildren<{
  className?: string;
  showReviewShortcut?: boolean;
}>;

export function BatchSubmitButton({
  children,
  className = "primaryButton",
  showReviewShortcut = false,
}: BatchSubmitButtonProps) {
  const { pending } = useFormStatus();
  const detectedShortcut = useBatchDescribeShortcut();
  const shortcut = showReviewShortcut ? detectedShortcut : null;

  return (
    <button
      aria-busy={pending}
      aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
      className={className}
      data-material-review-submit={showReviewShortcut ? "true" : undefined}
      disabled={pending}
      type="submit"
    >
      <span className="buttonPendingContent">
        {pending ? <span className="buttonSpinner" aria-hidden="true" /> : null}
        <span>{children}</span>
        {shortcut ? (
          <span className="batchSubmitShortcut" aria-hidden="true">
            <Kbd>{shortcut.keyLabel}</Kbd>
          </span>
        ) : null}
      </span>
    </button>
  );
}
