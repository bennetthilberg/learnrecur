"use client";

import { useFormStatus } from "react-dom";

export function BatchSubmitButton({
  children,
  className = "primaryButton",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button aria-busy={pending} className={className} disabled={pending} type="submit">
      <span className="buttonPendingContent">
        {pending ? <span className="buttonSpinner" aria-hidden="true" /> : null}
        <span>{children}</span>
      </span>
    </button>
  );
}
