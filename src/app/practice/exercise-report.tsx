"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Flag } from "@phosphor-icons/react";
import { ExerciseFlagReason } from "@/generated/prisma/enums";
import { FLAG_REASON_OPTIONS } from "@/lib/practice/flag-reasons";

export function ExerciseReport({ disabled, onReport }: { disabled: boolean; onReport: (reasons: ExerciseFlagReason[], note: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<ExerciseFlagReason[]>([]);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const id = useId();
  const other = reasons.includes(ExerciseFlagReason.OTHER);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  const close = () => { setOpen(false); toggle.current?.focus(); };
  async function submit() {
    if (disabled || pending || !reasons.length || (other && !note.trim())) return;
    setPending(true); setError(null);
    try { setError(await onReport(reasons, note)); }
    catch { setError("Could not send the report. Your choices are still here. Try again."); }
    finally { setPending(false); }
  }
  return <>
    <div className="flagExerciseInline">
      <button ref={toggle} className="quietButton" disabled={disabled || pending} type="button" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : setOpen(true)}>
        <Flag size={15} aria-hidden="true" />{open ? "Close report" : "Report issue"}
      </button>
    </div>
    {open ? <section id={id} className="flagExercisePanel" aria-label="Report an issue">
      <div className="flagExerciseHeader"><div><h2>Report an issue</h2><p>This removes the exercise from practice. Reporting does not record an answer or change your review schedule.</p></div></div>
      <div className="flagExerciseForm">
        <fieldset><legend>Issue type</legend><div className="flagReasonGrid">
          {FLAG_REASON_OPTIONS.map((option, index) => <label className="flagReasonOption" key={option.reason}>
            <input ref={index === 0 ? first : undefined} type="checkbox" disabled={disabled || pending} checked={reasons.includes(option.reason)} onChange={() => setReasons(current => current.includes(option.reason) ? current.filter(reason => reason !== option.reason) : [...current, option.reason])} />
            <span>{option.label}</span>
          </label>)}
        </div></fieldset>
        {other ? <label className="flagNoteField"><span>Note</span><textarea rows={3} maxLength={500} value={note} disabled={disabled || pending} onChange={event => setNote(event.target.value)} /></label> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="flagActions"><button className="secondaryButton" type="button" onClick={submit} disabled={disabled || pending || !reasons.length || (other && !note.trim())}>{pending ? "Reporting" : "Submit report"}</button></div>
      </div>
    </section> : null}
  </>;
}
