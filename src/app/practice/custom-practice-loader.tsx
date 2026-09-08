"use client";

import { useEffect, useRef, useState } from "react";

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

  return (
    <section className="practiceFrame practiceEmpty" aria-live="polite">
      <h1>{failed ? "Could not load this practice session." : "Loading practice session…"}</h1>
      {failed ? (
        <button className="secondaryButton" type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      ) : (
        <p>Checking the selected exercise inventory.</p>
      )}
    </section>
  );
}
