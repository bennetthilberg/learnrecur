"use client";

import { useEffect, useRef, useState } from "react";
import { PracticeRouteLoading } from "../skills/primary-route-loading-content";

import { loadCustomPracticeSessionItemAction } from "./actions";
import { CustomPracticeClient } from "./custom-practice-client";
import type { CustomPracticeClientView } from "./types";

export function CustomPracticeLoader({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<CustomPracticeClientView | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<Promise<CustomPracticeClientView> | null>(null);

  useEffect(() => {
    let mounted = true;
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
  }, [sessionId]);

  if (view) return <CustomPracticeClient initialView={view} />;

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
