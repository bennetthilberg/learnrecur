import { auth, currentUser } from "@clerk/nextjs/server";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { checkOpsAccessForEmail, getOpsOverview, type OpsOverview } from "@/lib/ops";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills/skills-topbar";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
  const opsAccess = checkOpsAccessForEmail(email);

  if (!opsAccess.allowed) {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <section className="dashboardSetupPanel" aria-labelledby="ops-access-title">
          <h1 id="ops-access-title">Operations access is restricted.</h1>
          <p>{opsAccess.message}</p>
        </section>
      </main>
    );
  }

  const databaseUser = await ensureDatabaseUser(clerkUser, {
    skipAlphaAccessCheck: true,
  });

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="settings" />
        <UserStatusPanel id="ops-setup-title" status={databaseUser} />
      </main>
    );
  }

  const overview = await getOpsOverview({ now: new Date() });

  return (
    <main className="skillShell">
      <SkillsTopbar current="settings" />

      <header className="skillHeader">
        <div>
          <h1>Production operations</h1>
          <p>
            Read-only alpha health checks for background jobs, uploads, reminders,
            flags, users, and daily usage.
          </p>
        </div>
      </header>

      <section className="skillPanel" aria-labelledby="ops-summary-title">
        <div className="skillPanelHeader">
          <div>
            <h2 id="ops-summary-title">Snapshot</h2>
          </div>
          <span className="dashboardChip">{formatDateTime(overview.generatedAt)}</span>
        </div>
        <div className="settingsExportFacts" aria-label="Operations summary">
          <section>
            <h3>Failed jobs</h3>
            <p>{overview.failedGenerationJobs.length}</p>
          </section>
          <section>
            <h3>Stale uploads</h3>
            <p>{overview.staleSourceFiles.length}</p>
          </section>
          <section>
            <h3>Failed reminders</h3>
            <p>{overview.failedReminderSends.length}</p>
          </section>
          <section>
            <h3>Open flags</h3>
            <p>{overview.openExerciseFlags.length}</p>
          </section>
        </div>
      </section>

      <OpsRows
        title="Failed generation jobs"
        empty="No failed generation jobs in the latest window."
        rows={overview.failedGenerationJobs.map((job) => ({
          id: job.id,
          primary: job.kind,
          secondary: job.errorMessage ?? "No error message stored.",
          meta: [job.userId, job.skillId, job.model, formatDateTime(job.updatedAt)],
        }))}
      />

      <OpsRows
        title="Stale source processing"
        empty="No stale processing uploads."
        rows={overview.staleSourceFiles.map((sourceFile) => ({
          id: sourceFile.id,
          primary: sourceFile.originalName,
          secondary: sourceFile.status,
          meta: [sourceFile.userId, formatDateTime(sourceFile.updatedAt)],
        }))}
      />

      <OpsRows
        title="Failed reminders"
        empty="No failed reminder sends."
        rows={overview.failedReminderSends.map((send) => ({
          id: send.id,
          primary: send.email ?? "No email stored",
          secondary: send.errorMessage ?? "No error message stored.",
          meta: [send.userId, send.localDate, formatDateTime(send.updatedAt)],
        }))}
      />

      <OpsRows
        title="Open exercise flags"
        empty="No open exercise flags."
        rows={overview.openExerciseFlags.map((flag) => ({
          id: flag.id,
          primary: flag.reason,
          secondary: flag.exerciseId,
          meta: [flag.userId, formatDateTime(flag.createdAt)],
        }))}
      />

      <OpsUsage overview={overview} />
    </main>
  );
}

function OpsRows({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    id: string;
    primary: string;
    secondary: string;
    meta: string[];
  }>;
}) {
  const headingId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return (
    <section className="skillPanel" aria-labelledby={headingId}>
      <div className="skillPanelHeader">
        <div>
          <h2 id={headingId}>{title}</h2>
        </div>
        <span className="dashboardChip">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <div className="dashboardEmptyState">
          <h3>{empty}</h3>
        </div>
      ) : (
        <div className="skillLibraryList">
          {rows.map((row) => (
            <article className="skillLibraryRow" key={row.id}>
              <div className="skillLibraryRowMain">
                <div>
                  <p>{row.primary}</p>
                  <p>{row.secondary}</p>
                </div>
              </div>
              <div className="skillMetaLine">
                {row.meta.map((item, index) => (
                  <span key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function OpsUsage({ overview }: { overview: OpsOverview }) {
  return (
    <section className="skillPanel" aria-labelledby="ops-usage-title">
      <div className="skillPanelHeader">
        <div>
          <h2 id="ops-usage-title">Daily usage</h2>
        </div>
      </div>
      <ul className="settingsPrivacyNote" aria-label="Daily usage leaders">
        <UsageList title="Generation jobs" rows={overview.dailyGenerationUsage} />
        <UsageList title="Source rows" rows={overview.dailySourceUsage} />
      </ul>
    </section>
  );
}

function UsageList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    userId: string;
    count: number;
  }>;
}) {
  return (
    <li>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p>No usage today.</p>
      ) : (
        <p>
          {rows
            .map((row) => `${row.userId}: ${row.count}`)
            .join("; ")}
        </p>
      )}
    </li>
  );
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}
