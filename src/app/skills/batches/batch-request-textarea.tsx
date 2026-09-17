"use client";

import { useId, type ComponentPropsWithoutRef } from "react";
import { useFormStatus } from "react-dom";
import { z } from "zod";
import { useFormDraft } from "@/components/app/use-form-draft";
import { FormDraftNotice } from "@/components/app/form-draft-notice";

const requestDraftSchema = z.object({ instruction: z.string().max(4000), requestId: z.string().max(200) });
type BatchRequestTextareaProps = Omit<ComponentPropsWithoutRef<"textarea">, "value"> & { draftScope: string; idempotencyKey?: string };

export function BatchRequestTextarea({
  disabled, defaultValue, draftScope, idempotencyKey, onChange, id, ...props
}: BatchRequestTextareaProps) {
  const { pending } = useFormStatus();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const draft = useFormDraft(`batch-request:${draftScope}`, { instruction: String(defaultValue ?? ""), requestId: "" }, requestDraftSchema);

  return <>
    <div className="skillField">
      <label htmlFor={inputId}>Skill request</label>
      <textarea {...props} id={inputId} value={draft.value.instruction} aria-busy={pending} disabled={disabled || pending || !draft.ready}
        onChange={(event) => {
          // Keep retries of the same request idempotent, including after refresh.
          // Editing expresses a new request, so it receives a new identity.
          draft.update({ instruction: event.currentTarget.value, requestId: idempotencyKey ? crypto.randomUUID() : "" });
          onChange?.(event);
        }} />
    </div>
    {idempotencyKey ? <input type="hidden" name="idempotencyKey" value={draft.value.requestId || idempotencyKey} /> : null}
    <FormDraftNotice {...draft} disabled={Boolean(disabled || pending || !draft.ready)} restoredMessage="Unfinished request restored. Review it before continuing." onDiscard={() => draft.discard()} />
  </>;
}
