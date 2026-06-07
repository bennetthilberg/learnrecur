import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

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
        <section className="dashboardSetupPanel" aria-labelledby="settings-setup-title">
          <p className="eyebrow">Settings</p>
          <h1 id="settings-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const settings = await getReminderSettings({ userId });

  if (settings.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <section className="dashboardSetupPanel" aria-labelledby="settings-user-title">
          <p className="eyebrow">Settings</p>
          <h1 id="settings-user-title">Reminder settings are unavailable.</h1>
          <p>{settings.message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="skillShell">
      <SkillsTopbar current="settings" />

      <header className="skillHeader">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Reminder settings.</h1>
          <p>
            Opt in to a single count-only email when enough practice is due at
            your chosen local hour.
          </p>
        </div>
        <Link className="secondaryButton" href="/dashboard">
          Back to dashboard
        </Link>
      </header>

      <section className="skillPanel" aria-labelledby="reminder-settings-title">
        <div className="skillPanelHeader">
          <div>
            <p className="eyebrow">Email reminders</p>
            <h2 id="reminder-settings-title">Due practice check</h2>
          </div>
          <span className="dashboardChip" data-tone={settings.preference.enabled ? "ready" : "neutral"}>
            {settings.preference.enabled ? "On" : "Off"}
          </span>
        </div>

        <ReminderSettingsForm preference={settings.preference} />
      </section>

      <section className="skillMessage" aria-label="Reminder privacy">
        <p>
          Reminder emails include the number of due skills and a practice link.
          They do not include skill titles, source text, answers, or exercise
          content.
        </p>
      </section>
    </main>
  );
}
