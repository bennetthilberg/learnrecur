"use client";

import { useEffect, useRef, useState } from "react";
import { PracticeRouteLoading } from "../skills/primary-route-loading-content";
import { loadPracticeItemAction } from "./actions";
import { PracticeClient } from "./practice-client";
import type { PracticeItem } from "./types";

export function PracticeLoader({
  collectionId,
  initialMixedReview,
  canUseSampleData,
}: {
  collectionId: string | null;
  initialMixedReview: boolean;
  canUseSampleData: boolean;
}) {
  const [item, setItem] = useState<PracticeItem | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<Promise<PracticeItem> | null>(null);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      request.current ??= loadPracticeItemAction({
        collectionId,
        mixedReview: initialMixedReview,
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
  }, [collectionId, initialMixedReview]);
  if (item)
    return (
      <PracticeClient
        initialItem={item}
        initialMixedReview={initialMixedReview}
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
