"use client";

import { Theme } from "@radix-ui/themes";

import { LearnRecurNotifications } from "@/components/app/notifications";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Theme
      accentColor="blue"
      appearance="light"
      className="learnrecurRadixTheme"
      grayColor="slate"
      hasBackground={false}
      panelBackground="solid"
      radius="medium"
      scaling="100%"
    >
      <LearnRecurNotifications />
      {children}
    </Theme>
  );
}
