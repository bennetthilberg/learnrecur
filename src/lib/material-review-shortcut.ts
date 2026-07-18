export type MaterialReviewShortcut = {
  ariaKeyShortcuts: "Meta+Enter" | "Control+Enter";
  keyLabel: string;
  platform: "mac" | "windows";
};

export type MaterialReviewPlatformSignals = {
  maxTouchPoints?: number;
  mobile?: boolean;
  platform?: string;
  userAgent?: string;
};

export type MaterialReviewShortcutEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
};

const MAC_SHORTCUT: MaterialReviewShortcut = {
  ariaKeyShortcuts: "Meta+Enter",
  keyLabel: "⌘ Enter",
  platform: "mac",
};

const WINDOWS_SHORTCUT: MaterialReviewShortcut = {
  ariaKeyShortcuts: "Control+Enter",
  keyLabel: "Ctrl Enter",
  platform: "windows",
};

const MOBILE_USER_AGENT = /Android|iPad|iPhone|iPod|Mobile|Tablet/i;
const CHROME_OS_USER_AGENT = /CrOS/i;

export function detectMaterialReviewShortcut(
  signals: MaterialReviewPlatformSignals,
): MaterialReviewShortcut | null {
  const userAgent = signals.userAgent ?? "";
  const reportedPlatform = signals.platform?.trim() ?? "";
  const platform = reportedPlatform || inferDesktopPlatform(userAgent);
  const isIPadOsDesktopMode =
    /Mac/i.test(platform) && (signals.maxTouchPoints ?? 0) > 1;

  if (
    signals.mobile === true ||
    isIPadOsDesktopMode ||
    MOBILE_USER_AGENT.test(userAgent) ||
    CHROME_OS_USER_AGENT.test(userAgent)
  ) {
    return null;
  }

  if (/^(Mac|macOS)/i.test(platform)) {
    return MAC_SHORTCUT;
  }

  if (/^(Win|Windows)/i.test(platform)) {
    return WINDOWS_SHORTCUT;
  }

  return null;
}

function inferDesktopPlatform(userAgent: string) {
  if (/Windows NT/i.test(userAgent)) {
    return "Windows";
  }

  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return "macOS";
  }

  return "";
}

export function isMaterialReviewShortcutEvent(
  event: MaterialReviewShortcutEvent,
  shortcut: MaterialReviewShortcut,
): boolean {
  if (
    event.key !== "Enter" ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey
  ) {
    return false;
  }

  if (shortcut.platform === "mac") {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
}
