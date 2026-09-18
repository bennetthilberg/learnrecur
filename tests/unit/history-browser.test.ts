// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HistoryBrowser } from "@/app/history/history-browser";
import type { HistoryReviewRow } from "@/app/history/history-reviews-table";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/app/history/actions", () => ({ loadMoreHistoryAction: load }));
vi.mock("@/app/history/history-reviews-table", () => ({ HistoryReviewsTable: ({ reviews }: { reviews: HistoryReviewRow[] }) => createElement("div", {}, reviews.map(row => createElement("p", { key: row.id }, row.skillTitle))) }));
it("keeps current rows after failure and retries the same filtered cursor without duplicating rows", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const first = { id: "1", skillTitle: "First review" } as HistoryReviewRow;
  const cursor = { mode: "scheduled" as const, id: "1", reviewedAt: "2026-09-14T00:00:00.000Z" };
  load.mockRejectedValueOnce(new Error("offline"));
  try {
    await act(async () => root.render(createElement(HistoryBrowser, { initialReviews: [first], initialCursor: cursor, filters: { incorrectOnly: true, collectionId: "collection" } })));
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("First review");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(load).toHaveBeenLastCalledWith({ incorrectOnly: true, collectionId: "collection", cursor });
    load.mockResolvedValueOnce({ reviews: [first, { id: "2", skillTitle: "Older review" }], nextCursor: null });
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent?.match(/First review/g)).toHaveLength(1);
    expect(host.textContent).toContain("Older review");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Showing 2 reviews");
    expect(host.querySelector("button")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
