import { auth, currentUser } from "@clerk/nextjs/server";
import {
  BookOpenText,
  CheckCircle,
  Flag,
  GearSix,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  formatDueLabel,
  formatReviewDate,
} from "@/lib/practice/history-formatters";
import {
  getNeedsAttention,
  isNeedsAttentionMiss,
  NEEDS_ATTENTION_DEFAULT_LIMIT,
  NEEDS_ATTENTION_MAX_LIMIT,
  NeedsAttentionCursorError,
  type NeedsAttentionItem,
} from "@/lib/practice/needs-attention";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../../skills/skills-topbar";

export const dynamic = "force-dynamic";

type NeedsAttentionPageProps = {
  searchParams?: Promise<{
    cursor?: string | string[];
    limit?: string | string[];
  }>;
};

export default async function NeedsAttentionPage({
  searchParams,
}: NeedsAttentionPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const cursor = parseQueryValue(resolvedSearchParams.cursor);
  const limit = parseLimit(resolvedSearchParams.limit);

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="practiceShell practiceAttentionShell">
        <SkillsTopbar current="practice" />
        <UserStatusPanel id="practice-attention-setup-title" status={databaseUser} />
      </main>
    );
  }

  let result;
  try {
    result = await getNeedsAttention({
      userId,
      now: new Date(),
      limit,
      cursor,
    });
  } catch (error) {
    if (error instanceof NeedsAttentionCursorError) {
      redirect(buildAttentionHref({ limit }));
    }
    throw error;
  }

  return (
    <main className="practiceShell practiceAttentionShell">
      <SkillsTopbar current="practice" />
      <div className="practiceAttentionPage">
        <header className="practiceAttentionHeader">
          <div>
            <h1>Needs attention</h1>
            <p>
              A short list of observable practice patterns and preparation problems.
              These signals do not diagnose a misconception, pause a skill, or erase
              your history.
            </p>
          </div>
          <div className="practiceAttentionHeaderActions">
            <Link className="primaryButton" href="/practice">
              Open practice
            </Link>
            <Link className="secondaryButton" href="/skills">
              Browse skills
            </Link>
          </div>
        </header>

        {result.items.length === 0 ? (
          <EmptyState pageScoped={Boolean(cursor || result.nextCursor)} />
        ) : (
          <>
            <div className="practiceAttentionListHeader">
              <p>
                Showing {result.items.length} finding{result.items.length === 1 ? "" : "s"}.
              </p>
              <p className="practiceAttentionScope">
                Based on recent independent scheduled reviews and current preparation state.
              </p>
            </div>
            <section className="practiceAttentionList" aria-label="Needs attention findings">
              {result.items.map((item) => (
                <NeedsAttentionCard item={item} key={`${item.kind}:${item.skillId}`} />
              ))}
            </section>
          </>
        )}

        {cursor || result.nextCursor ? (
          <nav className="practiceAttentionPagination" aria-label="Needs attention pages">
            {cursor ? (
              <Link className="secondaryButton" href={buildAttentionHref({ limit })}>
                First page
              </Link>
            ) : null}
            {result.nextCursor ? (
              <Link
                className="secondaryButton"
                href={buildAttentionHref({ cursor: result.nextCursor, limit })}
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </main>
  );
}

function NeedsAttentionCard({ item }: { item: NeedsAttentionItem }) {
  const titleId = `${item.kind}-${item.skillId}-title`.replace(/[^a-zA-Z0-9_-]/g, "-");

  return (
    <article
      className="practiceAttentionCard"
      data-kind={item.kind}
      data-testid="needs-attention-item"
      aria-labelledby={titleId}
    >
      <div className="practiceAttentionCardHeader">
        <span className="practiceAttentionCardIcon" aria-hidden="true">
          {item.kind === "repeated-misses" ? (
            <WarningCircle size={22} weight="bold" />
          ) : (
            <GearSix size={22} weight="bold" />
          )}
        </span>
        <div>
          <p className="practiceAttentionKind">
            {item.kind === "repeated-misses" ? "Repeated misses" : "Exercise preparation"}
          </p>
          <h2 id={titleId}>
            <Link href={item.links.skill}>{item.skillTitle}</Link>
          </h2>
          <p className="practiceAttentionMeta">
            {item.collectionName ?? "Uncollected"}
            {item.kind === "preparation" && item.dueAt ? ` · Due ${formatDueLabel(item.dueAt)}` : null}
            {item.kind === "repeated-misses" && item.lastReviewedAt
              ? ` · Last review ${formatReviewDate(item.lastReviewedAt)}`
              : null}
          </p>
        </div>
      </div>

      <p className="practiceAttentionReason">{item.reason}</p>

      {item.kind === "repeated-misses" ? <ReviewEvidenceStrip item={item} /> : <PreparationDetail item={item} />}

      <div className="practiceAttentionActions">
        {item.kind === "repeated-misses" ? (
          <Link className="primaryButton" href={item.links.practice}>
            <Flag size={17} weight="bold" aria-hidden="true" />
            Practice this skill
          </Link>
        ) : (
          <Link className="primaryButton" href={item.links.skill}>
            <GearSix size={17} weight="bold" aria-hidden="true" />
            Open retry controls
          </Link>
        )}
        <Link className="textButton" href={item.links.guidance}>
          <BookOpenText size={16} weight="bold" aria-hidden="true" />
          Review guidance
        </Link>
        <Link className="textButton" href={item.links.source}>
          Source
        </Link>
        <Link className="textButton" href={item.links.controls}>
          Skill controls
        </Link>
      </div>
    </article>
  );
}

function ReviewEvidenceStrip({ item }: { item: NeedsAttentionItem }) {
  const reviews = item.repeatedMisses?.reviews ?? item.reviews;

  return (
    <div className="practiceAttentionEvidence" aria-label="Recent independent scheduled reviews">
      <div className="practiceAttentionEvidenceHeader">
        <span>Recent reviews</span>
        <span>{reviews.length} shown</span>
      </div>
      <ol className="practiceAttentionReviewList">
        {reviews.map((review) => {
          const missed = isNeedsAttentionMiss(review);
          return (
            <li data-result={missed ? "missed" : "correct"} key={review.id}>
              {missed ? (
                <WarningCircle size={15} weight="bold" aria-hidden="true" />
              ) : (
                <CheckCircle size={15} weight="bold" aria-hidden="true" />
              )}
              <span>{missed ? "Missed" : "Correct"}</span>
              <time dateTime={review.reviewedAt.toISOString()}>{formatReviewDate(review.reviewedAt)}</time>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PreparationDetail({ item }: { item: NeedsAttentionItem }) {
  const status = item.preparation?.latestJobStatus;
  const statusLabel = status
    ? status.toLowerCase().replaceAll("_", " ")
    : "No preparation run recorded";

  return (
    <div className="practiceAttentionPreparationDetail">
      <span>Latest preparation: {statusLabel}</span>
      <span>Opening the skill shows the existing retry and practice controls.</span>
    </div>
  );
}

function EmptyState({ pageScoped = false }: { pageScoped?: boolean }) {
  return (
    <section className="practiceAttentionEmpty" aria-labelledby="practice-attention-empty-title">
      <CheckCircle size={28} weight="bold" aria-hidden="true" />
      <div>
        <h2 id="practice-attention-empty-title">
          {pageScoped ? "No findings on this page" : "Nothing needs attention right now"}
        </h2>
        <p>
          {pageScoped
            ? "There are no additional findings in this page of the list. Return to the first page to review earlier findings."
            : "We need enough recent, valid scheduled evidence before we show a pattern. Keep practicing when a skill is due, and we will leave your history intact."}
        </p>
        <div className="practiceAttentionEmptyActions">
          <Link className="primaryButton" href="/practice">
            Open practice
          </Link>
          <Link className="secondaryButton" href="/skills">
            Browse skills
          </Link>
        </div>
      </div>
    </section>
  );
}

function parseQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

function parseLimit(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(parseQueryValue(value) ?? "", 10);
  if (!Number.isFinite(parsed)) return NEEDS_ATTENTION_DEFAULT_LIMIT;
  return Math.min(NEEDS_ATTENTION_MAX_LIMIT, Math.max(1, parsed));
}

function buildAttentionHref(input: { cursor?: string; limit: number }): string {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== NEEDS_ATTENTION_DEFAULT_LIMIT) params.set("limit", String(input.limit));
  const query = params.toString();
  return query ? `/practice/attention?${query}` : "/practice/attention";
}
