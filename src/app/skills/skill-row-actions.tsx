"use client";

import { DropdownMenu, IconButton } from "@radix-ui/themes";
import { DotsThreeVertical } from "@phosphor-icons/react";
import { useActionState, useState, type FormEvent } from "react";

import {
  deleteSkillPermanentlyAction,
  updateSkillLifecycleAction,
  type SkillFormActionState,
} from "./actions";

type SkillRowStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";

type LifecycleActionType = "pause" | "resume" | "archive" | "restore";

type SkillRowActionsProps = {
  skillId: string;
  skillTitle: string;
  status: SkillRowStatus;
};

type LifecycleMenuItem = {
  actionType: LifecycleActionType;
  label: string;
  pendingLabel: string;
  tone?: "danger";
};

const initialState: SkillFormActionState = {
  status: "idle",
  message: null,
};

export function SkillRowActions({ skillId, skillTitle, status }: SkillRowActionsProps) {
  const [pendingLifecycleAction, setPendingLifecycleAction] =
    useState<LifecycleActionType | null>(null);
  const [, lifecycleFormAction, lifecyclePending] = useActionState(
    updateSkillLifecycleAction,
    initialState,
  );
  const [, deleteFormAction, deletePending] = useActionState(
    deleteSkillPermanentlyAction,
    initialState,
  );
  const lifecycleItems = getLifecycleItems(status);
  const canDelete = status === "DRAFT" || status === "ARCHIVED";
  const busy = lifecyclePending || deletePending;

  function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
    const confirmed = window.confirm(
      `Delete "${skillTitle}" permanently? This removes its exercises and practice history.`,
    );

    if (!confirmed) {
      event.preventDefault();
    }
  }

  return (
    <DropdownMenu.Root>
      <IconButton asChild color="gray" radius="medium" size="1" variant="ghost">
        <DropdownMenu.Trigger
          aria-label={`Open actions for ${skillTitle}`}
          className="skillRowActionsTrigger"
        >
          <DotsThreeVertical aria-hidden="true" size={22} weight="bold" />
        </DropdownMenu.Trigger>
      </IconButton>

      <DropdownMenu.Content
        align="end"
        className="skillRowActionsMenu"
        color="blue"
        highContrast
        size="2"
        variant="solid"
      >
          {lifecycleItems.map((item) => (
            <form action={lifecycleFormAction} key={item.actionType}>
              <input name="skillId" type="hidden" value={skillId} />
              <input name="lifecycleAction" type="hidden" value={item.actionType} />
              {item.actionType === "archive" ? (
                <input name="confirmLifecycle" type="hidden" value="yes" />
              ) : null}
              <DropdownMenu.Item
                asChild
                color={item.tone === "danger" ? "red" : "blue"}
              >
                <button
                  className="skillRowActionItem"
                  data-tone={item.tone}
                  disabled={busy}
                  onClick={() => setPendingLifecycleAction(item.actionType)}
                  type="submit"
                >
                  {lifecyclePending && pendingLifecycleAction === item.actionType
                    ? item.pendingLabel
                    : item.label}
                </button>
              </DropdownMenu.Item>
            </form>
          ))}

          {canDelete ? (
            <form action={deleteFormAction} onSubmit={handleDeleteSubmit}>
              <input name="skillId" type="hidden" value={skillId} />
              <input name="confirmationTitle" type="hidden" value={skillTitle} />
              <DropdownMenu.Item asChild color="red">
                <button
                  className="skillRowActionItem"
                  data-tone="danger"
                  disabled={busy}
                  type="submit"
                >
                  {deletePending ? "Deleting" : "Delete"}
                </button>
              </DropdownMenu.Item>
            </form>
          ) : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function getLifecycleItems(status: SkillRowStatus): LifecycleMenuItem[] {
  switch (status) {
    case "DRAFT":
      return [
        {
          actionType: "archive",
          label: "Archive",
          pendingLabel: "Archiving",
          tone: "danger",
        },
      ];
    case "ACTIVE":
      return [
        {
          actionType: "pause",
          label: "Pause",
          pendingLabel: "Pausing",
        },
        {
          actionType: "archive",
          label: "Archive",
          pendingLabel: "Archiving",
          tone: "danger",
        },
      ];
    case "PAUSED":
      return [
        {
          actionType: "resume",
          label: "Resume",
          pendingLabel: "Resuming",
        },
        {
          actionType: "archive",
          label: "Archive",
          pendingLabel: "Archiving",
          tone: "danger",
        },
      ];
    case "ARCHIVED":
      return [
        {
          actionType: "restore",
          label: "Restore",
          pendingLabel: "Restoring",
        },
      ];
  }
}
