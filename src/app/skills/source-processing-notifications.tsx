"use client";

import { useEffect } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

export type SourceProcessingFailureNotice = {
  id: string;
  name: string;
  message: string;
  noticeKey: string;
  retryable: boolean;
};

export function SourceProcessingNotifications({
  failures,
}: {
  failures: SourceProcessingFailureNotice[];
}) {
  useEffect(() => {
    for (const failure of failures) {
      const storageKey = `learnrecur:source-prep-failure:${failure.noticeKey}`;

      try {
        if (window.sessionStorage.getItem(storageKey)) {
          continue;
        }

        window.sessionStorage.setItem(storageKey, "1");
      } catch {
        // Some browsers or privacy modes block storage access. In that case,
        // show the notification without session-level dedupe.
      }

      notifications.show({
        id: `source-prep-failure-${failure.id}`,
        autoClose: 9000,
        className: "learnrecurNotification",
        color: "amber",
        icon: <WarningCircle size={18} weight="bold" />,
        message: `${failure.name}: ${failure.message} ${
          failure.retryable
            ? "The material is saved, so you can try preparation again from Create a skill."
            : "The material was saved."
        }`,
        position: "top-right",
        title: "Skill preparation failed",
        withBorder: true,
        withCloseButton: true,
      });
    }
  }, [failures]);

  return null;
}
