"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@mantine/core";
import { CheckCircle, FloppyDisk, PencilSimple, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

import {
  updateSkillPracticeGuidanceAction,
  type SkillFormActionState,
} from "./actions";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

const guidanceNotificationId = "skill-practice-guidance-notice";

export function SkillPracticeGuidanceDialog({
  constraints,
  examples,
  rules,
  skillId,
}: {
  constraints: string;
  examples: string;
  rules: string;
  skillId: string;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);
  const [state, action, isPending] = useActionState(
    updateSkillPracticeGuidanceAction,
    idleState,
  );
  const rulesId = useId();
  const examplesId = useId();
  const constraintsId = useId();
  const rulesHelpId = useId();
  const examplesHelpId = useId();
  const constraintsHelpId = useId();
  const rulesError = state.fieldErrors?.rules?.[0];
  const examplesError = state.fieldErrors?.examples?.[0];
  const constraintsError = state.fieldErrors?.exerciseConstraints?.[0];

  useEffect(() => {
    if (!state.message || state.status === "idle") {
      return;
    }

    const isSaved = state.status === "saved";

    notifications.show({
      id: guidanceNotificationId,
      autoClose: isSaved ? 3500 : 8000,
      className: "learnrecurNotification",
      color: isSaved ? "leaf" : "amber",
      icon: isSaved ? (
        <CheckCircle size={18} weight="bold" />
      ) : (
        <WarningCircle size={18} weight="bold" />
      ),
      message: state.message,
      position: "top-right",
      title: isSaved ? "Practice guidance saved" : "Could not save guidance",
      withBorder: true,
      withCloseButton: true,
    });

    if (isSaved) {
      router.refresh();
      const closeTimeout = window.setTimeout(() => setOpened(false), 0);

      return () => window.clearTimeout(closeTimeout);
    }
  }, [router, state]);

  return (
    <>
      <button
        className="secondaryButton skillGuidanceEditButton"
        onClick={() => setOpened(true)}
        type="button"
      >
        <PencilSimple size={15} weight="bold" aria-hidden="true" />
        <span>Edit</span>
      </button>
      <Modal
        centered
        classNames={{
          body: "skillGuidanceModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
        lockScroll={false}
        onClose={() => setOpened(false)}
        opened={opened}
        radius="md"
        size="lg"
        title="Edit practice guidance"
        transitionProps={{ duration: 0 }}
        withinPortal
        zIndex={2200}
      >
        <form action={action} className="skillGuidanceDialogForm">
          <input name="skillId" type="hidden" value={skillId} />
          <p className="skillGuidanceDialogIntro">
            Future exercise preparation uses this guidance. Existing review history stays unchanged.
          </p>
          <label className="skillGuidanceDialogField" htmlFor={rulesId}>
            <span>Rules</span>
            <small id={rulesHelpId}>One rule per line works best.</small>
            <textarea
              aria-describedby={
                rulesError ? `${rulesHelpId} ${rulesId}-error` : rulesHelpId
              }
              aria-invalid={rulesError ? "true" : undefined}
              defaultValue={rules}
              disabled={isPending}
              id={rulesId}
              name="rules"
              rows={5}
            />
            {rulesError ? (
              <span className="skillGuidanceFieldError" id={`${rulesId}-error`}>
                {rulesError}
              </span>
            ) : null}
          </label>
          <label className="skillGuidanceDialogField" htmlFor={examplesId}>
            <span>Examples</span>
            <small id={examplesHelpId}>Use examples that match the class or source style.</small>
            <textarea
              aria-describedby={
                examplesError ? `${examplesHelpId} ${examplesId}-error` : examplesHelpId
              }
              aria-invalid={examplesError ? "true" : undefined}
              defaultValue={examples}
              disabled={isPending}
              id={examplesId}
              name="examples"
              rows={5}
            />
            {examplesError ? (
              <span className="skillGuidanceFieldError" id={`${examplesId}-error`}>
                {examplesError}
              </span>
            ) : null}
          </label>
          <label className="skillGuidanceDialogField" htmlFor={constraintsId}>
            <span>Exercise focus</span>
            <small id={constraintsHelpId}>
              Add constraints for future prompts, answer style, or what to avoid.
            </small>
            <textarea
              aria-describedby={
                constraintsError
                  ? `${constraintsHelpId} ${constraintsId}-error`
                  : constraintsHelpId
              }
              aria-invalid={constraintsError ? "true" : undefined}
              defaultValue={constraints}
              disabled={isPending}
              id={constraintsId}
              name="exerciseConstraints"
              rows={4}
            />
            {constraintsError ? (
              <span className="skillGuidanceFieldError" id={`${constraintsId}-error`}>
                {constraintsError}
              </span>
            ) : null}
          </label>
          <div className="skillGuidanceDialogActions">
            <button
              className="secondaryButton"
              disabled={isPending}
              onClick={() => setOpened(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="primaryButton" disabled={isPending} type="submit">
              <FloppyDisk size={17} weight="bold" aria-hidden="true" />
              <span>{isPending ? "Saving" : "Save guidance"}</span>
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
