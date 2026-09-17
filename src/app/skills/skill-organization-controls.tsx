"use client";

import { Modal, Select, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormDraft } from "@/components/app/use-form-draft";
import { FormDraftNotice } from "@/components/app/form-draft-notice";
import { skillOrganizationDraftSchema } from "@/lib/forms/skill-organization";
import { updateSkillOrganizationAction } from "./actions";

type Props = { skillId: string; title: string; collectionId: string | null; collections: { id: string; name: string; disabled?: boolean }[] };
export function SkillOrganizationControls(props: Props) {
  return <div className="skillOrganizationControls"><OrganizationEditor {...props} mode="rename" /><OrganizationEditor {...props} mode="move" /></div>;
}

function OrganizationEditor({ skillId, title, collectionId, collections, mode }: Props & { mode: "rename" | "move" }) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const draft = useFormDraft(`skill-organization:${skillId}:${mode}`, { title, collectionId: collectionId ?? "" }, skillOrganizationDraftSchema);
  const label = mode === "rename" ? "Rename skill" : "Move to collection";
  return <>
    <button className="secondaryButton" type="button" onClick={() => { notifications.hide("skill-organization-notice"); setError(null); setOpened(true); }}>{label}</button>
    <Modal opened={opened} onClose={() => { if (!pending) setOpened(false); }} title={label}
      closeButtonProps={{ "aria-label": `Close ${mode === "rename" ? "rename" : "move"} dialog` }}
      closeOnClickOutside={!pending} closeOnEscape={!pending} withCloseButton={!pending}>
      <form className="skillOrganizationForm" onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          try {
            const result = await updateSkillOrganizationAction({ status: "idle", message: null }, data);
            if (result.status !== "saved") { setError(result.message); return; }
            draft.saved();
            setOpened(false);
            router.refresh();
            notifications.show({ id: "skill-organization-notice", message: result.message, className: "learnrecurNotification", autoClose: 3500 });
          } catch { setError("Could not save your change. Check your connection and try again."); }
        });
      }}>
        <input type="hidden" name="skillId" value={skillId} />
        <input type="hidden" name="mode" value={mode} />
        {mode === "rename" ? <TextInput label="Skill name" name="title" size="md" maxLength={120} required
          value={draft.value.title} onChange={(event) => draft.update({ title: event.currentTarget.value })} disabled={pending || !draft.ready} /> : <>
          <p>Choose where to organize this skill. Its review history and schedule stay intact.</p>
          <Select label="Collection" name="collectionId" searchable value={draft.value.collectionId}
            onChange={(value) => draft.update({ collectionId: value ?? "" })} disabled={pending || !draft.ready}
            data={[{ value: "", label: "Uncollected" }, ...collections.map((collection) => ({ value: collection.id, label: collection.name, disabled: collection.disabled }))]} />
        </>}
        {error ? <p className="skillGuidanceFieldError" role="alert">{error}</p> : null}
        <FormDraftNotice {...draft} disabled={pending || !draft.ready} onDiscard={() => draft.discard()} />
        <div className="skillGuidanceDialogActions">
          <button className="secondaryButton" type="button" disabled={pending} onClick={() => setOpened(false)}>Cancel</button>
          <button className="primaryButton" type="submit" disabled={pending || !draft.ready}>{pending ? "Saving" : mode === "rename" ? "Save name" : "Move skill"}</button>
        </div>
      </form>
    </Modal>
  </>;
}
