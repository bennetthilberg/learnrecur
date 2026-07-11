"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";
import { useEffect } from "react";

type ActionNotificationProps = {
  id: string;
  message?: string | null;
  title: string;
  tone?: "error" | "success";
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

    const isError = tone === "error";
    notifications.show({
      id,
      autoClose: isError ? 8000 : 5000,
      className: "learnrecurNotification",
      color: isError ? "red" : "leaf",
      icon: isError ? (
        <WarningCircle size={18} weight="bold" />
      ) : (
        <CheckCircle size={18} weight="bold" />
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
