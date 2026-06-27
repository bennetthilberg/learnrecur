"use client";

import { useState, type ReactNode } from "react";

const skillDetailDesignOptions = [
  {
    id: "overview",
    label: "Overview",
    note: "Simple vertical scan",
  },
  {
    id: "split",
    label: "Split",
    note: "Status beside guidance",
  },
  {
    id: "practice",
    label: "Practice",
    note: "Start and schedule first",
  },
  {
    id: "notebook",
    label: "Notebook",
    note: "Definition before ops",
  },
  {
    id: "operations",
    label: "Ops",
    note: "Prep and controls first",
  },
  {
    id: "timeline",
    label: "Timeline",
    note: "History-forward view",
  },
] as const;

type SkillDetailDesignId = (typeof skillDetailDesignOptions)[number]["id"];

export function SkillDetailDesignSwitcher({ children }: { children: ReactNode }) {
  const [designId, setDesignId] = useState<SkillDetailDesignId>("overview");

  return (
    <div className="skillDetailExperiment" data-design={designId}>
      <section className="skillDetailSwitchPanel" aria-label="Skill detail design options">
        <div>
          <h2>Skill page designs</h2>
          <p>Switch between six calmer ways to view the same skill.</p>
        </div>
        <div className="skillDetailVariantControls" role="tablist" aria-label="Design options">
          {skillDetailDesignOptions.map((option) => (
            <button
              aria-selected={designId === option.id}
              className="skillDetailVariantButton"
              key={option.id}
              onClick={() => setDesignId(option.id)}
              role="tab"
              type="button"
            >
              <span>{option.label}</span>
              <small>{option.note}</small>
            </button>
          ))}
        </div>
      </section>
      <div className="skillDetailCanvas">{children}</div>
    </div>
  );
}
