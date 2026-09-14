"use client";
import { writeRecovery } from "@/lib/practice/recovery";
export function RecoveryNotice({ storageKey, saving }: { storageKey?: string; saving: boolean }) {
  if (!storageKey) return null;
  return <div className="practiceRecoveryNotice" role="status">
    <p>Your unfinished answer is here.</p>
    <button type="button" className="quietButton" disabled={saving} onClick={() => {
      writeRecovery(storageKey, null); window.location.reload();
    }}>Leave this answer and reload</button>
  </div>;
}
