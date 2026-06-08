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
          <p className="eyebrow">Account controls</p>
          <h1>Reminders and data.</h1>
          <p>
            Manage quiet reminders and download a copy of your study data.
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

        <ReminderScheduleSummary
          enabled={settings.preference.enabled}
          localHour={settings.preference.localHour}
          minimumDueCount={settings.preference.minimumDueCount}
          timezone={settings.preference.timezone}
        />
        <ReminderSettingsForm preference={settings.preference} />
        <div className="settingsPrivacyNote" role="note" aria-label="Reminder privacy">
          <section>
            <h3>Email includes</h3>
            <p>Due skill count and one practice link.</p>
          </section>
          <section>
            <h3>Kept out</h3>
            <p>Skill titles, source text, answers, and exercise content.</p>
          </section>
        </div>
      </section>

      <section className="skillPanel settingsExportPanel" aria-labelledby="data-export-title">
        <div className="skillPanelHeader">
          <div>
            <p className="eyebrow">Data export</p>
            <h2 id="data-export-title">Download study data</h2>
          </div>
          <Link className="secondaryButton" href="/settings/export" prefetch={false}>
            Download JSON
          </Link>
        </div>

        <dl className="settingsExportFacts" aria-label="Data export details">
          <div data-priority="primary">
            <dt>Scope</dt>
            <dd>Your study data</dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>JSON</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>Signed-in only</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>No originals</dd>
          </div>
        </dl>

        <details className="settingsExportDetails" open>
          <summary>
            <span>Export contents and exclusions</span>
            <small>No original uploaded files or private storage locations.</small>
          </summary>
          <div className="settingsExportSummary">
            <section>
              <h3>Included</h3>
              <p>
                Collections, skills, stored source text, exercises, attempts,
                review logs, flags, generation job metadata, and reminder records.
              </p>
            </section>
            <section>
              <h3>Left out</h3>
              <p>
                Original uploaded file bytes, private storage locations, API keys,
                and raw AI prompts.
              </p>
            </section>
          </div>
        </details>
      </section>
    </main>
  );
}

function ReminderScheduleSummary({
  enabled,
  localHour,
  minimumDueCount,
  timezone,
}: {
  enabled: boolean;
  localHour: number;
  minimumDueCount: number;
  timezone: string;
}) {
  return (
    <dl className="settingsScheduleSummary" aria-label="Saved reminder schedule">
      <div data-state={enabled ? "enabled" : "disabled"}>
        <dt>Status</dt>
        <dd>{enabled ? "Sending when due" : "Paused"}</dd>
      </div>
      <div className="settingsScheduleDetails">
        <div>
          <dt>Local check</dt>
          <dd>
            {formatReminderHour(localHour)} in {timezone}
          </dd>
        </div>
        <div>
          <dt>Threshold</dt>
          <dd>{formatDueThreshold(minimumDueCount)}</dd>
        </div>
      </div>
    </dl>
  );
}

function formatReminderHour(hour: number) {
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${displayHour} ${meridiem}`;
}

function formatDueThreshold(count: number) {
  return `${count} due ${count === 1 ? "skill" : "skills"} minimum`;
}
