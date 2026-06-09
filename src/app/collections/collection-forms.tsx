"use client";

import { useActionState } from "react";

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

  return (
    <form action={formAction} className="collectionCreateForm">
      <div className="collectionCreateGrid">
        <label className="skillField">
          <span>Name</span>
          <input
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            disabled={pending}
            maxLength={80}
            name="name"
            placeholder="Spanish grammar"
            required
          />
          <FieldError state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <textarea
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            disabled={pending}
            maxLength={500}
            name="description"
            placeholder="What belongs in this study area?"
            rows={2}
          />
          <FieldError state={state} name="description" />
        </label>
        <div className="collectionCreateAction">
          <button className="primaryButton" disabled={pending} type="submit">
            Create collection
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

  return (
    <details className="collectionInlineDetails">
      <summary aria-label={`Edit collection ${collection.name}`}>Edit</summary>
      <form action={formAction} className="collectionInlineForm">
        <input name="collectionId" type="hidden" value={collection.id} />
        <label className="skillField">
          <span>Name</span>
          <input
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            defaultValue={collection.name}
            disabled={pending}
            maxLength={80}
            name="name"
            required
          />
          <FieldError state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <textarea
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            defaultValue={collection.description ?? ""}
            disabled={pending}
            maxLength={500}
            name="description"
            rows={3}
          />
          <FieldError state={state} name="description" />
        </label>

        <div className="skillFormActions">
          <button className="secondaryButton" disabled={pending} type="submit">
            Save changes
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
      <summary aria-label={`Archive collection ${collectionName}`}>Archive</summary>
      <form action={formAction} className="collectionInlineForm">
        <input name="collectionId" type="hidden" value={collectionId} />
        <p>Archive this collection from dashboard summaries. Its skills stay practiceable.</p>
        <button className="secondaryButton" data-tone="danger" disabled={pending} type="submit">
          Archive collection
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
        Restore collection
      </button>
      <FormMessage state={state} />
    </form>
  );
}

function FieldError({
  state,
  name,
}: {
  state: CollectionFormActionState;
  name: string;
}) {
  const error = state.fieldErrors?.[name]?.[0];

  if (!error) {
    return null;
  }

  return <em>{error}</em>;
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
