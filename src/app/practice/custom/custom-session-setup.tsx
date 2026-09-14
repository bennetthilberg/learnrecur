"use client";

import { useFormDraft } from "@/components/app/use-form-draft";
import { FormDraftNotice } from "@/components/app/form-draft-notice";
import { customSetupDraftSchema, matchingCustomSkills, customExerciseCount, type CustomSetupSkill, type CustomSetupDraft } from "@/lib/practice/custom-setup";
import { Select, UnstyledButton } from "@mantine/core";

import { ActionNotification } from "@/components/app/action-notification";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCustomPracticeSessionAction } from "../actions";

type SetupCollection = { id: string; name: string };


export function CustomSessionSetup({
  collections,
  previewAt,
  initialSkillId,
  skills,
  tags,
}: {
  collections: SetupCollection[];
  initialSkillId: string | null;
  skills: CustomSetupSkill[];
  previewAt: number;
  tags: string[];
}) {
  const router = useRouter();
  const draft = useFormDraft(`custom-setup:${initialSkillId ?? "all"}`, {
    mode: "PRACTICE_ONLY" as const, targetCount: "10", collectionId: "", selectedTags: [] as string[],
    selectedSkills: initialSkillId && skills.some((skill) => skill.id === initialSkillId) ? [initialSkillId] : [], recentlyMissed: false,
  } as CustomSetupDraft, customSetupDraftSchema);
  const { mode, targetCount, collectionId, selectedTags, selectedSkills, recentlyMissed } = draft.value;
  const setMode = (mode: CustomSetupDraft["mode"]) => draft.update({ mode });
  const setTargetCount = (targetCount: string) => draft.update({ targetCount });
  const setCollectionId = (collectionId: string) => draft.update({ collectionId });
  const setSelectedTags = (selectedTags: string[]) => draft.update({ selectedTags });
  const setSelectedSkills = (selectedSkills: string[]) => draft.update({ selectedSkills });
  const setRecentlyMissed = (recentlyMissed: boolean) => draft.update({ recentlyMissed });
  const matches = matchingCustomSkills(skills, draft.value, previewAt);
  const eligible = selectedSkills.length ? matches.filter((skill) => selectedSkills.includes(skill.id)) : matches;
  const excludedSelections = selectedSkills.filter((id) => !matches.some((skill) => skill.id === id)).length;
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = (value: string, current: string[], setValue: (next: string[]) => void) => {
    setValue(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const submit = () => {
    setMessage(null);
    const count = customExerciseCount(targetCount);
    if (count === null) { setMessage("Enter a whole number of exercises from 1 to 100."); return; }
    startTransition(async () => {
      try {
      const result = await createCustomPracticeSessionAction({
        mode,
        targetCount: count,
        scope: {
          collectionIds: collectionId ? [collectionId] : [],
          tags: selectedTags,
          skillIds: selectedSkills,
          recentlyMissed,
          mixedReview: true,
        },
      });
      if (result.status === "ready" || result.status === "preparing") {
        draft.discard();
        router.push(`/practice?sessionId=${encodeURIComponent(result.sessionId)}`);
        return;
      }
      setMessage(result.message ?? "The session could not be created.");
      } catch { setMessage("Could not start the session. Your choices are kept; check your connection and try again."); }
    });
  };

  return (
    <section className="skillPanel customPracticeSetup" aria-labelledby="custom-session-form-title">
      <div className="skillPanelHeader">
        <div>
          <h2 id="custom-session-form-title">Session choices</h2>
        </div>
      </div>
      <fieldset className="customPracticeDraftFields" disabled={isPending || !draft.ready}>
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
          <input type="number" min={1} max={100} value={targetCount} onChange={(event) => setTargetCount(event.target.value)} />
          <small>Up to 100. The default is 10.</small>
        </label>

        <fieldset>
          <legend>Scope</legend>
          <label className="customPracticeSelectField">
            <span>Collection</span>
            <Select value={collectionId} onChange={(value) => setCollectionId(value ?? "")}
              data={[{ value: "", label: "All collections" }, ...collections.map((collection) => ({ value: collection.id, label: collection.name }))]} />
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
          <legend>Choose skills <small>Leave unchecked to include every matching skill.</small></legend>
          <p role="status">{eligible.length} eligible {eligible.length === 1 ? "skill" : "skills"}{selectedSkills.length ? ` · ${selectedSkills.length} selected` : ""}</p>
          <p className="customPracticeMatchHelp">Matches the collection and every selected tag. Available exercises are checked when you start.</p>
          {excludedSelections > 0 ? <p>{excludedSelections} selected {excludedSelections === 1 ? "skill does" : "skills do"} not match these filters and will not be included.</p> : null}
          {selectedSkills.length > 0 ? <UnstyledButton className="dashboardPanelLink" onClick={() => setSelectedSkills([])}>Clear skill selection</UnstyledButton> : null}
          {eligible.length === 0 ? <p>No skills match your choices. Change the filters{selectedSkills.length ? " or clear your skill selection" : ""}{mode === "SCHEDULED" ? ", or use Practice only for skills that are not due" : ""}.</p> : null}
          <div className="customPracticeSkillList">
            {matches.map((skill) => (
              <label className="customPracticeCheckLine" key={skill.id}>
                <input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => toggle(skill.id, selectedSkills, setSelectedSkills)} />
                <span>{skill.title}<small>{skill.tags.length > 0 ? skill.tags.join(", ") : "No tags"}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      </fieldset>
      <FormDraftNotice {...draft} disabled={isPending || !draft.ready} onDiscard={() => draft.discard()} restoredMessage="Unfinished session choices restored." />
      <div className="customPracticeSetupActions">
        <Link className="secondaryButton" href="/practice">Cancel</Link>
        <button className="primaryButton" type="button" onClick={submit} disabled={isPending || !draft.ready || eligible.length === 0}>
          {isPending ? "Preparing session" : "Start session"}
        </button>
      </div>
      {message ? <ActionNotification id="custom-session-setup-error" title="Could not start session" message={message} /> : null}
    </section>
  );
}
