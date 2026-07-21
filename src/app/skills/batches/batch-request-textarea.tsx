"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useFormStatus } from "react-dom";

type BatchRequestTextareaProps = ComponentPropsWithoutRef<"textarea">;

export function BatchRequestTextarea({
  disabled,
  ...props
}: BatchRequestTextareaProps) {
  const { pending } = useFormStatus();

  return <textarea {...props} aria-busy={pending} disabled={disabled || pending} />;
}
