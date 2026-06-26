import { auth, currentUser } from "@clerk/nextjs/server";
import { CirclesThreePlus, Gauge, Translate } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import {
  OpenWaterHeroRings,
  OpenWaterHeroWaves,
} from "@/components/app/open-water";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getDashboardHome, type DashboardHome } from "@/lib/dashboard";
import { formatFsrsState } from "@/lib/formatters";
import { ensureDatabaseUser } from "@/lib/users";

import { MathText } from "../practice/math-text";
import { getNextPracticeItemForUser } from "../practice/queries";
import type { PracticeItem } from "../practice/types";
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
        <UserStatusPanel id="dashboard-setup-title" status={databaseUser} />
      </main>
    );
  }

  const now = new Date();
  const dashboard = await getDashboardHome({
    userId,
    now,
  });
  const nextPracticeItem = await getNextPracticeItemForUser(userId, now);
  const hasDuePractice = dashboard.readyNowCount > 0;

  return (
    <main className="dashboardShell">
      <SkillsTopbar current="dashboard" />

      <section
        className="openWaterHero dashboardHero"
        data-practice-clear={hasDuePractice ? "false" : "true"}
        aria-labelledby="dashboard-title"
      >
        <OpenWaterHeroWaves />
        {hasDuePractice ? null : <DashboardHeroShoreWave />}
        <OpenWaterHeroRings />
        <div className="openWaterHeroContent">
          <h1 id="dashboard-title" className="disp tnum">
            {formatCount(dashboard.readyNowCount)} due skill
            {dashboard.readyNowCount === 1 ? " is" : "s are"} ready.
          </h1>
          {hasDuePractice ? (
            <div className="openWaterHeroActions">
              <Link className="bpbtn bpbtn-hero" href="/practice">
                Start practice
              </Link>
              <Link className="bpbtn bpbtn-ghost" href="/skills">
                Browse skills
              </Link>
            </div>
          ) : (
            <p className="dashboardHeroComplete">
              You&apos;ve completed all your exercises for today. Check back tomorrow for the
              next wave of practice.
            </p>
          )}
        </div>
      </section>

      <section className="openWaterStatGrid" aria-label="Practice summary">
        <StatTile label="Due" value={formatCount(dashboard.readyNowCount)} tone="blue" />
        <StatTile label="Active" value={formatCount(dashboard.activeSkillCount)} />
        <StatTile
          label="Retention"
          value={formatAccuracy(dashboard.recentAccuracyPercent)}
          tone="green"
        />
      </section>

      <DashboardReviewCard dashboard={dashboard} item={nextPracticeItem} />
      <DashboardCollections dashboard={dashboard} />
    </main>
  );
}

function DashboardHeroShoreWave() {
  return (
    <svg
      viewBox="0 0 580 60"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="dashboardHeroShoreWave"
    >
      <path d="M0 43 Q 72 31 145 43 T 290 43 T 435 43 T 580 43 V60 H0 Z" fill="#E3CE98" />
      <path
        d="M0 43 Q 72 31 145 43 T 290 43 T 435 43 T 580 43"
        fill="none"
        stroke="rgba(255,255,255,0.42)"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function StatTile({
  label,
  value,
  unit,
  tone = "ink",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "blue" | "green" | "ink";
}) {
  return (
    <article className="openWaterStatTile">
      <p>{label}</p>
      <strong className="disp tnum" data-tone={tone}>
        {value}
        {unit ? <span>{unit}</span> : null}
      </strong>
    </article>
  );
}

function DashboardReviewCard({
  dashboard,
  item,
}: {
  dashboard: DashboardHome;
  item: PracticeItem;
}) {
  const ready = item.status === "ready";
  const caughtUp = item.status === "none-due";
  const prompt = ready
    ? item.exercise.prompt
    : caughtUp
      ? "You're all caught up for now."
      : "Practice is unavailable right now.";
  const skillTitle = ready
    ? item.skill.title
    : caughtUp
      ? "Due queue clear"
      : "Practice unavailable";
  const label = ready
    ? formatFsrsState(item.skill.fsrsState)
    : caughtUp
      ? "No due practice right now"
      : "Practice needs attention";
  const activeSummary = `${formatCount(dashboard.activeSkillCount)} active skill${
    dashboard.activeSkillCount === 1 ? "" : "s"
  }`;

  return (
    <section className="openWaterSection openWaterReviewSection" aria-labelledby="up-next-title">
      <h2 id="up-next-title" className="disp openWaterSectionTitle">
        Up next
      </h2>
      <article className="openWaterReviewCard">
        <div className="openWaterReviewTop">
          <span>{label}</span>
          <span className="tnum">{activeSummary}</span>
        </div>
        <p className="openWaterReviewHint">{skillTitle}</p>
        <p className="disp openWaterReviewPrompt">
          <MathText text={prompt} />
        </p>
        {ready ? (
          <p className="openWaterReviewNote">
            <strong>Instant check.</strong> Open practice to answer this{" "}
            <span>verified exercise</span> and update the memory schedule.
          </p>
        ) : null}
        <div className="openWaterReviewActions">
          {ready ? (
            <>
              <Link className="bpbtn bpbtn-blue" href="/practice">
                Practice now
              </Link>
              <Link className="bpbtn bpbtn-white" href="/skills">
                Review skills
              </Link>
            </>
          ) : (
            <Link className="bpbtn bpbtn-blue" href="/skills">
              Review skills
            </Link>
          )}
        </div>
      </article>
    </section>
  );
}

function DashboardCollections({ dashboard }: { dashboard: DashboardHome }) {
  const rows = getCollectionRows(dashboard);

  return (
    <section className="openWaterSection openWaterCollections" aria-labelledby="collections-title">
      <div className="openWaterSectionHeader">
        <h2 id="collections-title" className="disp openWaterSectionTitle">
          Collections
        </h2>
        <Link className="bpbtn bpbtn-blue openWaterNewDeck" href="/skills/new">
          + New skill
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="openWaterDeckList">
          <div className="dashboardEmptyState openWaterDeckEmpty">
            <h3>No active skills yet</h3>
            <p>Add a skill to start the practice schedule.</p>
          </div>
        </div>
      ) : (
        <div className="openWaterDeckList">
          {rows.map((row, index) => {
            const Icon = row.kind === "collection" ? getCollectionIcon(index) : null;
            const hasActiveSkills = row.activeCount > 0;
            const progress = hasActiveSkills
              ? Math.round(((row.activeCount - row.readyCount) / row.activeCount) * 100)
              : 0;

            return (
              <article
                className="openWaterDeckRow"
                data-has-icon={Icon ? "true" : "false"}
                key={row.id}
              >
                {Icon ? (
                  <div className="openWaterDeckIcon" aria-hidden="true">
                    <Icon size={17} weight="regular" />
                  </div>
                ) : null}
                <div className="openWaterDeckMain">
                  <strong>{row.name}</strong>
                  <span className="tnum">
                    {formatCount(row.activeCount)} active skill
                    {row.activeCount === 1 ? "" : "s"} · {row.meta}
                  </span>
                </div>
                {hasActiveSkills ? (
                  <>
                    <div className="openWaterMiniProgress" aria-hidden="true">
                      <span
                        data-complete={row.readyCount === 0 ? "true" : "false"}
                        style={{ width: `${Math.max(progress, 8)}%` }}
                      />
                    </div>
                    <span
                      className="openWaterStatusBadge tnum"
                      data-tone={row.readyCount > 0 ? "due" : "stable"}
                    >
                      {row.readyCount > 0 ? `${formatCount(row.readyCount)} due` : "Stable"}
                    </span>
                  </>
                ) : null}
                {row.href ? (
                  <Link className="openWaterRowLink" href={row.href}>
                    {row.readyCount > 0 ? "Practice" : "Open"}
                  </Link>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatAccuracy(accuracy: DashboardHome["recentAccuracyPercent"]) {
  return accuracy === null ? "No reviews" : `${accuracy}%`;
}

function getCollectionRows(dashboard: DashboardHome) {
  if (dashboard.collections.length > 0) {
    return dashboard.collections.slice(0, 4).map((collection) => ({
      kind: "collection" as const,
      id: collection.id,
      name: collection.name,
      activeCount: collection.activeSkillCount,
      readyCount: collection.readyNowCount,
      href: `/practice?collectionId=${collection.id}`,
      meta:
        collection.readyNowCount > 0
          ? `${formatCount(collection.readyNowCount)} ready now`
          : "stable for now",
    }));
  }

  if (dashboard.skills.length > 0) {
    return dashboard.skills.slice(0, 4).map((skill) => ({
      kind: "skill" as const,
      id: skill.id,
      name: skill.title,
      activeCount: 1,
      readyCount: skill.isReadyNow ? 1 : 0,
      href: skill.isReadyNow ? "/practice" : `/skills/${skill.id}`,
      meta: skill.dueLabel.toLowerCase(),
    }));
  }

  return [];
}

function getCollectionIcon(index: number) {
  const icons = [Translate, Gauge, CirclesThreePlus];

  return icons[index % icons.length];
}
