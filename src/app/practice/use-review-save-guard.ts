"use client";
import { useEffect } from "react";

export function useReviewSaveGuard(saving: boolean) {
  useEffect(() => {
    if (!saving) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // Keep app links from unmounting a review before its save is acknowledged.
    const navigate = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [saving]);
}
