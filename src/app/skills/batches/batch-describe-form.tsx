"use client";

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type SubmitEvent,
} from "react";

import {
  detectMaterialReviewShortcut,
  isMaterialReviewShortcutEvent,
  type MaterialReviewShortcut,
} from "@/lib/material-review-shortcut";

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
};

type BatchDescribeFormProps = ComponentPropsWithoutRef<"form">;

const BatchDescribeShortcutContext = createContext<MaterialReviewShortcut | null>(null);

function subscribeToPlatformSignals() {
  return () => undefined;
}

function getServerShortcutSnapshot() {
  return null;
}

function getClientShortcutSnapshot() {
  const browserNavigator = navigator as NavigatorWithUserAgentData;

  return detectMaterialReviewShortcut({
    maxTouchPoints: browserNavigator.maxTouchPoints,
    mobile: browserNavigator.userAgentData?.mobile,
    platform: browserNavigator.userAgentData?.platform || browserNavigator.platform,
    userAgent: browserNavigator.userAgent,
  });
}

export function useBatchDescribeShortcut() {
  return useContext(BatchDescribeShortcutContext);
}

export function BatchDescribeForm({
  children,
  onKeyDown,
  onSubmit,
  ...props
}: BatchDescribeFormProps) {
  const shortcut = useSyncExternalStore(
    subscribeToPlatformSignals,
    getClientShortcutSnapshot,
    getServerShortcutSnapshot,
  );
  const submissionStarted = useRef(false);

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      shortcut === null ||
      submissionStarted.current ||
      !isMaterialReviewShortcutEvent(
        {
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          isComposing: event.nativeEvent.isComposing,
          key: event.key,
          metaKey: event.metaKey,
          repeat: event.repeat,
          shiftKey: event.shiftKey,
        },
        shortcut,
      )
    ) {
      return;
    }

    const submitter = event.currentTarget.querySelector<HTMLButtonElement>(
      'button[data-material-review-submit="true"]',
    );
    if (!submitter || submitter.disabled) {
      return;
    }

    event.preventDefault();
    event.currentTarget.requestSubmit(submitter);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    onSubmit?.(event);
    if (!event.defaultPrevented) {
      submissionStarted.current = true;
      window.setTimeout(() => {
        submissionStarted.current = false;
      }, 1_000);
    }
  }

  return (
    <BatchDescribeShortcutContext.Provider value={shortcut}>
      <form {...props} onKeyDown={handleKeyDown} onSubmit={handleSubmit}>
        {children}
      </form>
    </BatchDescribeShortcutContext.Provider>
  );
}
