"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";
import { useEffect } from "react";

type ActionNotificationProps = {
  id: string;
  message?: string | null;
  title: string;
  tone?: "error" | "success" | "warning";
};

export function ActionNotification({
  id,
  message,
  title,
  tone = "error",
}: ActionNotificationProps) {
  useEffect(() => {
    if (!message) {
      return;
    }

    const isSuccess = tone === "success";
    notifications.show({
      id,
      autoClose: isSuccess ? 5000 : 8000,
      className: "learnrecurNotification",
      color: isSuccess ? "leaf" : tone === "warning" ? "orange" : "red",
      icon: isSuccess ? (
        <CheckCircle size={18} weight="bold" />
      ) : (
        <WarningCircle size={18} weight="bold" />
      ),
      message,
      position: "top-right",
      title,
      withBorder: true,
      withCloseButton: true,
    });
  }, [id, message, title, tone]);

  return null;
}
