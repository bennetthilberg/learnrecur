import { auth, currentUser } from "@clerk/nextjs/server";
import { CirclesThreePlus, Gauge, Translate } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { SkillFsrsState } from "@/generated/prisma/enums";
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
  const newSkillCount = dashboard.skills.filter(
    (skill) => skill.fsrsState === SkillFsrsState.NEW,
  ).length;
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
        <StatTile label="New" value={formatCount(newSkillCount)} />
        <StatTile
          label="Retention"
          value={formatAccuracy(dashboard.recentAccuracyPercent)}
          tone="green"
        />
      </section>

      <DashboardReviewCard dashboard={dashboard} item={nextPracticeItem} />
      <DashboardCollections dashboard={dashboard} />
      <section className="openWaterTwoColumn">
        <ActivityHeatmap
          activityValues={dashboard.activityValues}
          reviewCount={dashboard.activityReviewCount}
        />
        <Forecast dashboard={dashboard} now={now} />
      </section>
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
          {ready ? <HighlightedPrompt prompt={prompt} /> : <MathText text={prompt} />}
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

function HighlightedPrompt({ prompt }: { prompt: string }) {
  const words = prompt.trim().split(/\s+/);

  if (words.length < 2) {
    return <MathText text={prompt} />;
  }

  const highlightIndex = words.findIndex((word) => word.length > 4);
  const index = highlightIndex === -1 ? words.length - 1 : highlightIndex;
  const prefix = words.slice(0, index).join(" ");
  const highlighted = words[index];
  const suffix = words.slice(index + 1).join(" ");

  return (
    <>
      {prefix ? <MathText text={prefix} /> : null}
      {prefix ? " " : ""}
      <span className="openWaterReviewPromptHighlight">
        <MathText text={highlighted} />
      </span>
      {suffix ? " " : ""}
      {suffix ? <MathText text={suffix} /> : null}
    </>
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
      <div className="openWaterDeckList">
        {rows.map((row, index) => {
          const Icon = getCollectionIcon(index);
          const hasActiveSkills = row.activeCount > 0;
          const progress = hasActiveSkills ? Math.round(
            ((row.activeCount - row.readyCount) / row.activeCount) * 100,
          ) : 0;

          return (
            <article className="openWaterDeckRow" key={row.id}>
              <div className="openWaterDeckIcon" aria-hidden="true">
                <Icon size={17} weight="regular" />
              </div>
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
                    {row.readyCount > 0 ? `${formatCount(row.readyCount)} ready` : "Scheduled"}
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
    </section>
  );
}

function ActivityHeatmap({
  activityValues,
  reviewCount,
}: {
  activityValues: number[];
  reviewCount: number;
}) {
  return (
    <section className="openWaterSmallCard" aria-labelledby="activity-title">
      <h2 id="activity-title" className="disp">
        Activity
      </h2>
      <p className="openWaterCardSummary tnum">
        {formatCount(reviewCount)} completed review{reviewCount === 1 ? "" : "s"} in the
        last 35 days.
      </p>
      <div className="openWaterHeatmap" aria-hidden="true">
        {activityValues.map((value, index) => (
          <span data-heat={clampHeatValue(value)} key={index} />
        ))}
      </div>
      <div className="openWaterLegend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((value) => (
          <i data-heat={value} key={value} />
        ))}
        <span>More</span>
      </div>
    </section>
  );
}

function clampHeatValue(value: number) {
  return Math.min(4, Math.max(0, Math.round(value)));
}

function Forecast({ dashboard, now }: { dashboard: DashboardHome; now: Date }) {
  const labels = getForecastLabels(now);
  const counts = getForecastCounts(dashboard.skills, now);
  const maxCount = Math.max(...counts, 1);
  const bars = counts.map(
    (count) => `${Math.min(100, Math.round((count / maxCount) * 100))}%`,
  );
  const forecastCount =
    Math.max(dashboard.readyNowCount, 0) +
    counts.reduce((total, count) => total + count, 0);

  return (
    <section className="openWaterSmallCard openWaterForecastCard" aria-labelledby="forecast-title">
      <div className="openWaterForecastHeader">
        <h2 id="forecast-title" className="disp">
          Next 7 days
        </h2>
        <span className="tnum">{formatCount(forecastCount)} skills scheduled</span>
      </div>
      <p className="openWaterCardSummary tnum">
        {formatCount(dashboard.readyNowCount)} ready now;{" "}
        {formatCount(counts.reduce((total, count) => total + count, 0))} scheduled later.
      </p>
      <div className="openWaterForecastBars" aria-hidden="true">
        {bars.map((height, index) => (
          <span
            data-today={index === 0 ? "true" : "false"}
            key={index}
            style={{ height }}
          />
        ))}
      </div>
      <div className="openWaterForecastLabels" aria-hidden="true">
        {labels.map((label, index) => (
          <span data-today={index === 0 ? "true" : "false"} key={label}>
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

function getForecastCounts(skills: DashboardHome["skills"], now: Date) {
  const today = startOfLocalDay(now);
  const counts = Array.from({ length: 7 }, () => 0);

  for (const skill of skills) {
    if (!skill.dueAt) {
      continue;
    }

    const dueAt = new Date(skill.dueAt);

    if (Number.isNaN(dueAt.getTime()) || dueAt <= now) {
      continue;
    }

    const dayIndex = daysBetween(today, startOfLocalDay(dueAt));

    if (dayIndex >= 0 && dayIndex < counts.length) {
      counts[dayIndex] += 1;
    }
  }

  return counts;
}

function startOfLocalDay(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function daysBetween(start: Date, end: Date) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());

  return Math.floor((endUtc - startUtc) / millisecondsPerDay);
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
      id: collection.id,
      name: collection.name,
      activeCount: collection.activeSkillCount,
      readyCount: collection.readyNowCount,
      href: `/practice?collectionId=${collection.id}`,
      meta:
        collection.readyNowCount > 0
          ? `${formatCount(collection.readyNowCount)} ready now`
          : "scheduled for later",
    }));
  }

  if (dashboard.skills.length > 0) {
    return dashboard.skills.slice(0, 4).map((skill) => ({
      id: skill.id,
      name: skill.title,
      activeCount: 1,
      readyCount: skill.isReadyNow ? 1 : 0,
      href: skill.isReadyNow ? "/practice" : `/skills/${skill.id}`,
      meta: skill.dueLabel.toLowerCase(),
    }));
  }

  return [
    {
      id: "empty",
      name: "No active skills yet",
      activeCount: 0,
      readyCount: 0,
      href: "/skills/new",
      meta: "add a skill to begin",
    },
  ];
}

function getCollectionIcon(index: number) {
  const icons = [Translate, Gauge, CirclesThreePlus];

  return icons[index % icons.length];
}

function getForecastLabels(now: Date) {
  return Array.from({ length: 7 }, (_, offset) => {
    if (offset === 0) {
      return "Today";
    }

    const date = new Date(now);
    date.setDate(now.getDate() + offset);

    return date.toLocaleDateString("en-US", { weekday: "short" });
  });
}
