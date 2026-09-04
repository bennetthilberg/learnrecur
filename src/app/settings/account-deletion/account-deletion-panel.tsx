"use client";

import { Modal } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  CheckCircleIcon,
  DownloadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useState, useTransition } from "react";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  accountDeletionUiStatusAfterRequest,
  type AccountDeletionUiSnapshot,
  type AccountDeletionUiStatus,
} from "@/lib/account-deletion/contracts";

import { requestAccountDeletionAction } from "../actions";

const accountDeletionNotificationId = "settings-account-deletion-notice";

export function AccountDeletionPanel({ status }: { status: AccountDeletionUiSnapshot }) {
  const [localStatus, setLocalStatus] = useState(status.status);
  const [opened, setOpened] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, startTransition] = useTransition();

  const canStart = localStatus === "none" || localStatus === "FAILED";
  const confirmationMatches = confirmation === ACCOUNT_DELETION_CONFIRMATION;

  function closeModal() {
    if (pending) return;
    setOpened(false);
    setConfirmation("");
  }

  function submitDeletion() {
    if (!confirmationMatches || pending) return;

    startTransition(async () => {
      try {
        const result = await requestAccountDeletionAction(confirmation);
        const saved = result.status === "saved";
        notifications.show({
          id: accountDeletionNotificationId,
          autoClose: saved ? 5_000 : 8_000,
          className: "learnrecurNotification",
          color: saved ? "leaf" : "amber",
          icon: saved ? (
            <CheckCircleIcon size={18} weight="bold" />
          ) : (
            <WarningCircleIcon size={18} weight="bold" />
          ),
          message: result.message,
          position: "top-right",
          title: saved ? "Account deletion queued" : "Could not start deletion",
          withBorder: true,
          withCloseButton: true,
        });

        if (saved) {
          setLocalStatus(accountDeletionUiStatusAfterRequest(result.deletionStatus));
          setOpened(false);
          setConfirmation("");
        }
      } catch {
        notifications.show({
          id: accountDeletionNotificationId,
          autoClose: 8_000,
          className: "learnrecurNotification",
          color: "amber",
          icon: <WarningCircleIcon size={18} weight="bold" />,
          message: "Account deletion could not be started. Try again.",
          position: "top-right",
          title: "Could not start deletion",
          withBorder: true,
          withCloseButton: true,
        });
      }
    });
  }

  return (
    <section
      className="skillPanel settingsPanel"
      aria-labelledby="account-deletion-title"
      id="account-deletion"
    >
      <div className="settingsSectionIntro">
        <h2 id="account-deletion-title">Delete account</h2>
        <p>
          Deletion turns off sign-in and agent access first, removes private uploaded
          objects, then removes the account records.
        </p>
      </div>

      {localStatus === "none" ? (
        <div className="settingsExportBody">
          <p>
            Download your study export before continuing. It includes saved study records,
            but not original uploaded file bytes. Account deletion cannot be undone.
          </p>
          <Link className="secondaryButton" href="/settings/export" prefetch={false}>
            <DownloadSimpleIcon aria-hidden="true" size={16} weight="bold" />
            Download export first
          </Link>
        </div>
      ) : null}

      {renderStatus(localStatus)}

      {canStart ? (
        <div className="skillFormActions">
          <button
            className="secondaryButton"
            data-tone="danger"
            type="button"
            onClick={() => setOpened(true)}
          >
            {localStatus === "FAILED" ? "Try deletion again" : "Delete my account"}
          </button>
        </div>
      ) : null}

      <Modal
        opened={opened}
        onClose={closeModal}
        title="Delete this account?"
        centered
        returnFocus
        classNames={{
          body: "skillGuidanceModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
      >
        <div className="skillGuidanceDialogForm">
          <p className="skillGuidanceDialogIntro">
            This starts a background deletion that first disables access, inventories the
            private objects attached to this account, and keeps a retryable deletion record.
            Download your export before confirming; original uploads are not recoverable from
            the export.
          </p>

          <label className="skillField" htmlFor="account-deletion-confirmation">
            <span>Type {ACCOUNT_DELETION_CONFIRMATION} to confirm</span>
            <input
              id="account-deletion-confirmation"
              autoComplete="off"
              autoFocus
              disabled={pending}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
              value={confirmation}
            />
          </label>

          <div className="skillFormActions">
            <button className="secondaryButton" type="button" onClick={closeModal} disabled={pending}>
              Keep account
            </button>
            <button
              className="secondaryButton"
              data-tone="danger"
              type="button"
              onClick={submitDeletion}
              disabled={!confirmationMatches || pending}
            >
              {pending ? "Starting deletion…" : "Delete account"}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

function renderStatus(status: AccountDeletionUiStatus) {
  if (status === "PENDING") {
    return (
      <p className="skillFormMessage" data-tone="saved" role="status">
        Deletion is queued. Sign-in and agent access will be disabled before private data is removed.
      </p>
    );
  }
  if (status === "RUNNING") {
    return (
      <p className="skillFormMessage" data-tone="saved" role="status">
        Deletion is in progress. Keep this page open only if you want to see the current state.
      </p>
    );
  }
  if (status === "FAILED") {
    return (
      <p className="skillFormMessage" data-tone="error" role="status">
        Deletion needs another attempt. The deletion record and private-object inventory are retained so it can resume safely.
      </p>
    );
  }

  if (status === "DEAD_LETTER") {
    return (
      <p className="skillFormMessage" data-tone="error" role="status">
        Automatic deletion stopped after repeated failures. Contact support so the remaining
        deletion can be completed safely.
      </p>
    );
  }
  if (status === "COMPLETE") {
    return (
      <p className="skillFormMessage" data-tone="saved" role="status">
        Account deletion is complete.
      </p>
    );
  }
  return null;
}
