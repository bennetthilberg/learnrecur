"use client";

import { useFormStatus } from "react-dom";

export function BatchSubmitButton({
  children,
  pendingLabel,
  className = "primaryButton",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button className={className} disabled={pending} type="submit">
      {pending ? pendingLabel : children}
    </button>
  );
}
