"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { HistoryReviewsTable, type HistoryReviewRow } from "./history-reviews-table";
import { loadMoreHistoryAction } from "./actions";
import type { HistoryFilterValues } from "./history-filters";
type Cursor = { reviewedAt: string; id: string } | null;
export function HistoryBrowser({ initialReviews, initialCursor, filters }: {
  initialReviews: HistoryReviewRow[]; initialCursor: Cursor; filters: HistoryFilterValues;
}) {
  const [reviews, setReviews] = useState(initialReviews);
  const [cursor, setCursor] = useState(initialCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const filtered = Boolean(filters.skillId || filters.collectionId || filters.incorrectOnly);
  async function loadMore() {
    if (!cursor || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(false);
    try {
      const page = await loadMoreHistoryAction({ ...filters, cursor });
      setReviews(current => { const ids = new Set(current.map(row => row.id)); return [...current, ...page.reviews.filter(row => !ids.has(row.id))]; });
      setCursor(page.nextCursor);
    } catch { setError(true); }
    finally { inFlight.current = false; setPending(false); }
  }
  if (!reviews.length) return <div className="dashboardEmptyState">
    <h3>{filtered ? "No reviews match these filters" : "No completed reviews yet"}</h3>
    <p>{filtered ? "Try another skill or collection, or clear the filters." : "Your completed practice reviews will appear here."}</p>
    <Link className="secondaryButton" href={filtered ? "/history" : "/practice"}>{filtered ? "Clear filters" : "Open practice"}</Link>
  </div>;
  return <>
    <HistoryReviewsTable reviews={reviews} />
    <div className="historyLoadMore">
      <p role="status">Showing {reviews.length} {reviews.length === 1 ? "review" : "reviews"}{cursor ? " · more available" : " · all matching reviews"}.</p>
      {error ? <p role="alert">Couldn’t load older reviews. Your current results are still here. Try again.</p> : null}
      {cursor ? <button className="secondaryButton" disabled={pending} onClick={loadMore}>{pending ? "Loading older reviews…" : error ? "Try again" : "Load more"}</button> : null}
    </div>
  </>;
}
