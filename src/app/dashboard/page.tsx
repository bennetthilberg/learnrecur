import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { getDashboardHome, type DashboardHome } from "@/lib/dashboard";
import { formatFsrsState } from "@/lib/formatters";
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
          <h1>Due practice</h1>
          <p>
            A compact read on what is ready, what is active, and how the recent
            review loop is holding up.
          </p>
        </div>
        <div className="dashboardHeaderActions">
          <div className="dashboardHeaderPrimaryActions">
            <Link
              className={dashboard.readyNowCount > 0 ? "primaryButton" : "secondaryButton"}
              href="/practice"
            >
              {dashboard.readyNowCount > 0 ? "Start practice" : "Open practice"}
            </Link>
            <Link className="secondaryButton" href="/skills/new">
              Add skill
            </Link>
          </div>
          <div
            className="dashboardHeaderUtilityLinks"
            role="group"
            aria-label="Dashboard utility links"
          >
            <Link href="/history">Review history</Link>
            <Link href="/settings">Settings</Link>
          </div>
        </div>
      </header>

      <section className="dashboardPracticeSummary" aria-label="Practice summary">
        <article
          className="dashboardReadySummary"
          data-ready={dashboard.readyNowCount > 0 ? "true" : "false"}
        >
          <p className="eyebrow">Ready now</p>
          <div className="dashboardReadyValue">
            <strong>{formatCount(dashboard.readyNowCount)}</strong>
            <span>{formatReadySummaryDetail(dashboard.readyNowCount)}</span>
          </div>
          <p>
            {dashboard.readyNowCount > 0
              ? "Start with the earliest due active skill, then continue through today's reviews."
              : "Every active skill is scheduled for later or waiting on verified exercises."}
          </p>
        </article>
        <dl className="dashboardSupportMetrics">
          <div>
            <dt>Active skills</dt>
            <dd className="dashboardSupportMetricValue">{formatCount(dashboard.activeSkillCount)}</dd>
            <dd className="dashboardSupportMetricDetail">in schedule</dd>
          </div>
          <div>
            <dt>Recent accuracy</dt>
            <dd className="dashboardSupportMetricValue">
              {formatAccuracy(dashboard.recentAccuracyPercent)}
            </dd>
            <dd className="dashboardSupportMetricDetail">last 14 days</dd>
          </div>
          <div>
            <dt>Recent reviews</dt>
            <dd className="dashboardSupportMetricValue">
              {formatCount(dashboard.recentReviewCount)}
            </dd>
            <dd className="dashboardSupportMetricDetail">checked answers</dd>
          </div>
        </dl>
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
              title="No study areas yet"
              detail="Create a study area, or name one while drafting a skill."
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
                      <div data-priority="primary">
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
                      className="dashboardPanelLink dashboardCollectionPracticeLink"
                      data-ready={collection.readyNowCount > 0 ? "true" : "false"}
                      href={`/practice?collectionId=${encodeURIComponent(collection.id)}`}
                    >
                      {collection.readyNowCount > 0 ? "Practice now" : "Open practice"}
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
              title="No scheduled skills"
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
                      <p className="skillRowContext">
                        <span>{skill.collectionName ?? "Uncollected"}</span>
                        <span>{formatFsrsState(skill.fsrsState)}</span>
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
            <p className="eyebrow">Due practice</p>
            <h2>Nothing is ready for practice</h2>
          </div>
          <p>
            This can mean every active skill is scheduled for later, or the ready skills
            do not yet have verified exercises for the practice screen.
          </p>
        </section>
      ) : null}
    </main>
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
  return accuracy === null ? "No reviews" : `${accuracy}%`;
}

function formatReadySummaryDetail(count: number) {
  return count === 1 ? "skill ready" : "skills ready";
}
