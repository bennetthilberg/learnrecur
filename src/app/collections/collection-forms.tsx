"use client";

import { useActionState } from "react";
import { Archive, ArrowClockwise, PencilSimple } from "@phosphor-icons/react";

import { PressButton } from "@/components/app/open-water";
import { RadixFormMessage, RadixTextArea, RadixTextField } from "@/components/app/radix-form";
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
        <RadixTextField
          error={state.fieldErrors?.name?.[0]}
          label="Name"
          name="name"
          disabled={pending}
          maxLength={80}
          placeholder="Spanish grammar"
          required
        />
        <RadixTextArea
          error={state.fieldErrors?.description?.[0]}
          label="Description"
          name="description"
          disabled={pending}
          maxLength={500}
          placeholder="What belongs in this study area?"
          rows={2}
        />
        <div className="collectionCreateAction">
          <PressButton className="primaryButton" disabled={pending} type="submit">
            {pending ? "Creating" : "Create collection"}
          </PressButton>
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
      <summary aria-label={`Edit collection ${collection.name}`}>
        <PencilSimple aria-hidden="true" size={17} weight="regular" />
        <span>Edit</span>
      </summary>
      <form action={formAction} className="collectionInlineForm">
        <input name="collectionId" type="hidden" value={collection.id} />
        <RadixTextField
          error={state.fieldErrors?.name?.[0]}
          label="Name"
          name="name"
          defaultValue={collection.name}
          disabled={pending}
          maxLength={80}
          required
        />
        <RadixTextArea
          error={state.fieldErrors?.description?.[0]}
          label="Description"
          name="description"
          defaultValue={collection.description ?? ""}
          disabled={pending}
          maxLength={500}
          rows={3}
        />

        <div className="skillFormActions">
          <PressButton className="secondaryButton" disabled={pending} type="submit" variant="white">
            {pending ? "Saving" : "Save changes"}
          </PressButton>
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
        <PressButton
          className="secondaryButton"
          data-tone="danger"
          disabled={pending}
          type="submit"
          variant="white"
        >
          {pending ? "Archiving" : "Archive collection"}
        </PressButton>
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
      <PressButton
        aria-label={`Restore collection ${collectionName}`}
        className="secondaryButton"
        disabled={pending}
        type="submit"
        variant="white"
      >
        <ArrowClockwise aria-hidden="true" size={17} weight="regular" />
        {pending ? "Restoring" : "Restore collection"}
      </PressButton>
      <FormMessage state={state} />
    </form>
  );
}

function FormMessage({ state }: { state: CollectionFormActionState }) {
  if (!state.message || state.status === "idle") {
    return null;
  }

  return (
    <RadixFormMessage tone={state.status === "saved" ? "saved" : "error"}>
      {state.message}
    </RadixFormMessage>
  );
}
