"use client";

import { Menu, Modal } from "@mantine/core";
import {
  Archive,
  CheckCircle,
  DotsThreeVertical,
  Pause,
  Play,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { notifications } from "@mantine/notifications";
import {
  updateSkillLifecycleAction,
  type SkillFormActionState,
} from "./actions";
import { SkillDeleteForm } from "./skill-delete-form";

type SkillRowStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
type LifecycleAction = "pause" | "resume" | "archive" | "restore";

export function SkillRowActions({
  skillId,
  skillTitle,
  status,
}: {
  skillId: string;
  skillTitle: string;
  status: SkillRowStatus;
}) {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  const [pending, startTransition] = useTransition();

  function closeDialog() {
    if (pending) return;
    setDialog(null);
    trigger.current?.focus();
  }

  function changeLifecycle(action: LifecycleAction) {
    const data = new FormData();
    data.set("skillId", skillId);
    data.set("lifecycleAction", action);
    if (action === "archive") data.set("confirmLifecycle", "yes");
    notifications.hide(`skill-row-${skillId}`);
    startTransition(async () => {
      const next: SkillFormActionState = await updateSkillLifecycleAction(
        { status: "idle", message: null },
        data,
      ).catch(() => ({
        status: "error" as const,
        message: "Could not update this skill. Try again.",
      }));
      notifications.show({
        id: `skill-row-${skillId}`,
        title:
          next.status === "saved" ? "Skill updated" : "Could not update skill",
        message: next.message,
        color: next.status === "saved" ? "leaf" : "amber",
        icon:
          next.status === "saved" ? (
            <CheckCircle size={18} />
          ) : (
            <WarningCircle size={18} />
          ),
        className: "learnrecurNotification",
        position: "top-right",
        withBorder: true,
        withCloseButton: true,
      });
      if (next.status === "saved") {
        setDialog(null);
        router.refresh();
        trigger.current?.focus();
      }
    });
  }

  return (
    <div className="skillRowActions">
      <Menu
        position="bottom-end"
        withinPortal
        shadow="none"
        width={200}
        returnFocus
      >
        <Menu.Target>
          <button
            ref={trigger}
            aria-label={`Open actions for ${skillTitle}`}
            className="skillRowActionsTrigger"
            disabled={pending}
            type="button"
          >
            {pending ? (
              <span className="buttonSpinner" aria-hidden="true" />
            ) : (
              <DotsThreeVertical aria-hidden="true" size={22} weight="bold" />
            )}
          </button>
        </Menu.Target>
        <Menu.Dropdown className="skillActionsDropdown">
          {status === "ACTIVE" && (
            <Menu.Item
              leftSection={<Pause size={18} />}
              onClick={() => changeLifecycle("pause")}
            >
              Pause
            </Menu.Item>
          )}
          {status === "PAUSED" && (
            <Menu.Item
              leftSection={<Play size={18} />}
              onClick={() => changeLifecycle("resume")}
            >
              Resume
            </Menu.Item>
          )}
          {status === "ARCHIVED" && (
            <Menu.Item
              leftSection={<Archive size={18} />}
              onClick={() => changeLifecycle("restore")}
            >
              Restore
            </Menu.Item>
          )}
          {status !== "ARCHIVED" && (
            <Menu.Item
              leftSection={<Archive size={18} />}
              onClick={() => setDialog("archive")}
            >
              Archive
            </Menu.Item>
          )}
          {(status === "DRAFT" || status === "ARCHIVED") && (
            <Menu.Item
              color="amber"
              leftSection={<Trash size={18} />}
              onClick={() => setDialog("delete")}
            >
              Delete permanently
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      <Modal
        closeButtonProps={{ "aria-label": "Close archive confirmation" }}
        opened={dialog !== null}
        onClose={closeDialog}
        title={
          dialog === "delete" ? "Delete skill permanently?" : "Archive skill?"
        }
        centered
        size="md"
        returnFocus={false}
        closeOnClickOutside={!pending && dialog !== "delete"}
        closeOnEscape={!pending && dialog !== "delete"}
        withCloseButton={!pending && dialog !== "delete"}
        transitionProps={{ duration: 0 }}
        classNames={{
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          title: "skillGuidanceModalTitle",
          body: "skillActionDialogBody",
        }}
      >
        <p className="skillActionSubject">{skillTitle}</p>
        {dialog === "delete" ? (
          <SkillDeleteForm
            skillId={skillId}
            skillTitle={skillTitle}
            inline
            onCancel={closeDialog}
          />
        ) : (
          <>
            <p>
              This skill will leave your practice queue. Its sources, exercises,
              and history stay saved, and you can restore it from archived
              skills.
            </p>
            <div className="skillActionDialogActions">
              <button
                className="secondaryButton"
                data-autofocus
                disabled={pending}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primaryButton"
                disabled={pending}
                onClick={() => changeLifecycle("archive")}
                type="button"
              >
                {pending ? "Archiving" : "Archive skill"}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
