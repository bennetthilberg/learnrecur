"use client";

import { useActionState, useId } from "react";
import { Archive, ArrowClockwise, PencilSimple } from "@phosphor-icons/react";
import { TextArea, TextField } from "@radix-ui/themes";

import type { CollectionSummary } from "@/lib/collections";

import {
  archiveCollectionAction,
  createCollectionAction,
  restoreCollectionAction,
  updateCollectionAction,
  type CollectionFormActionState,
} from "./actions";

const idleState: CollectionFormActionState = {
  status: "idle",
  message: null,
};

export function CollectionCreateForm() {
  const [state, formAction, pending] = useActionState(createCollectionAction, idleState);
  const nameErrorId = useId();
  const descriptionErrorId = useId();

  return (
    <form action={formAction} className="collectionCreateForm">
      <div className="collectionCreateGrid">
        <label className="skillField">
          <span>Name</span>
          <TextField.Root
            aria-describedby={hasFieldError(state, "name") ? nameErrorId : undefined}
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            disabled={pending}
            maxLength={80}
            name="name"
            placeholder="Spanish grammar"
            radius="medium"
            required
            variant="surface"
          />
          <FieldError id={nameErrorId} state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <TextArea
            aria-describedby={
              hasFieldError(state, "description") ? descriptionErrorId : undefined
            }
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            disabled={pending}
            maxLength={500}
            name="description"
            placeholder="What belongs in this study area?"
            radius="medium"
            resize="vertical"
            rows={2}
            variant="surface"
          />
          <FieldError id={descriptionErrorId} state={state} name="description" />
        </label>
        <div className="collectionCreateAction">
          <button className="primaryButton" disabled={pending} type="submit">
            {pending ? "Creating" : "Create collection"}
          </button>
        </div>
      </div>

      <FormMessage state={state} />
    </form>
  );
}

export function CollectionUpdateForm({
  collection,
}: {
  collection: CollectionSummary;
}) {
  const [state, formAction, pending] = useActionState(updateCollectionAction, idleState);
  const nameErrorId = useId();
  const descriptionErrorId = useId();

  return (
    <details className="collectionInlineDetails">
      <summary aria-label={`Edit collection ${collection.name}`}>
        <PencilSimple aria-hidden="true" size={17} weight="regular" />
        <span>Edit</span>
      </summary>
      <form action={formAction} className="collectionInlineForm">
        <input name="collectionId" type="hidden" value={collection.id} />
        <label className="skillField">
          <span>Name</span>
          <TextField.Root
            aria-describedby={hasFieldError(state, "name") ? nameErrorId : undefined}
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            defaultValue={collection.name}
            disabled={pending}
            maxLength={80}
            name="name"
            radius="medium"
            required
            variant="surface"
          />
          <FieldError id={nameErrorId} state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <TextArea
            aria-describedby={
              hasFieldError(state, "description") ? descriptionErrorId : undefined
            }
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            defaultValue={collection.description ?? ""}
            disabled={pending}
            maxLength={500}
            name="description"
            radius="medium"
            resize="vertical"
            rows={3}
            variant="surface"
          />
          <FieldError id={descriptionErrorId} state={state} name="description" />
        </label>

        <div className="skillFormActions">
          <button className="secondaryButton" disabled={pending} type="submit">
            {pending ? "Saving" : "Save changes"}
          </button>
        </div>
        <FormMessage state={state} />
      </form>
    </details>
  );
}

export function CollectionArchiveForm({
  collectionId,
  collectionName,
}: {
  collectionId: string;
  collectionName: string;
}) {
  const [state, formAction, pending] = useActionState(archiveCollectionAction, idleState);

  return (
    <details className="collectionInlineDetails collectionInlineDetailsDanger">
      <summary aria-label={`Archive collection ${collectionName}`}>
        <Archive aria-hidden="true" size={17} weight="regular" />
        <span>Archive</span>
      </summary>
      <form action={formAction} className="collectionInlineForm">
        <input name="collectionId" type="hidden" value={collectionId} />
        <p>
          Archive this collection from dashboard summaries. Its skills can still appear in
          practice.
        </p>
        <button className="secondaryButton" data-tone="danger" disabled={pending} type="submit">
          {pending ? "Archiving" : "Archive collection"}
        </button>
        <FormMessage state={state} />
      </form>
    </details>
  );
}

export function CollectionRestoreForm({
  collectionId,
  collectionName,
}: {
  collectionId: string;
  collectionName: string;
}) {
  const [state, formAction, pending] = useActionState(restoreCollectionAction, idleState);

  return (
    <form action={formAction} className="collectionRestoreForm">
      <input name="collectionId" type="hidden" value={collectionId} />
      <button
        aria-label={`Restore collection ${collectionName}`}
        className="secondaryButton"
        disabled={pending}
        type="submit"
      >
        <ArrowClockwise aria-hidden="true" size={17} weight="regular" />
        {pending ? "Restoring" : "Restore collection"}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

function FieldError({
  id,
  state,
  name,
}: {
  id: string;
  state: CollectionFormActionState;
  name: string;
}) {
  const error = state.fieldErrors?.[name]?.[0];

  if (!error) {
    return null;
  }

  return <em id={id}>{error}</em>;
}

function FormMessage({ state }: { state: CollectionFormActionState }) {
  if (!state.message || state.status === "idle") {
    return null;
  }

  return (
    <p className="skillFormMessage" data-tone={state.status === "saved" ? "saved" : "error"} role="status">
      {state.message}
    </p>
  );
}

function hasFieldError(state: CollectionFormActionState, field: string) {
  return Boolean(state.fieldErrors?.[field]?.length);
}
