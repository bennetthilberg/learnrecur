import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/ssr";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getAccountDeletionStatus } from "@/lib/account-deletion";
import { hasDatabaseEnv } from "@/lib/env";
import { getReminderSettings } from "@/lib/reminders";
import { ensureDatabaseUser } from "@/lib/users";
import { getAgentAccessOverview } from "@/lib/agent-access/settings";
import { getSupportEmail } from "@/lib/support";

import { ReminderSettingsForm } from "./reminder-settings-form";
import { SkillsTopbar } from "../skills/skills-topbar";
import { AgentAccessPanel } from "./agent-access-panel";
import { AccountDeletionPanel } from "./account-deletion/account-deletion-panel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { userId } = await auth.protect();
  const supportEmail = getSupportEmail();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk returned no authenticated user.");
  }

  const accountDeletion = hasDatabaseEnv()
    ? await getAccountDeletionStatus(userId)
    : { status: "none" as const, phase: null, lastErrorCode: null };
  if (accountDeletion.status !== "none") {
    return (
      <main className="skillShell settingsShell">
        <SkillsTopbar current="settings" />
        <header className="skillHeader settingsHeader">
          <h1>Settings</h1>
        </header>
        <AccountDeletionPanel status={accountDeletion} />
      </main>
    );
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <UserStatusPanel id="settings-setup-title" status={databaseUser} />
      </main>
    );
  }

  const [settings, agentAccess] = await Promise.all([
    getReminderSettings({ userId }),
    getAgentAccessOverview(userId),
  ]);

  if (settings.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <section className="dashboardSetupPanel" aria-labelledby="settings-user-title">
          <h1 id="settings-user-title">Reminder settings are unavailable.</h1>
          <p>{settings.message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="skillShell settingsShell">
      <SkillsTopbar current="settings" />

      <header className="skillHeader settingsHeader">
        <h1>Settings</h1>
      </header>

      <section className="skillPanel settingsPanel" aria-labelledby="reminder-settings-title">
        <div className="settingsSectionIntro" id="email-reminders">
          <h2 id="reminder-settings-title">Email reminders</h2>
          <p>
            LearnRecur can send one quiet email when enough skills are ready to practice.
          </p>
        </div>

        <ReminderSettingsForm preference={settings.preference} />
        <div className="settingsPrivacyNote" role="note" aria-label="Reminder privacy">
          <p>
            Reminder emails include the number of due skills and one practice link.
            They do not include skill titles, source text, answers, or exercise content.
          </p>
        </div>
      </section>

      {agentAccess.status === "ready" ? (
        <AgentAccessPanel
          resourceUrl={agentAccess.resourceUrl}
          connections={agentAccess.connections.map((connection) => ({
            id: connection.id,
            clientName: connection.clientName,
            clientDomain: connection.clientDomain,
            scopes: connection.scopes,
            status: connection.status,
            connectedAt: connection.connectedAt.toISOString(),
            lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
            remoteRevocationStatus: connection.remoteRevocationStatus,
            operationCount: connection._count.operations,
          }))}
          activity={agentAccess.operations.map((operation) => ({
            id: operation.id,
            clientName: operation.connection.clientName,
            status: operation.status,
            requestedCount: operation.requestedCount,
            activeCount: operation.activeCount,
            reusedCount: operation.reusedCount,
            failedCount: operation.failedCount,
            updatedAt: operation.updatedAt.toISOString(),
          }))}
        />
      ) : null}

      <section className="skillPanel settingsExportPanel" aria-labelledby="data-export-title" id="study-data">
        <div className="settingsSectionIntro">
          <h2 id="data-export-title">Study data</h2>
          <p>
            Download a JSON copy of the study records saved for your account.
          </p>
        </div>

        <div className="settingsExportBody">
          <p>
            The export includes collections, skills, source text records, exercises,
            attempts, review history, flags, preparation records, agent connection history,
            and reminder settings.
          </p>
          <Link className="secondaryButton" href="/settings/export" prefetch={false}>
            <DownloadSimpleIcon aria-hidden="true" size={16} weight="bold" />
            Download export
          </Link>
        </div>

        <dl className="settingsExportFacts" aria-label="Data export details">
          <div data-priority="primary">
            <dt>Scope</dt>
            <dd>Study records</dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>JSON file</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>Signed-in only</dd>
          </div>
          <div>
            <dt>Originals</dt>
            <dd>Not included</dd>
          </div>
        </dl>

        <p className="settingsFinePrint">
          Original uploaded file bytes, private storage locations, API keys, and private model prompts
          are not included.
        </p>
      </section>

      <AccountDeletionPanel status={{ status: "none", phase: null, lastErrorCode: null }} />

      <p className="settingsFinePrint">
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
        {supportEmail ? <> · <a href={`mailto:${supportEmail}`}>Support</a></> : null}
      </p>
    </main>
  );
}
