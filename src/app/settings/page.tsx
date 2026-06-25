import { auth, currentUser } from "@clerk/nextjs/server";
import { Card, DataList } from "@radix-ui/themes";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/ssr";

import { PressLink } from "@/components/app/open-water";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getReminderSettings } from "@/lib/reminders";
import { ensureDatabaseUser } from "@/lib/users";

import { ReminderSettingsForm } from "./reminder-settings-form";
import { SkillsTopbar } from "../skills/skills-topbar";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk returned no authenticated user.");
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

  const settings = await getReminderSettings({ userId });

  if (settings.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <Card asChild className="dashboardSetupPanel" size="3" variant="surface">
          <section aria-labelledby="settings-user-title">
            <h1 id="settings-user-title">Reminder settings are unavailable.</h1>
            <p>{settings.message}</p>
          </section>
        </Card>
      </main>
    );
  }

  return (
    <main className="skillShell settingsShell">
      <SkillsTopbar current="settings" />

      <header className="skillHeader settingsHeader">
        <h1>Settings</h1>
      </header>

      <Card asChild size="4" variant="surface">
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
      </Card>

      <Card asChild size="4" variant="surface">
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
              attempts, review history, flags, preparation records, and reminder settings.
            </p>
            <PressLink className="secondaryButton" href="/settings/export" prefetch={false} variant="white">
              <DownloadSimpleIcon aria-hidden="true" size={16} weight="bold" />
              Download export
            </PressLink>
          </div>

          <DataList.Root className="settingsExportFacts" aria-label="Data export details">
            <DataList.Item data-priority="primary">
              <DataList.Label>Scope</DataList.Label>
              <DataList.Value>Study records</DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Format</DataList.Label>
              <DataList.Value>JSON file</DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Access</DataList.Label>
              <DataList.Value>Signed-in only</DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Originals</DataList.Label>
              <DataList.Value>Not included</DataList.Value>
            </DataList.Item>
          </DataList.Root>

          <p className="settingsFinePrint">
            Original uploaded file bytes, private storage locations, API keys, and private model prompts
            are not included.
          </p>
        </section>
      </Card>
    </main>
  );
}
