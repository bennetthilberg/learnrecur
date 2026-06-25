"use client";

import { X } from "@phosphor-icons/react";
import { Callout, IconButton } from "@radix-ui/themes";
import { useEffect, useState, type ReactNode } from "react";

type NotificationColor = "amber" | "blue" | "gray" | "leaf" | "red";

type NotificationOptions = {
  autoClose?: number | false;
  className?: string;
  color?: NotificationColor;
  icon?: ReactNode;
  id?: string;
  message: ReactNode;
  position?: "top-right";
  title?: ReactNode;
  withBorder?: boolean;
  withCloseButton?: boolean;
};

type NotificationTone = "attention" | "danger" | "neutral" | "primary" | "success";

type NotificationRecord = Required<Pick<NotificationOptions, "id">> &
  Omit<NotificationOptions, "id"> & {
    tone: NotificationTone;
  };

type NotificationEvent =
  | { notice: NotificationRecord; type: "show" }
  | { id: string; type: "hide" };

const listeners = new Set<(event: NotificationEvent) => void>();
let notificationSequence = 0;

function emit(event: NotificationEvent) {
  listeners.forEach((listener) => listener(event));
}

function resolveTone(color: NotificationColor | undefined): NotificationTone {
  if (color === "leaf") {
    return "success";
  }

  if (color === "red") {
    return "danger";
  }

  if (color === "blue") {
    return "primary";
  }

  if (color === "amber") {
    return "attention";
  }

  return "neutral";
}

function resolveRadixColor(tone: NotificationTone) {
  if (tone === "success") {
    return "green";
  }

  if (tone === "danger") {
    return "red";
  }

  if (tone === "primary") {
    return "blue";
  }

  if (tone === "attention") {
    return "amber";
  }

  return "gray";
}

export const notifications = {
  hide(id: string) {
    emit({ id, type: "hide" });
  },
  show(options: NotificationOptions) {
    const id = options.id ?? `learnrecur-notification-${notificationSequence++}`;

    emit({
      notice: {
        ...options,
        id,
        tone: resolveTone(options.color),
        withCloseButton: options.withCloseButton ?? true,
      },
      type: "show",
    });

    return id;
  },
};

export function LearnRecurNotifications() {
  const [items, setItems] = useState<NotificationRecord[]>([]);

  useEffect(() => {
    function handleNotification(event: NotificationEvent) {
      setItems((currentItems) => {
        if (event.type === "hide") {
          return currentItems.filter((item) => item.id !== event.id);
        }

        const withoutExisting = currentItems.filter((item) => item.id !== event.notice.id);
        return [event.notice, ...withoutExisting].slice(0, 3);
      });
    }

    listeners.add(handleNotification);
    return () => {
      listeners.delete(handleNotification);
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <aside
      aria-live="polite"
      aria-relevant="additions text"
      className="learnrecurNotificationViewport"
    >
      {items.map((item) => (
        <LearnRecurNotificationItem item={item} key={item.id} />
      ))}
    </aside>
  );
}

function LearnRecurNotificationItem({ item }: { item: NotificationRecord }) {
  useEffect(() => {
    if (item.autoClose === false) {
      return;
    }

    const timeout = window.setTimeout(
      () => notifications.hide(item.id),
      item.autoClose ?? 5000,
    );

    return () => {
      window.clearTimeout(timeout);
    };
  }, [item.autoClose, item.id]);

  return (
    <Callout.Root
      className={`learnrecurNotification ${item.className ?? ""}`.trim()}
      color={resolveRadixColor(item.tone)}
      data-tone={item.tone}
      highContrast
      role="status"
      size="2"
      variant="surface"
    >
      {item.icon ? <Callout.Icon>{item.icon}</Callout.Icon> : null}
      <div className="learnrecurNotificationBody">
        {item.title ? <strong>{item.title}</strong> : null}
        <Callout.Text>{item.message}</Callout.Text>
      </div>
      {item.withCloseButton ? (
        <IconButton
          aria-label="Dismiss notification"
          className="learnrecurNotificationClose"
          color="gray"
          onClick={() => notifications.hide(item.id)}
          size="1"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={14} weight="bold" />
        </IconButton>
      ) : null}
    </Callout.Root>
  );
}
