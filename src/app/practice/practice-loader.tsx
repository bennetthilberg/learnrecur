"use client";

import { useEffect, useRef, useState } from "react";
import { PracticeRouteLoading } from "../skills/primary-route-loading-content";
import { loadPracticeItemAction } from "./actions";
import { normalDraftSchema, readRecovery, recoveryKey, type NormalDraft, type Recovery } from "@/lib/practice/recovery";
import { PracticeClient } from "./practice-client";
import type { PracticeItem } from "./types";

export function PracticeLoader({
  userId,
  collectionId,
  canUseSampleData,
}: {
  userId: string;
  collectionId: string | null;
  canUseSampleData: boolean;
}) {
  const [item, setItem] = useState<PracticeItem | null>(null);
  const key = recoveryKey(userId, "normal", collectionId ?? "all");
  const [recovery, setRecovery] = useState<Recovery<NormalDraft> | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<Promise<PracticeItem> | null>(null);
  useEffect(() => {
    let mounted = true;
    const saved = readRecovery(key, normalDraftSchema);
    if (saved) {
      // Hydrate tab-local recovery after the server's loading shell has mounted.
      void Promise.resolve(saved).then((recovery) => {
        if (!mounted) return;
        setRecovery(recovery);
        setItem((recovery.pending ?? recovery.current).item);
      });
      return () => { mounted = false; };
    }
    const load = () => {
      if (document.visibilityState !== "visible") return;
      request.current ??= loadPracticeItemAction({
        collectionId,
        mixedReview: true,
      });
      const pending = request.current;
      void pending
        .then((result) => {
          if (mounted) setItem(result);
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
  }, [collectionId, key]);
  if (item)
    return (
      <PracticeClient
        recoveryKey={key}
        initialRecovery={recovery}
        initialItem={item}
        canUseSampleData={canUseSampleData}
      />
    );
  if (!failed) return <PracticeRouteLoading />;

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
