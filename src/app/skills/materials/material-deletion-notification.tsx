"use client";

import { useEffect } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

const materialDeletionNotificationId = "material-deletion-queued";

export function MaterialDeletionNotification({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) {
      return;
    }

    notifications.show({
      id: materialDeletionNotificationId,
      autoClose: 5000,
      className: "learnrecurNotification",
      color: "leaf",
      icon: <CheckCircle size={18} weight="bold" />,
      message: "Linked skills will remain available.",
      position: "top-right",
      title: "Material deletion queued",
      withBorder: true,
      withCloseButton: true,
    });
  }, [active]);

  return null;
}
