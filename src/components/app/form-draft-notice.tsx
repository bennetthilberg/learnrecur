"use client";

export function FormDraftNotice({ restored, stored, dirty, disabled, onDiscard }: {
  restored: boolean; stored: boolean; dirty: boolean; disabled: boolean; onDiscard: () => void;
}) {
  if (!dirty) return null;
  return <div className="formDraftNotice">
    <p role="status">{!stored ? "Changes could not be kept in this tab. Save before leaving." : restored ? "Unfinished changes restored. Save to apply them." : "Unsaved changes kept in this tab."}</p>
    <button className="secondaryButton" type="button" disabled={disabled} onClick={onDiscard}>Discard changes</button>
  </div>;
}
