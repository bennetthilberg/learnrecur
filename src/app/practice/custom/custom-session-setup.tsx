"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCustomPracticeSessionAction } from "../actions";

type SetupCollection = { id: string; name: string };
type SetupSkill = { id: string; title: string; collectionId: string | null; tags: string[] };

export function CustomSessionSetup({
  collections,
  initialMixedReview,
  initialSkillId,
  skills,
  tags,
}: {
  collections: SetupCollection[];
  initialMixedReview: boolean;
  initialSkillId: string | null;
  skills: SetupSkill[];
  tags: string[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"PRACTICE_ONLY" | "SCHEDULED">("PRACTICE_ONLY");
  const [targetCount, setTargetCount] = useState(10);
  const [collectionId, setCollectionId] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(() =>
    initialSkillId && skills.some((skill) => skill.id === initialSkillId) ? [initialSkillId] : [],
  );
  const [recentlyMissed, setRecentlyMissed] = useState(false);
  const [mixedReview, setMixedReview] = useState(initialMixedReview);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = (value: string, current: string[], setValue: (next: string[]) => void) => {
    setValue(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const submit = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await createCustomPracticeSessionAction({
        mode,
        targetCount,
        scope: {
          collectionIds: collectionId ? [collectionId] : [],
          tags: selectedTags,
          skillIds: selectedSkills,
          recentlyMissed,
          mixedReview,
        },
      });
      if (result.status === "ready" || result.status === "preparing") {
        router.push(`/practice?sessionId=${encodeURIComponent(result.sessionId)}`);
        return;
      }
      setMessage(result.message ?? "The session could not be created.");
    });
  };

  return (
    <section className="skillPanel customPracticeSetup" aria-labelledby="custom-session-form-title">
      <div className="skillPanelHeader">
        <div>
          <h2 id="custom-session-form-title">Session choices</h2>
          <p>Selections are saved with this session so reloads keep the same scope.</p>
        </div>
      </div>
      <div className="customPracticeSetupGrid">
        <fieldset>
          <legend>Mode</legend>
          <label className="customPracticeRadio">
            <input type="radio" name="custom-mode" checked={mode === "PRACTICE_ONLY"} onChange={() => setMode("PRACTICE_ONLY")} />
            <span><strong>Practice only</strong><small>Try active skills, including work that is not due. No schedule or review evidence changes.</small></span>
          </label>
          <label className="customPracticeRadio">
            <input type="radio" name="custom-mode" checked={mode === "SCHEDULED"} onChange={() => setMode("SCHEDULED")} />
            <span><strong>Scheduled review</strong><small>Use only due skills and record a normal review when you continue.</small></span>
          </label>
        </fieldset>

        <label className="customPracticeCountField">
          <span>Exercises</span>
          <input type="number" min={1} max={100} value={targetCount} onChange={(event) => setTargetCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} />
          <small>Up to 100. The default is 10.</small>
        </label>

        <fieldset>
          <legend>Scope</legend>
          <label className="customPracticeSelectField">
            <span>Collection</span>
            <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
              <option value="">All collections</option>
              {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
            </select>
          </label>
          <label className="customPracticeCheckLine">
            <input type="checkbox" checked={recentlyMissed} onChange={(event) => setRecentlyMissed(event.target.checked)} />
            <span>Recently missed <small>Incorrect in the last 30 days</small></span>
          </label>
          {tags.length > 0 ? (
            <div className="customPracticeFilterGroup">
              <span className="customPracticeLegend">Tags</span>
              <div className="customPracticeFilterList">
                {tags.map((tag) => (
                  <label className="customPracticeCheckLine" key={tag}>
                    <input type="checkbox" checked={selectedTags.includes(tag)} onChange={() => toggle(tag, selectedTags, setSelectedTags)} />
                    <span>{tag}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="customPracticeSkillFieldset">
          <legend>Selected skills <small>Leave empty to use the other filters.</small></legend>
          <div className="customPracticeSkillList">
            {skills.length === 0 ? <p>No active skills are available yet.</p> : skills.map((skill) => (
              <label className="customPracticeCheckLine" key={skill.id}>
                <input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => toggle(skill.id, selectedSkills, setSelectedSkills)} />
                <span>{skill.title}<small>{skill.tags.length > 0 ? skill.tags.join(", ") : "No tags"}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Review behavior</legend>
          <label className="customPracticeCheckLine">
            <input type="checkbox" checked={mixedReview} onChange={(event) => setMixedReview(event.target.checked)} />
            <span>Mixed review<small>Use the account&apos;s current mixed review preference by default.</small></span>
          </label>
        </fieldset>
      </div>
      <div className="customPracticeSetupActions">
        <button className="primaryButton" type="button" onClick={submit} disabled={isPending || skills.length === 0}>
          {isPending ? "Preparing session" : "Start session"}
        </button>
        <Link className="secondaryButton" href="/practice">Cancel</Link>
      </div>
      {message ? <p className="skillFormMessage" data-tone="error" role="alert">{message}</p> : null}
    </section>
  );
}
