import { auth, currentUser } from "@clerk/nextjs/server";
import { IconAffiliate, IconGauge, IconLanguage } from "@tabler/icons-react";
import Link from "next/link";

import {
  OpenWaterHeroRings,
  OpenWaterHeroWaves,
} from "@/components/app/open-water";
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
        <section className="dashboardSetupPanel" aria-labelledby="dashboard-setup-title">
          <p className="eyebrow">Dashboard</p>
          <h1 id="dashboard-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const now = new Date();
  const dashboard = await getDashboardHome({
    userId,
    now,
  });
  const nextPracticeItem = await getNextPracticeItemForUser(userId, now);

  return (
    <main className="dashboardShell">
      <SkillsTopbar current="dashboard" />

      <section className="openWaterHero dashboardHero" aria-labelledby="dashboard-title">
        <OpenWaterHeroWaves />
        <OpenWaterHeroRings />
        <div className="openWaterHeroContent">
          <p className="openWaterHeroEyebrow">{formatHeroDate(now)}</p>
          <h1 id="dashboard-title" className="disp tnum">
            {formatCount(dashboard.readyNowCount)} due skill
            {dashboard.readyNowCount === 1 ? "" : "s"} are ready.
          </h1>
          <div className="openWaterHeroActions">
            <Link className="bpbtn bpbtn-hero" href="/practice">
              Start session
            </Link>
            <Link className="bpbtn bpbtn-ghost" href="/skills">
              Browse skills
            </Link>
          </div>
        </div>
      </section>

      <section className="openWaterStatGrid" aria-label="Practice summary">
        <StatTile label="Due" value={formatCount(dashboard.readyNowCount)} tone="blue" />
        <StatTile
          label="Retention"
          value={formatAccuracy(dashboard.recentAccuracyPercent)}
          tone="green"
        />
        <StatTile label="Avg interval" value={formatAverageInterval(dashboard)} unit=" d" />
      </section>

      <DashboardReviewCard item={nextPracticeItem} />
      <DashboardCollections dashboard={dashboard} />
      <section className="openWaterTwoColumn">
        <ActivityHeatmap activityValues={dashboard.activityValues} />
        <WeeklyGoal recentReviewCount={dashboard.recentReviewCount} />
      </section>
      <Forecast dashboard={dashboard} now={now} />

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

function DashboardReviewCard({ item }: { item: PracticeItem }) {
  const ready = item.status === "ready";
  const prompt = ready ? item.exercise.prompt : "No verified exercise is due right now.";
  const skillTitle = ready ? item.skill.title : "Schedule clear";
  const label = ready ? formatFsrsState(item.skill.fsrsState) : "Waiting on the next due skill";

  return (
    <section className="openWaterSection openWaterReviewSection" aria-labelledby="up-next-title">
      <h2 id="up-next-title" className="disp openWaterSectionTitle">
        Up next
      </h2>
      <article className="openWaterReviewCard">
        <div className="openWaterReviewTop">
          <span>{label}</span>
          <span>{ready ? "Next due skill" : "Up to date"}</span>
        </div>
        <p className="openWaterReviewHint">{skillTitle}</p>
        <p className="disp openWaterReviewPrompt">
          <HighlightedPrompt prompt={prompt} />
        </p>
        {ready ? (
          <>
            <p className="openWaterReviewNote">
              <strong>Instant check.</strong> Open practice to answer this{" "}
              <span>verified exercise</span> and update the memory schedule.
            </p>
            <div className="openWaterReviewActions">
              <Link className="bpbtn bpbtn-blue" href="/practice">
                Open practice
              </Link>
            </div>
          </>
        ) : null}
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
    <section className="openWaterSection openWaterDecks" aria-labelledby="collections-title">
      <div className="openWaterSectionHeader">
        <h2 id="collections-title" className="disp openWaterSectionTitle">
          Collections
        </h2>
        <Link className="bpbtn bpbtn-blue openWaterNewDeck" href="/skills/new">
          Add skill
        </Link>
      </div>
      <div className="openWaterDeckList">
        {rows.map((row, index) => {
          const Icon = getDeckIcon(index);
          const progress = row.activeCount === 0 ? 100 : Math.round(
            ((row.activeCount - row.readyCount) / row.activeCount) * 100,
          );

          return (
            <article className="openWaterDeckRow" key={row.id}>
              <div className="openWaterDeckIcon" aria-hidden="true">
                <Icon size={17} />
              </div>
              <div className="openWaterDeckMain">
                <strong>{row.name}</strong>
                <span className="tnum">
                  {formatCount(row.activeCount)} active skill{row.activeCount === 1 ? "" : "s"}
                </span>
              </div>
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
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityHeatmap({ activityValues }: { activityValues: number[] }) {
  return (
    <section className="openWaterSmallCard" aria-labelledby="activity-title">
      <h2 id="activity-title" className="disp">
        Activity
      </h2>
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

function WeeklyGoal({ recentReviewCount }: { recentReviewCount: number }) {
  const goalDays = 7;
  // Approximate active days from recent reviews (~2 reviews per active day).
  // Any review counts as at least one day so a single review never reads as
  // "No reviews yet"; 0 reviews stays at 0.
  const days =
    recentReviewCount === 0
      ? 0
      : Math.min(goalDays, Math.max(1, Math.round(recentReviewCount / 2)));
  const circumference = 2 * Math.PI * 29;
  const filled = Math.round((days / goalDays) * circumference);
  const status = days >= 5 ? "On track" : days > 0 ? "Keep going" : "No reviews yet";

  return (
    <section className="openWaterSmallCard openWaterGoalCard" aria-labelledby="goal-title">
      <h2 id="goal-title" className="disp">
        Weekly goal
      </h2>
      <svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true">
        <circle cx="37" cy="37" r="29" fill="none" stroke="#ECF0FA" strokeWidth="7" />
        <circle
          cx="37"
          cy="37"
          r="29"
          fill="none"
          stroke="#1C44A8"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${Math.round(circumference)}`}
          transform="rotate(-90 37 37)"
        />
        <text
          x="37"
          y="35"
          textAnchor="middle"
          fontFamily="'Plus Jakarta Sans',sans-serif"
          fontSize="16"
          fontWeight="700"
          fill="#15233F"
        >
          {days}/{goalDays}
        </text>
        <text
          x="37"
          y="49"
          textAnchor="middle"
          fontFamily="'Instrument Sans',sans-serif"
          fontSize="9"
          fill="#6E7689"
        >
          days
        </text>
      </svg>
      <p data-status={status === "On track" ? "ontrack" : "progress"}>{status}</p>
    </section>
  );
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
    <section className="openWaterSection openWaterCompactSection" aria-labelledby="forecast-title">
      <div className="openWaterForecastCard">
        <div className="openWaterForecastHeader">
          <h2 id="forecast-title" className="disp">
            Next 7 days
          </h2>
          <span className="tnum">{formatCount(forecastCount)} cards forecast</span>
        </div>
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

function formatAverageInterval(dashboard: DashboardHome) {
  const intervals = dashboard.skills
    .map((skill) => skill.stability)
    .filter((stability): stability is number => typeof stability === "number" && stability > 0);

  if (intervals.length === 0) {
    return "0";
  }

  const meanIntervalDays =
    intervals.reduce((total, interval) => total + interval, 0) /
    intervals.length;

  return String(Math.max(1, Math.round(meanIntervalDays)));
}

function formatHeroDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).toUpperCase();
}

function getCollectionRows(dashboard: DashboardHome) {
  if (dashboard.collections.length > 0) {
    return dashboard.collections.slice(0, 4).map((collection) => ({
      id: collection.id,
      name: collection.name,
      activeCount: collection.activeSkillCount,
      readyCount: collection.readyNowCount,
    }));
  }

  if (dashboard.skills.length > 0) {
    return dashboard.skills.slice(0, 4).map((skill) => ({
      id: skill.id,
      name: skill.title,
      activeCount: 1,
      readyCount: skill.isReadyNow ? 1 : 0,
    }));
  }

  return [
    {
      id: "empty",
      name: "No collections yet",
      activeCount: 0,
      readyCount: 0,
    },
  ];
}

function getDeckIcon(index: number) {
  const icons = [IconLanguage, IconGauge, IconAffiliate];

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
