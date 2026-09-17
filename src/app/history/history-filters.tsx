"use client";
import { Checkbox, Select } from "@mantine/core";
import Link from "next/link";
import type { PracticeHistoryMode } from "@/lib/practice/history";

export type HistoryFilterValues = {
  skillId?: string;
  collectionId?: string;
  incorrectOnly?: boolean;
  mode?: PracticeHistoryMode;
};
export function HistoryFilters({ filters, skills, collections }: {
  filters: HistoryFilterValues;
  skills: { id: string; title: string }[];
  collections: { id: string; name: string }[];
}) {
  return <form className="historyFilters" action="/history" method="get">
    <Select name="skillId" label="Skill" searchable defaultValue={filters.skillId ?? ""}
      data={[{ value: "", label: "All skills" }, ...skills.map(skill => ({ value: skill.id, label: skill.title }))]} />
    <Select name="collectionId" label="Collection" searchable defaultValue={filters.collectionId ?? ""}
      data={[{ value: "", label: "All collections" }, ...collections.map(collection => ({ value: collection.id, label: collection.name }))]} />
    <Select name="mode" label="Activity" defaultValue={filters.mode ?? "scheduled"}
      data={[
        { value: "scheduled", label: "Scheduled reviews" },
        { value: "practice-only", label: "Practice-only exposures" },
      ]} />
    <Checkbox name="incorrectOnly" label="Incorrect answers only" defaultChecked={filters.incorrectOnly} />
    <div className="historyFilterActions">
      <Link href="/history" className="secondaryButton">Clear</Link>
      <button type="submit" className="primaryButton">Apply filters</button>
    </div>
  </form>;
}
