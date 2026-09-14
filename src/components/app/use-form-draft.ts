"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { formDraftKey, readFormDraft, writeFormDraft } from "@/lib/forms/drafts";

// Callers explicitly list draftable fields. Never pass credentials or file bytes.
export function useFormDraft<T extends object>(scope: string, initial: T, schema: z.ZodType<T>) {
  const { userId } = useAuth();
  const key = userId ? formDraftKey(userId, scope) : null;
  const baseline = JSON.stringify(initial);
  const [state, setState] = useState({ key: null as string | null, baseline, cleanValue: baseline, value: initial, restored: false, stored: true });
  const latest = useRef(state);
  const ready = Boolean(key && state.key === key && state.baseline === baseline);

  useEffect(() => {
    let cancelled = false;
    if (!key) return;
    // Keep server and hydration markup equal; inputs stay disabled until restored.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const saved = readFormDraft(key, baseline, schema);
      const next = { key, baseline, cleanValue: baseline, value: saved ?? JSON.parse(baseline) as T, restored: saved !== null, stored: true };
      latest.current = next;
      setState(next);
    });
    return () => { cancelled = true; };
  }, [key, baseline, schema]);

  const dirty = ready && JSON.stringify(state.value) !== state.cleanValue;
  useEffect(() => {
    if (!dirty || state.stored) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      if (!window.confirm("Your changes could not be kept in this tab. Leave and discard them?")) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty, state.stored]);

  const update = useCallback((patch: Partial<T> | ((current: T) => Partial<T>)) => {
    if (!ready || !key) return;
    const value = { ...latest.current.value, ...(typeof patch === "function" ? patch(latest.current.value) : patch) };
    const stored = writeFormDraft(key, baseline, JSON.stringify(value) === latest.current.cleanValue ? null : value);
    const next = { ...latest.current, value, stored };
    latest.current = next;
    setState(next);
  }, [ready, key, baseline]);

  function discard() {
    if (!key) return;
    writeFormDraft(key, baseline, null);
    const next = { ...latest.current, value: JSON.parse(latest.current.cleanValue) as T, restored: false, stored: true };
    latest.current = next;
    setState(next);
  }

  function saved() {
    if (key) writeFormDraft(key, baseline, null);
    const next = { ...latest.current, cleanValue: JSON.stringify(latest.current.value), restored: false };
    latest.current = next;
    setState(next);
  }

  return { value: ready ? state.value : initial, update, discard, saved, ready, dirty, restored: ready && state.restored, stored: state.stored };
}
