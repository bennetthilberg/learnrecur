"use client";

import { useEffect, useRef, useState } from "react";
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
  return (
    <section className="practiceFrame practiceEmpty" aria-live="polite">
      <h1>{failed ? "Could not load practice." : "Loading practice…"}</h1>
      {failed ? (
        <button
          className="secondaryButton"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      ) : (
        <p>Your next exercise will appear here.</p>
      )}
    </section>
  );
}
