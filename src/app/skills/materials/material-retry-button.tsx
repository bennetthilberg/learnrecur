"use client";

import { useFormStatus } from "react-dom";

export function MaterialRetryButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <button
      aria-busy={pending}
      className="secondaryButton materialRetryButton"
      disabled={pending}
      type="submit"
    >
      <span className="buttonPendingContent">
        {pending ? <span className="buttonSpinner" aria-hidden="true" /> : null}
        <span aria-live="polite">{pending ? "Retrying processing" : children}</span>
      </span>
    </button>
  );
}
