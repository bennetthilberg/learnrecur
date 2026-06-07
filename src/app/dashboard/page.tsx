import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { getDashboardHome, type DashboardHome } from "@/lib/dashboard";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills/skills-topbar";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="dashboardShell">
        <SkillsTopbar current="dashboard" />
        <section className="dashboardSetupPanel" aria-labelledby="dashboard-setup-title">
          <p className="eyebrow">Dashboard</p>
          <h1 id="dashboard-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const dashboard = await getDashboardHome({
    userId,
    now: new Date(),
  });

  return (
    <main className="dashboardShell">
      <SkillsTopbar current="dashboard" />

      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Today</p>
          <h1>Practice queue.</h1>
          <p>
            A compact read on what is ready, what is active, and how the recent
            review loop is holding up.
          </p>
        </div>
        <div className="dashboardHeaderActions">
          <Link
            className={dashboard.readyNowCount > 0 ? "primaryButton" : "secondaryButton"}
            href="/practice"
          >
            {dashboard.readyNowCount > 0 ? "Start practice" : "Open practice"}
          </Link>
          <Link className="secondaryButton" href="/skills/new">
            Add skill
          </Link>
          <Link className="secondaryButton" href="/history">
            Review history
          </Link>
          <Link className="secondaryButton" href="/settings">
            Reminder settings
          </Link>
        </div>
      </header>

      <section className="dashboardMetricGrid" aria-label="Practice summary">
        <MetricCard
          label="Ready now"
          value={formatCount(dashboard.readyNowCount)}
          detail="practice ready"
        />
        <MetricCard
          label="Active skills"
          value={formatCount(dashboard.activeSkillCount)}
          detail="in the schedule"
        />
        <MetricCard
          label="Recent accuracy"
          value={formatAccuracy(dashboard.recentAccuracyPercent)}
          detail="last 14 days"
        />
        <MetricCard
          label="Recent reviews"
          value={formatCount(dashboard.recentReviewCount)}
          detail="checked answers"
        />
      </section>

      <div className="dashboardContentGrid">
        <section className="dashboardPanel" aria-labelledby="collections-title">
          <div className="dashboardPanelHeader">
            <div>
              <p className="eyebrow">Collections</p>
              <h2 id="collections-title">Study areas</h2>
            </div>
            <Link className="dashboardPanelLink" href="/collections">
              Manage collections
            </Link>
          </div>

          {dashboard.collections.length === 0 ? (
            <DashboardEmptyState
              title="No study areas yet."
              detail="Create a collection first, or add a collection name while drafting a skill."
              actionHref="/collections"
              actionLabel="Manage collections"
            />
          ) : (
            <div className="collectionList">
              {dashboard.collections.map((collection) => (
                <article className="collectionRow dashboardCollectionRow" key={collection.id}>
                  <div className="dashboardCollectionMain">
                    <h3>{collection.name}</h3>
                    <dl
                      className="dashboardCollectionFacts"
                      aria-label={`${collection.name} collection summary`}
                    >
                      <div>
                        <dt>Ready</dt>
                        <dd data-ready={collection.readyNowCount > 0 ? "true" : "false"}>
                          {formatCount(collection.readyNowCount)}
                        </dd>
                      </div>
                      <div>
                        <dt>Active</dt>
                        <dd>{formatCount(collection.activeSkillCount)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="collectionRowPractice">
                    <Link
                      aria-label={`Practice collection ${collection.name}`}
                      className="dashboardPanelLink"
                      href={`/practice?collectionId=${encodeURIComponent(collection.id)}`}
                    >
                      Practice
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="dashboardPanel dashboardPanelPrimary" aria-labelledby="skills-title">
          <div className="dashboardPanelHeader">
            <div>
              <p className="eyebrow">Skills</p>
              <h2 id="skills-title">Active schedule</h2>
            </div>
            <Link className="dashboardPanelLink" href="/skills">
              View all skills
            </Link>
          </div>

          {dashboard.skills.length === 0 ? (
            <DashboardEmptyState
              title="No scheduled skills."
              detail="Drafts stay out of practice until you review and activate them."
              actionHref="/skills/new"
              actionLabel="Add skill"
            />
          ) : (
            <div className="skillList">
              {dashboard.skills.map((skill) => (
                <article className="skillRow" key={skill.id}>
                  <div className="skillRowMain">
                    <div>
                      <h3>
                        <Link aria-label={`Open ${skill.title}`} href={`/skills/${skill.id}`}>
                          {skill.title}
                          <span className="rowOpenCue" aria-hidden="true">
                            Open
                          </span>
                        </Link>
                      </h3>
                      <p>
                        {skill.collectionName ?? "Uncollected"} / {formatFsrsState(skill.fsrsState)}
                      </p>
                    </div>
                    <span className="dashboardChip" data-tone={skill.isReadyNow ? "ready" : "neutral"}>
                      {skill.dueLabel}
                    </span>
                  </div>

                  <div className="skillMetaLine">
                    <span>{formatCount(skill.repetitions)} reps</span>
                    <span>{formatCount(skill.lapses)} lapses</span>
                    {skill.tags.slice(0, 3).map((tag) => (
                      <span className="dashboardTag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {dashboard.readyNowCount === 0 ? (
        <section className="dashboardMessage" aria-label="Practice status">
          <div>
            <p className="eyebrow">Queue</p>
            <h2>Nothing is ready for practice.</h2>
          </div>
          <p>
            This can mean every active skill is scheduled for later, or the ready skills
            do not have verified practiceable exercises yet.
          </p>
        </section>
      ) : null}
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="dashboardMetricCard">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function DashboardEmptyState({
  title,
  detail,
  actionHref = "/practice",
  actionLabel = "Open practice",
}: {
  title: string;
  detail: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="dashboardEmptyState">
      <h3>{title}</h3>
      <p>{detail}</p>
      <Link className="secondaryButton" href={actionHref}>
        {actionLabel}
      </Link>
    </div>
  );
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatAccuracy(accuracy: DashboardHome["recentAccuracyPercent"]) {
  return accuracy === null ? "No data" : `${accuracy}%`;
}

function formatFsrsState(state: DashboardHome["skills"][number]["fsrsState"]) {
  return state.toLowerCase().replaceAll("_", " ");
}
