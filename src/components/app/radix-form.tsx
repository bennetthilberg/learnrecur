"use client";

import { Callout, TextArea, TextField } from "@radix-ui/themes";
import { useId, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";

export type FieldControlProps = {
  error?: string;
  label: string;
  name: string;
};

type RadixTextFieldProps = FieldControlProps &
  Omit<
    ComponentPropsWithoutRef<typeof TextField.Root>,
    "color" | "name" | "radius" | "size" | "variant"
  >;

type RadixTextAreaProps = FieldControlProps &
  Omit<ComponentPropsWithoutRef<typeof TextArea>, "color" | "name" | "radius" | "size" | "variant"> & {
    inputRef?: Ref<HTMLTextAreaElement>;
  };

export function FieldError({ error, id }: { error?: string; id: string }) {
  if (!error) {
    return null;
  }

  return <em id={id}>{error}</em>;
}

export function RadixTextField({
  error,
  label,
  name,
  "aria-describedby": ariaDescribedBy,
  className = "",
  ...props
}: RadixTextFieldProps) {
  const errorId = useId();
  const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <label className={`skillField radixSkillField ${className}`.trim()}>
      <span>{label}</span>
      <TextField.Root
        aria-describedby={describedBy}
        aria-invalid={error ? "true" : undefined}
        color={error ? "red" : "blue"}
        name={name}
        radius="medium"
        size="2"
        variant="surface"
        {...props}
      />
      <FieldError error={error} id={errorId} />
    </label>
  );
}

export function RadixTextArea({
  error,
  inputRef,
  label,
  name,
  "aria-describedby": ariaDescribedBy,
  className = "",
  ...props
}: RadixTextAreaProps) {
  const errorId = useId();
  const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <label className={`skillField radixSkillField ${className}`.trim()}>
      <span>{label}</span>
      <TextArea
        aria-describedby={describedBy}
        aria-invalid={error ? "true" : undefined}
        color={error ? "red" : "blue"}
        name={name}
        radius="medium"
        ref={inputRef}
        size="2"
        variant="surface"
        {...props}
      />
      <FieldError error={error} id={errorId} />
    </label>
  );
}

export function RadixFormMessage({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "error" | "neutral" | "saved";
}) {
  return (
    <Callout.Root
      className="skillFormMessage radixFormMessage"
      color={tone === "error" ? "red" : tone === "saved" ? "green" : "gray"}
      data-tone={tone}
      role="status"
      size="1"
      variant="surface"
    >
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
  );
}
