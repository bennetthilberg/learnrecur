"use client";

import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { updateIntroductionQueueAction } from "./introduction-queue-actions";

type QueueItem = {
  entryId: string;
  skillId: string;
  position: number;
  title: string;
  status: "queued" | "preparing" | "paused" | "archived" | "unavailable";
  reason: string | null;
};

type QueueGroup = {
  collectionId: string | null;
  collectionName: string;
  version: number;
  introducedCount: number;
  items: QueueItem[];
};

export function IntroductionQueuePanel({ groups }: { groups: QueueGroup[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const collectionFilter = searchParams.get("collection");
  const visibleGroups = collectionFilter
    ? groups.filter((group) => collectionFilter === "uncollected"
      ? group.collectionId === null
      : group.collectionId === collectionFilter)
    : groups;

  if (visibleGroups.length === 0) return null;

  function move(group: QueueGroup, index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= group.items.length || pending) return;
    const skillIds = group.items.map((item) => item.skillId);
    [skillIds[index], skillIds[nextIndex]] = [skillIds[nextIndex], skillIds[index]];
    startTransition(async () => {
      const result = await updateIntroductionQueueAction({
        collectionId: group.collectionId,
        expectedVersion: group.version,
        skillIds,
      });
      setNotice(result.message);
      if (result.status === "saved" || result.code === "stale_state") router.refresh();
    });
  }

  return (
    <section className="skillPanel agentSkillQueuePanel" aria-labelledby="introduction-queue-title">
      <div className="skillPanelHeader">
        <div>
          <h2 id="introduction-queue-title">Next new skills</h2>
          <p>Imported skills stay here until practice presents them. Reordering this list does not spend today&apos;s allowance or change review schedules.</p>
        </div>
      </div>
      {notice ? <p className="settingsFinePrint" role="status">{notice}</p> : null}
      <div className="skillLibraryList">
        {visibleGroups.map((group) => (
          <section className="agentAccessSubsection" key={group.collectionId ?? "uncategorized"} aria-labelledby={`introduction-queue-${group.collectionId ?? "uncategorized"}`}>
            <div className="agentAccessSubheading">
              <h3 id={`introduction-queue-${group.collectionId ?? "uncategorized"}`}>{group.collectionName}</h3>
              <span>{group.items.length} queued · {group.introducedCount} introduced</span>
            </div>
            <ol className="introductionQueueList">
              {group.items.map((item, index) => (
                <li className="skillLibraryRow introductionQueueRow" key={item.entryId}>
                  <div className="skillLibraryRowMain">
                    <div>
                      <strong>{index + 1}. {item.title}</strong>
                      {item.reason ? <p>{item.reason}</p> : <p>Ready to be introduced when its place in today&apos;s practice arrives.</p>}
                    </div>
                    <div className="skillLibraryRowControls">
                      <span className="dashboardChip" data-tone={item.status === "queued" ? "ready" : "neutral"}>{formatQueueStatus(item.status)}</span>
                      <div className="introductionQueueControls" aria-label={`Move ${item.title}`}>
                        <button className="secondaryButton" type="button" aria-label={`Move ${item.title} up`} disabled={pending || index === 0} onClick={() => move(group, index, -1)}>
                          <CaretUp size={16} weight="bold" aria-hidden="true" />
                        </button>
                        <button className="secondaryButton" type="button" aria-label={`Move ${item.title} down`} disabled={pending || index === group.items.length - 1} onClick={() => move(group, index, 1)}>
                          <CaretDown size={16} weight="bold" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}

function formatQueueStatus(status: QueueItem["status"]): string {
  return status === "queued"
    ? "Queued"
    : status === "preparing"
      ? "Preparing"
      : status === "paused"
        ? "Paused"
        : status === "archived"
          ? "Archived"
          : "Unavailable";
}
