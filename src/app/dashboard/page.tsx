import { auth, currentUser } from "@clerk/nextjs/server";
import { IconAffiliate, IconGauge, IconLanguage, IconSearch } from "@tabler/icons-react";
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
              Browse decks
            </Link>
            <span className="openWaterHeroMicro tnum">
              Reviews {formatCount(dashboard.recentReviewCount)} · Retention{" "}
              {formatAccuracy(dashboard.recentAccuracyPercent)}
            </span>
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

      <DashboardReviewCard dashboard={dashboard} item={nextPracticeItem} />
      <DashboardDecks dashboard={dashboard} />
      <section className="openWaterTwoColumn">
        <ActivityHeatmap />
        <WeeklyGoal recentReviewCount={dashboard.recentReviewCount} />
      </section>
      <Forecast dashboard={dashboard} now={now} />
      <SessionPreferences />

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

function DashboardReviewCard({
  dashboard,
  item,
}: {
  dashboard: DashboardHome;
  item: PracticeItem;
}) {
  const ready = item.status === "ready";
  const prompt = ready ? item.exercise.prompt : "No verified exercise is due right now.";
  const skillTitle = ready ? item.skill.title : "Schedule clear";
  const label = ready ? formatFsrsState(item.skill.fsrsState) : "Waiting on the next due skill";
  const counterTotal = Math.max(dashboard.activeSkillCount, 1);

  return (
    <section className="openWaterSection openWaterReviewSection" aria-labelledby="up-next-title">
      <h2 id="up-next-title" className="disp openWaterSectionTitle">
        Up next
      </h2>
      <article className="openWaterReviewCard">
        <div className="openWaterReviewTop">
          <span>{label}</span>
          <span className="tnum">Card 1 / {formatCount(counterTotal)}</span>
        </div>
        <div className="openWaterProgress" aria-hidden="true">
          <span style={{ width: ready ? "44%" : "12%" }} />
        </div>
        <p className="openWaterReviewHint">{skillTitle}</p>
        <p className="disp openWaterReviewPrompt">
          <HighlightedPrompt prompt={prompt} />
        </p>
        <p className="openWaterReviewNote">
          <strong>Instant check.</strong> Open practice to answer this{" "}
          <span>verified exercise</span> and update the memory schedule.
        </p>
        <div className="openWaterGradeGrid" aria-label="Review rating shortcuts">
          <Link className="bpbtn bpbtn-again" href="/practice">
            Again
          </Link>
          <Link className="bpbtn bpbtn-white" href="/practice">
            Hard
          </Link>
          <Link className="bpbtn bpbtn-blue" href="/practice">
            Good
          </Link>
          <Link className="bpbtn bpbtn-green" href="/practice">
            Easy
          </Link>
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

  return (
    <>
      {words.slice(0, index).join(" ")}
      {index > 0 ? " " : ""}
      <span>{words[index]}</span>
      {index < words.length - 1 ? ` ${words.slice(index + 1).join(" ")}` : ""}
    </>
  );
}

function DashboardDecks({ dashboard }: { dashboard: DashboardHome }) {
  const decks = getDeckRows(dashboard);

  return (
    <section className="openWaterSection openWaterDecks" aria-labelledby="decks-title">
      <div className="openWaterSectionHeader">
        <h2 id="decks-title" className="disp openWaterSectionTitle">
          Decks
        </h2>
        <Link className="bpbtn bpbtn-blue openWaterNewDeck" href="/skills/new">
          + New deck
        </Link>
      </div>
      <div className="openWaterDeckTools">
        <div className="openWaterChips" aria-label="Deck filters">
          <button type="button" aria-pressed="true">
            All
          </button>
          <button type="button" aria-pressed="false">
            Due
          </button>
          <button type="button" aria-pressed="false">
            Stable
          </button>
        </div>
        <div className="openWaterSearch" aria-label="Search decks">
          <IconSearch aria-hidden="true" size={14} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </div>
      </div>
      <div className="openWaterDeckList">
        {decks.map((deck, index) => {
          const Icon = getDeckIcon(index);
          const progress = deck.activeCount === 0 ? 100 : Math.round(
            ((deck.activeCount - deck.readyCount) / deck.activeCount) * 100,
          );

          return (
            <article className="openWaterDeckRow" key={deck.id}>
              <div className="openWaterDeckIcon" aria-hidden="true">
                <Icon size={17} />
              </div>
              <div className="openWaterDeckMain">
                <strong>{deck.name}</strong>
                <span className="tnum">
                  {formatCount(deck.activeCount)} skills · {deck.meta}
                </span>
              </div>
              <div className="openWaterMiniProgress" aria-hidden="true">
                <span
                  data-complete={deck.readyCount === 0 ? "true" : "false"}
                  style={{ width: `${Math.max(progress, 8)}%` }}
                />
              </div>
              <span
                className="openWaterStatusBadge tnum"
                data-tone={deck.readyCount > 0 ? "due" : "stable"}
              >
                {deck.readyCount > 0 ? `${formatCount(deck.readyCount)} due` : "Stable"}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityHeatmap() {
  const values = [
    0, 1, 2, 0, 3, 4, 2,
    1, 0, 2, 3, 1, 2, 4,
    0, 2, 1, 4, 3, 0, 1,
    2, 3, 0, 1, 4, 2, 3,
    1, 0, 3, 2, 4, 1, 2,
  ];

  return (
    <section className="openWaterSmallCard" aria-labelledby="activity-title">
      <h2 id="activity-title" className="disp">
        Activity
      </h2>
      <div className="openWaterHeatmap" aria-hidden="true">
        {values.map((value, index) => (
          <span data-heat={value} key={index} />
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

function WeeklyGoal({ recentReviewCount }: { recentReviewCount: number }) {
  const days = Math.min(7, Math.max(1, Math.ceil(recentReviewCount / 2)));

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
          strokeDasharray="130 182"
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
          {days}/7
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
      <p>On track</p>
    </section>
  );
}

function Forecast({ dashboard, now }: { dashboard: DashboardHome; now: Date }) {
  const bars = ["100%", "64%", "44%", "82%", "30%", "54%", "38%"];
  const labels = getForecastLabels(now);
  const forecastCount = Math.max(dashboard.readyNowCount, 0) + dashboard.skills.length * 2;

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
              key={height}
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

function SessionPreferences() {
  return (
    <section className="openWaterSection openWaterCompactSection" aria-labelledby="session-preferences-title">
      <div className="openWaterPrefsCard">
        <h2 id="session-preferences-title" className="disp">
          Session preferences
        </h2>
        <PreferenceSwitch label="Include exact input" checked />
        <PreferenceSwitch label="Show explanations" checked />
        <PreferenceSwitch label="Reduced motion" checked={false} />
      </div>
    </section>
  );
}

function PreferenceSwitch({ label, checked }: { label: string; checked: boolean }) {
  return (
    <button className="openWaterToggleRow" type="button" role="switch" aria-checked={checked}>
      <span>{label}</span>
      <i data-checked={checked ? "true" : "false"} aria-hidden="true">
        <span />
      </i>
    </button>
  );
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatAccuracy(accuracy: DashboardHome["recentAccuracyPercent"]) {
  return accuracy === null ? "No reviews" : `${accuracy}%`;
}

function formatAverageInterval(dashboard: DashboardHome) {
  if (dashboard.activeSkillCount === 0) {
    return "0";
  }

  return String(Math.max(1, Math.round((dashboard.recentReviewCount + dashboard.activeSkillCount) / 2)));
}

function formatHeroDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).toUpperCase();
}

function getDeckRows(dashboard: DashboardHome) {
  if (dashboard.collections.length > 0) {
    return dashboard.collections.slice(0, 4).map((collection) => ({
      id: collection.id,
      name: collection.name,
      activeCount: collection.activeSkillCount,
      readyCount: collection.readyNowCount,
      meta: collection.readyNowCount > 0 ? "last reviewed today" : "caught up",
    }));
  }

  if (dashboard.skills.length > 0) {
    return dashboard.skills.slice(0, 4).map((skill) => ({
      id: skill.id,
      name: skill.title,
      activeCount: 1,
      readyCount: skill.isReadyNow ? 1 : 0,
      meta: skill.dueLabel.toLowerCase(),
    }));
  }

  return [
    {
      id: "empty",
      name: "No decks yet",
      activeCount: 0,
      readyCount: 0,
      meta: "add a skill to begin",
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
