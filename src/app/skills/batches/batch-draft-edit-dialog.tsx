"use client";

import { Modal } from "@mantine/core";
import { PencilSimple } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import {
  SkillDraftForm,
  type SkillDraftFormValues,
} from "../skill-draft-form";

export function BatchDraftEditDialog({
  initialValues,
  skillId,
}: {
  initialValues: SkillDraftFormValues;
  skillId: string;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);
  const handleSaved = useCallback(() => {
    setOpened(false);
    router.refresh();
  }, [router]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="secondaryButton"
        onClick={() => setOpened(true)}
        type="button"
      >
        <PencilSimple size={15} weight="bold" aria-hidden="true" />
        <span>Edit draft</span>
      </button>
      <Modal
        centered
        classNames={{
          body: "batchDraftEditModalBody",
          content: "skillGuidanceModalContent batchDraftEditModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
        closeButtonProps={{ "aria-label": "Close draft editor" }}
        lockScroll={false}
        onClose={() => setOpened(false)}
        opened={opened}
        radius="md"
        size="xl"
        title="Edit draft"
        transitionProps={{ duration: 0 }}
        withinPortal
        zIndex={2200}
      >
        <SkillDraftForm
          cancelLabel="Cancel"
          initialValues={initialValues}
          mode="edit"
          onBack={() => setOpened(false)}
          onSaved={handleSaved}
          skillId={skillId}
          submitIntent="save"
        />
      </Modal>
    </>
  );
}
