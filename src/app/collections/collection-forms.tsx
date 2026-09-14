"use client";

import { useFormDraft } from "@/components/app/use-form-draft";
import { FormDraftNotice } from "@/components/app/form-draft-notice";
import { collectionDraftSchema } from "@/lib/forms/collection-drafts";

import { ActionNotification } from "@/components/app/action-notification";
import { PracticePreferencesForm } from "@/components/app/practice-preferences-form";

import { useActionState, useId } from "react";
import { Archive, ArrowClockwise, PencilSimple } from "@phosphor-icons/react";

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
  const draft = useFormDraft("collection-create", { name: "", description: "" }, collectionDraftSchema);
  const [state, formAction, submitting] = useActionState(async (previous: CollectionFormActionState, formData: FormData) => {
    const result = await saveCollectionSafely(createCollectionAction, previous, formData);
    if (result.status === "saved") draft.discard();
    return result;
  }, idleState);
  const pending = submitting || !draft.ready;
  const nameErrorId = useId();
  const descriptionErrorId = useId();

  return (
    <form action={formAction} className="collectionCreateForm">
      <div className="collectionCreateGrid">
        <label className="skillField">
          <span>Name</span>
          <input
            aria-describedby={hasFieldError(state, "name") ? nameErrorId : undefined}
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            disabled={pending}
            maxLength={80}
            name="name"
            value={draft.value.name}
            onChange={(event) => draft.update({ name: event.currentTarget.value })}
            placeholder="Spanish grammar"
            required
          />
          <FieldError id={nameErrorId} state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <textarea
            aria-describedby={
              hasFieldError(state, "description") ? descriptionErrorId : undefined
            }
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            disabled={pending}
            maxLength={500}
            name="description"
            value={draft.value.description}
            onChange={(event) => draft.update({ description: event.currentTarget.value })}
            placeholder="What belongs in this collection?"
            rows={2}
          />
          <FieldError id={descriptionErrorId} state={state} name="description" />
        </label>
        <div className="collectionCreateAction">
          <button className="primaryButton" disabled={pending} type="submit">
            {pending ? "Creating" : "Create collection"}
          </button>
        </div>
      </div>

      <FormDraftNotice {...draft} disabled={pending} onDiscard={() => draft.discard()} />
      <FormMessage state={state} pending={pending} />
    </form>
  );
}

export function CollectionUpdateForm({
  collection,
}: {
  collection: CollectionSummary;
}) {
  const draft = useFormDraft(`collection-edit:${collection.id}`, { name: collection.name, description: collection.description ?? "" }, collectionDraftSchema);
  const [state, formAction, submitting] = useActionState(async (previous: CollectionFormActionState, formData: FormData) => {
    const result = await saveCollectionSafely(updateCollectionAction, previous, formData);
    if (result.status === "saved") draft.saved();
    return result;
  }, idleState);
  const pending = submitting || !draft.ready;
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
          <input
            aria-describedby={hasFieldError(state, "name") ? nameErrorId : undefined}
            aria-invalid={hasFieldError(state, "name") ? "true" : undefined}
            disabled={pending}
            maxLength={80}
            name="name"
            value={draft.value.name}
            onChange={(event) => draft.update({ name: event.currentTarget.value })}
            required
          />
          <FieldError id={nameErrorId} state={state} name="name" />
        </label>
        <label className="skillField">
          <span>Description</span>
          <textarea
            aria-describedby={
              hasFieldError(state, "description") ? descriptionErrorId : undefined
            }
            aria-invalid={hasFieldError(state, "description") ? "true" : undefined}
            disabled={pending}
            maxLength={500}
            name="description"
            value={draft.value.description}
            onChange={(event) => draft.update({ description: event.currentTarget.value })}
            rows={3}
          />
          <FieldError id={descriptionErrorId} state={state} name="description" />
        </label>

        <div className="skillFormActions">
          <button className="secondaryButton" disabled={pending} type="submit">
            {pending ? "Saving" : "Save changes"}
          </button>
        </div>
        <FormDraftNotice {...draft} disabled={pending} onDiscard={() => draft.discard()} />
        <FormMessage state={state} pending={pending} />
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
        <FormMessage state={state} pending={pending} />
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
      <FormMessage state={state} pending={pending} />
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

function FormMessage({ state, pending }: { state: CollectionFormActionState; pending: boolean }) {
  const id = useId();
  if (!state.message || state.status === "idle") {
    return null;
  }

  return (
    <ActionNotification
      id={id}
      message={pending ? null : state.message}
      title={state.status === "saved" ? "Collection updated" : "Could not update collection"}
      tone={state.status === "saved" ? "success" : "error"}
    />
  );
}

function hasFieldError(state: CollectionFormActionState, field: string) {
  return Boolean(state.fieldErrors?.[field]?.length);
}

export function CollectionPracticeForm({collection}:{collection:CollectionSummary}) {
  return <details className="collectionInlineDetails"><summary>Practice preferences</summary>
    <div className="collectionInlineForm"><PracticePreferencesForm target={{scope:"collection",id:collection.id}} preference={collection.practicePreference ?? null} inheritedPreference={collection.inheritedPreference} textPolicy={collection.textPolicy}/></div>
  </details>;
}

async function saveCollectionSafely(
  action: typeof createCollectionAction,
  previous: CollectionFormActionState,
  formData: FormData,
): Promise<CollectionFormActionState> {
  try { return await action(previous, formData); }
  catch { return { status: "error", message: "Could not save the collection. Check your connection and try again." }; }
}
