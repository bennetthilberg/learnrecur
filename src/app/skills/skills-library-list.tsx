"use client";

import { Select, TextInput, UnstyledButton } from "@mantine/core";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";
import { filterLibraryItems, parseLibraryFilters, type LibraryFilters } from "@/lib/skills/library-filters";

type LibraryItem = { id: string; title: string; status: string; collectionId: string | null; collectionName: string | null; row: ReactNode };

export function SkillsLibraryList({ items }: { items: LibraryItem[] }) {
  const params = useSearchParams();
  const filters = parseLibraryFilters(new URLSearchParams(params.toString()));
  const [pagination, setPagination] = useState({ key: "", count: 50 });
  const key = JSON.stringify(filters);
  const limit = pagination.key === key ? pagination.count : 50;
  const matches = filterLibraryItems(items, filters);
  const collections = [...new Map(items.filter((item) => item.collectionId).map((item) => [item.collectionId!, item.collectionName!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const update = (patch: Partial<LibraryFilters>) => {
    const next = { ...filters, ...patch };
    const url = new URL(window.location.href);
    for (const [name, value] of [["q", next.query], ["collection", next.collection], ["status", next.status === "ACTIVE" ? "" : next.status]]) {
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
    window.history.replaceState(null, "", url);
  };
  const narrowed = Boolean(filters.query || filters.collection);
  return (
    <section className="skillPanel skillLibraryActivePanel" aria-label="Skills library">
      <div className="skillsLibraryFilters">
        <TextInput size="md" label="Search skills" placeholder="Search by title" value={filters.query}
          leftSection={<MagnifyingGlass size={18} aria-hidden="true" />} onChange={(event) => update({ query: event.currentTarget.value })} />
        <Select label="Collection" searchable value={filters.collection} onChange={(value) => update({ collection: value ?? "" })}
          data={[{ value: "", label: "All collections" }, { value: "uncollected", label: "Uncollected" }, ...collections.map(([value, label]) => ({ value, label }))]} />
        <Select label="Status" value={filters.status} onChange={(value) => update({ status: value ?? "ACTIVE" })}
          data={[{ value: "ACTIVE", label: "Active" }, { value: "PAUSED", label: "Paused" }, { value: "ARCHIVED", label: "Archived" }, { value: "ALL", label: "All statuses" }]} />
      </div>
      <div className="skillsLibraryResults">
        <p role="status">{matches.length} {matches.length === 1 ? "skill" : "skills"}{matches.length > limit ? ` · Showing ${limit}` : ""}</p>
        {narrowed ? <UnstyledButton type="button" className="dashboardPanelLink" onClick={() => update({ query: "", collection: "" })}>Clear search and collection</UnstyledButton> : null}
      </div>
      {matches.length ? <div className="skillLibraryList">{matches.slice(0, limit).map((item) => <Fragment key={item.id}>{item.row}</Fragment>)}</div> : (
        <div className="dashboardEmptyState">
          <h3>{narrowed ? "No matching skills" : `No ${filters.status === "ALL" ? "saved" : filters.status.toLowerCase()} skills`}</h3>
          <p>{narrowed ? "Try another title or collection, or change the status filter." : "Choose another status to see your other skills, or add a skill."}</p>
        </div>
      )}
      {matches.length > limit ? <div className="skillsLibraryMore"><button type="button" className="secondaryButton" onClick={() => setPagination({ key, count: limit + 50 })}>Load more skills</button></div> : null}
    </section>
  );
}
