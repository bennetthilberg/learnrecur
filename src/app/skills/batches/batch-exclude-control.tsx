"use client";

import { Modal } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CheckCircle, Minus, WarningCircle } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { excludeMaterialDraftItemAction } from "./actions";

type BatchExcludeControlProps = {
  batchId: string;
  className?: string;
  itemId: string;
  label?: string;
  title: string;
} & (
  | {
      intent?: "exclude";
      existingSkillStatus?: never;
      existingSkillTitle?: never;
      expectedCandidateFingerprint?: never;
      expectedCandidateId?: never;
      expectedMatchFingerprint?: never;
      expectedMatchId?: never;
    }
  | {
      intent: "use-existing";
      existingSkillStatus: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
      existingSkillTitle: string;
      expectedCandidateFingerprint: string;
      expectedCandidateId: string;
      expectedMatchFingerprint: string;
      expectedMatchId: string;
    }
);

export function BatchExcludeControl(props: BatchExcludeControlProps) {
  const {
    batchId,
    className = "batchTextButton batchExcludeTrigger",
    itemId,
    label,
    title,
  } = props;
  const intent = props.intent ?? "exclude";
  const existingSkillStatus =
    props.intent === "use-existing" ? props.existingSkillStatus : undefined;
  const existingSkillTitle =
    props.intent === "use-existing" ? props.existingSkillTitle : undefined;
  const expectedMatchFingerprint =
    props.intent === "use-existing"
      ? props.expectedMatchFingerprint
      : undefined;
  const expectedMatchId =
    props.intent === "use-existing" ? props.expectedMatchId : undefined;
  const expectedCandidateFingerprint =
    props.intent === "use-existing"
      ? props.expectedCandidateFingerprint
      : undefined;
  const expectedCandidateId =
    props.intent === "use-existing" ? props.expectedCandidateId : undefined;
  const router = useRouter();
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();
  const useExisting = intent === "use-existing";
  const triggerLabel = label ?? (useExisting ? "Use existing skill" : "Exclude");
  const existingChoice = useExisting
    ? getExistingChoiceCopy(existingSkillStatus, existingSkillTitle)
    : null;

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={className}
        data-intent={intent}
        onClick={() => setOpened(true)}
        type="button"
      >
        {useExisting ? (
          <CheckCircle size={16} weight="bold" aria-hidden="true" />
        ) : (
          <Minus size={14} weight="bold" aria-hidden="true" />
        )}
        <span>{triggerLabel}</span>
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
        closeButtonProps={{
          "aria-label": useExisting
            ? "Close use existing skill confirmation"
            : "Close exclusion confirmation",
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
        title={useExisting ? existingChoice?.title : "Exclude this draft?"}
        transitionProps={{ duration: 0 }}
        withCloseButton={!pending}
        withinPortal
        zIndex={2200}
      >
        <p className="batchExcludeModalCopy">
          {useExisting ? (
            <>
              This deletes the duplicate draft for
              <strong> “{title}”</strong> and {existingChoice?.consequence}
            </>
          ) : (
            <>
              This removes the draft from this batch and deletes the generated draft for
              <strong> “{title}”</strong>. The material and your other drafts stay unchanged.
            </>
          )}
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
            className={
              useExisting
                ? "primaryButton"
                : "secondaryButton batchExcludeConfirm"
            }
            data-tone={useExisting ? undefined : "danger"}
            disabled={pending}
            onClick={() => {
              const formData = new FormData();
              formData.set("batchId", batchId);
              formData.set("itemId", itemId);
              formData.set("intent", intent);
              if (
                useExisting &&
                expectedCandidateId &&
                expectedCandidateFingerprint &&
                expectedMatchId &&
                expectedMatchFingerprint
              ) {
                formData.set("expectedMatchId", expectedMatchId);
                formData.set("expectedCandidateId", expectedCandidateId);
                formData.set(
                  "expectedCandidateFingerprint",
                  expectedCandidateFingerprint,
                );
                formData.set(
                  "expectedMatchFingerprint",
                  expectedMatchFingerprint,
                );
              }
              startTransition(async () => {
                try {
                  const result = await excludeMaterialDraftItemAction(formData);
                  if (result.status === "excluded") {
                    setOpened(false);
                    router.refresh();
                    return;
                  }
                  if (
                    "refreshRequired" in result &&
                    result.refreshRequired
                  ) {
                    notifications.show({
                      id: `batch-exclude-${itemId}`,
                      autoClose: 8000,
                      className: "learnrecurNotification",
                      color: "amber",
                      icon: <WarningCircle size={18} weight="bold" />,
                      message: result.message,
                      position: "top-right",
                      title: "Review the updated comparison",
                      withBorder: true,
                      withCloseButton: true,
                    });
                    setOpened(false);
                    router.refresh();
                    window.requestAnimationFrame(() => {
                      document
                        .getElementById(`batch-draft-review-${itemId}`)
                        ?.focus();
                    });
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
                    title: useExisting
                      ? "Could not use existing skill"
                      : "Could not exclude draft",
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
                    message: useExisting
                      ? "The duplicate draft was not removed. Your existing skill is unchanged; try again."
                      : "The draft was not excluded. Try again.",
                    position: "top-right",
                    title: useExisting
                      ? "Could not use existing skill"
                      : "Could not exclude draft",
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
              <span>
                {pending
                  ? useExisting
                    ? existingChoice?.pendingLabel
                    : "Excluding"
                  : useExisting
                    ? triggerLabel
                    : "Confirm exclusion"}
              </span>
            </span>
          </button>
        </div>
      </Modal>
    </>
  );
}

function getExistingChoiceCopy(
  status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED",
  title?: string,
) {
  const namedSkill = title ? <>“{title}”</> : <>the existing saved skill</>;
  switch (status) {
    case "ACTIVE":
      return {
        title: "Use the existing skill?",
        consequence: (
          <>
            keeps {namedSkill} active with its current review schedule
            unchanged.
          </>
        ),
        pendingLabel: "Keeping active skill",
      };
    case "DRAFT":
      return {
        title: "Keep the existing draft?",
        consequence: (
          <>
            keeps {namedSkill} as a draft. It will not be added to practice
            automatically.
          </>
        ),
        pendingLabel: "Keeping existing draft",
      };
    case "PAUSED":
      return {
        title: "Keep the paused skill?",
        consequence: (
          <>
            keeps {namedSkill} paused. Open it later when you want to resume
            practice.
          </>
        ),
        pendingLabel: "Keeping paused skill",
      };
    case "ARCHIVED":
      return {
        title: "Keep the archived skill?",
        consequence: (
          <>
            keeps {namedSkill} archived. Open it later if you want to restore
            it.
          </>
        ),
        pendingLabel: "Keeping archived skill",
      };
    default:
      return {
        title: "Use the existing skill?",
        consequence: (
          <>
            keeps the existing saved skill and its review schedule unchanged.
          </>
        ),
        pendingLabel: "Keeping existing skill",
      };
  }
}
