"use client";

import { DotsThreeVertical } from "@phosphor-icons/react";
import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";

import { updateSkillLifecycleAction, type SkillFormActionState } from "./actions";

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
  const [open, setOpen] = useState(false);
  const [pendingLifecycleAction, setPendingLifecycleAction] =
    useState<LifecycleActionType | null>(null);
  const [, lifecycleFormAction, lifecyclePending] = useActionState(
    updateSkillLifecycleAction,
    initialState,
  );
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lifecycleItems = getLifecycleItems(status);
  const canDelete = status === "DRAFT" || status === "ARCHIVED";
  const skillHref = `/skills/${skillId}`;

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="skillRowActions" ref={rootRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-label={`Open actions for ${skillTitle}`}
        className="skillRowActionsTrigger"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        type="button"
      >
        <DotsThreeVertical aria-hidden="true" size={22} weight="bold" />
      </button>

      {open ? (
        <div className="skillRowActionsMenu" id={menuId}>
          {lifecycleItems.map((item) =>
            item.actionType === "archive" ? (
              <Link
                className="skillRowActionItem"
                data-tone={item.tone}
                href={skillHref}
                key={item.actionType}
              >
                {item.label}
              </Link>
            ) : (
              <form action={lifecycleFormAction} key={item.actionType}>
                <input name="skillId" type="hidden" value={skillId} />
                <input name="lifecycleAction" type="hidden" value={item.actionType} />
                <button
                  className="skillRowActionItem"
                  data-tone={item.tone}
                  disabled={lifecyclePending}
                  onClick={() => setPendingLifecycleAction(item.actionType)}
                  type="submit"
                >
                  {lifecyclePending && pendingLifecycleAction === item.actionType
                    ? item.pendingLabel
                    : item.label}
                </button>
              </form>
            ),
          )}

          {canDelete ? (
            <Link className="skillRowActionItem" data-tone="danger" href={skillHref}>
              Delete
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
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
