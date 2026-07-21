"use client";

import { Modal } from "@mantine/core";
import { Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const CREATE_SKILL_START_PATH = "/skills/new";

export function BatchCreateMoreControl({
  readyCount,
  unfinishedCount,
}: {
  readyCount: number;
  unfinishedCount: number;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);

  if (unfinishedCount === 0) {
    return (
      <Link className="primaryButton batchCreateMoreAction" href={CREATE_SKILL_START_PATH}>
        <Plus size={17} weight="bold" aria-hidden="true" />
        Create more skills
      </Link>
    );
  }

  const otherUnfinishedCount = Math.max(0, unfinishedCount - readyCount);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="secondaryButton batchCreateMoreAction"
        onClick={() => setOpened(true)}
        type="button"
      >
        <Plus size={17} weight="bold" aria-hidden="true" />
        Create more skills
      </button>
      <Modal
        centered
        classNames={{
          body: "batchLeaveModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
        closeButtonProps={{ "aria-label": "Close leave batch confirmation" }}
        lockScroll={false}
        onClose={() => setOpened(false)}
        opened={opened}
        radius="md"
        size="sm"
        title="Leave this batch?"
        transitionProps={{ duration: 0 }}
        withinPortal
        zIndex={2200}
      >
        <div className="batchLeaveModalCopy">
          {readyCount > 0 ? (
            <p>
              <strong>
                {readyCount} draft{readyCount === 1 ? " is" : "s are"} ready to add.
              </strong>
            </p>
          ) : null}
          {otherUnfinishedCount > 0 ? (
            <p>
              {otherUnfinishedCount} other skill{otherUnfinishedCount === 1 ? " is" : "s are"} still
              being prepared or {otherUnfinishedCount === 1 ? "needs" : "need"} attention.
            </p>
          ) : null}
          <p>
            This work stays saved in this batch, but skills that have not been added will not
            appear in your Skills library yet.
          </p>
        </div>
        <div className="batchLeaveModalActions">
          <button className="secondaryButton" onClick={() => setOpened(false)} type="button">
            Stay here
          </button>
          <button
            className="primaryButton"
            onClick={() => router.push(CREATE_SKILL_START_PATH)}
            type="button"
          >
            Create more anyway
          </button>
        </div>
      </Modal>
    </>
  );
}
