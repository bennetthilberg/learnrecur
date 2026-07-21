"use client";

import { Modal } from "@mantine/core";
import { Trash, WarningCircle } from "@phosphor-icons/react";
import { useState, useTransition } from "react";

import type { MaterialDeletionReturnPath } from "@/lib/materials/material-delete";

import { deleteMaterialAction } from "./actions";

export function MaterialDeleteControl({
  materialId,
  returnTo,
  title,
  compact = false,
}: {
  materialId: string;
  returnTo: MaterialDeletionReturnPath;
  title: string;
  compact?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={`secondaryButton materialDeleteTrigger${compact ? " materialDeleteTriggerCompact" : ""}`}
        data-tone="danger"
        onClick={() => {
          setError(null);
          setOpened(true);
        }}
        type="button"
      >
        <Trash size={14} weight="bold" aria-hidden="true" />
        Delete
      </button>
      <Modal
        centered
        classNames={{
          body: "materialDeleteModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
        closeOnClickOutside={!pending}
        closeOnEscape={!pending}
        lockScroll={false}
        onClose={() => {
          if (!pending) {
            setOpened(false);
          }
        }}
        opened={opened}
        radius="md"
        size="sm"
        title="Delete this material?"
        transitionProps={{ duration: 0 }}
        withCloseButton={!pending}
        withinPortal
        zIndex={2200}
      >
        <p className="materialDeleteModalIntro">
          Remove <strong>“{title}”</strong> and every saved revision? Existing skills stay, but
          source-backed regeneration stops. This cannot be undone.
        </p>
        {error ? (
          <p className="skillFormMessage materialDeleteModalError" data-tone="error" role="alert">
            <WarningCircle size={17} weight="bold" aria-hidden="true" />
            {error}
          </p>
        ) : null}
        <div className="materialDeleteModalActions">
          <button
            className="secondaryButton"
            disabled={pending}
            onClick={() => setOpened(false)}
            type="button"
          >
            Cancel
          </button>
          <button
            aria-busy={pending}
            className="secondaryButton materialDeleteConfirm"
            data-tone="danger"
            disabled={pending}
            onClick={() => {
              const formData = new FormData();
              formData.set("materialId", materialId);
              formData.set("confirmationTitle", title);
              formData.set("returnTo", returnTo);
              setError(null);
              startTransition(async () => {
                const result = await deleteMaterialAction(formData);
                setError(result.message);
              });
            }}
            type="button"
          >
            <span className="buttonPendingContent">
              {pending ? <span className="buttonSpinner" aria-hidden="true" /> : null}
              <span aria-live="polite">{pending ? "Deleting material" : "Delete material"}</span>
            </span>
          </button>
        </div>
      </Modal>
    </>
  );
}
