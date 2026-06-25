import { Card } from "@radix-ui/themes";

import type { DatabaseUserStatus } from "@/lib/users";

type UserStatusPanelProps = {
  id: string;
  status: Exclude<DatabaseUserStatus, { status: "ready" }>;
};

export function UserStatusPanel({ id, status }: UserStatusPanelProps) {
  return (
    <Card asChild className="dashboardSetupPanel" size="3" variant="surface">
      <section aria-labelledby={id}>
        <h1 id={id}>{getUserStatusTitle(status)}</h1>
        <p>{status.message}</p>
      </section>
    </Card>
  );
}

export function getUserStatusTitle(status: Exclude<DatabaseUserStatus, { status: "ready" }>) {
  switch (status.status) {
    case "missing-env":
      return "Database setup needs attention.";
    case "error":
      return "Account setup needs attention.";
  }
}
