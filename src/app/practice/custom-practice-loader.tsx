"use client";

import { useEffect, useRef, useState } from "react";
import { PracticeRouteLoading } from "../skills/primary-route-loading-content";

import { loadCustomPracticeSessionItemAction } from "./actions";
import { customDraftSchema, readRecovery, recoveryKey, type CustomDraft, type Recovery } from "@/lib/practice/recovery";
import { CustomPracticeClient } from "./custom-practice-client";
import type { CustomPracticeClientView } from "./types";

export function CustomPracticeLoader({ sessionId, userId }: { sessionId: string; userId: string }) {
  const [view, setView] = useState<CustomPracticeClientView | null>(null);
  const key = recoveryKey(userId, "custom", sessionId);
  const [recovery, setRecovery] = useState<Recovery<CustomDraft> | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<Promise<CustomPracticeClientView> | null>(null);

  useEffect(() => {
    let mounted = true;
    const saved = readRecovery(key, customDraftSchema);
    if (saved) {
      // Hydrate tab-local recovery after the server's loading shell has mounted.
      void Promise.resolve(saved).then((recovery) => {
        if (!mounted) return;
        setRecovery(recovery);
        setView((recovery.pending ?? recovery.current).view);
      });
      return () => { mounted = false; };
    }
    const load = () => {
      if (document.visibilityState !== "visible") return;
      request.current ??= loadCustomPracticeSessionItemAction({ sessionId });
      const pending = request.current;
      void pending
        .then((result) => {
          if (mounted) setView(result);
        })
        .catch(() => {
          if (request.current === pending) request.current = null;
          if (mounted) setFailed(true);
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [sessionId, key]);

  if (view) return <CustomPracticeClient recoveryKey={key} initialRecovery={recovery} initialView={view} />;

  if (!failed) return <PracticeRouteLoading custom />;

  return (
    <section
      className="practiceFrame practiceEmpty practiceLoadError"
      aria-live="polite"
    >
      <h1>Could not load practice.</h1>
      <p>Your progress is saved. Try loading the session again.</p>
      <button
        className="secondaryButton"
        type="button"
        onClick={() => window.location.reload()}
      >
        Try again
      </button>
    </section>
  );
}
