"use client";

import { Modal } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Minus, WarningCircle } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { excludeMaterialDraftItemAction } from "./actions";

export function BatchExcludeControl({
  batchId,
  itemId,
  title,
}: {
  batchId: string;
  itemId: string;
  title: string;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="batchTextButton batchExcludeTrigger"
        onClick={() => setOpened(true)}
        type="button"
      >
        <Minus size={14} weight="bold" aria-hidden="true" />
        <span>Exclude</span>
      </button>
      <Modal
        centered
        classNames={{
          body: "batchExcludeModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
        closeButtonProps={{ "aria-label": "Close exclusion confirmation" }}
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
        title="Exclude this draft?"
        transitionProps={{ duration: 0 }}
        withCloseButton={!pending}
        withinPortal
        zIndex={2200}
      >
        <p className="batchExcludeModalCopy">
          This removes the draft from this batch and deletes the generated draft for
          <strong> “{title}”</strong>. The material and your other drafts stay unchanged.
        </p>
        <div className="batchExcludeModalActions">
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
            className="secondaryButton batchExcludeConfirm"
            data-tone="danger"
            disabled={pending}
            onClick={() => {
              const formData = new FormData();
              formData.set("batchId", batchId);
              formData.set("itemId", itemId);
              startTransition(async () => {
                try {
                  const result = await excludeMaterialDraftItemAction(formData);
                  if (result.status === "excluded") {
                    setOpened(false);
                    router.refresh();
                    return;
                  }
                  notifications.show({
                    id: `batch-exclude-${itemId}`,
                    autoClose: 8000,
                    className: "learnrecurNotification",
                    color: "amber",
                    icon: <WarningCircle size={18} weight="bold" />,
                    message: result.message,
                    position: "top-right",
                    title: "Could not exclude draft",
                    withBorder: true,
                    withCloseButton: true,
                  });
                } catch {
                  notifications.show({
                    id: `batch-exclude-${itemId}`,
                    autoClose: 8000,
                    className: "learnrecurNotification",
                    color: "amber",
                    icon: <WarningCircle size={18} weight="bold" />,
                    message: "The draft was not excluded. Try again.",
                    position: "top-right",
                    title: "Could not exclude draft",
                    withBorder: true,
                    withCloseButton: true,
                  });
                }
              });
            }}
            type="button"
          >
            <span className="buttonPendingContent">
              {pending ? <span className="buttonSpinner" aria-hidden="true" /> : null}
              <span>{pending ? "Excluding" : "Confirm exclusion"}</span>
            </span>
          </button>
        </div>
      </Modal>
    </>
  );
}
