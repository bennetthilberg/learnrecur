"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function useReviewSaveGuard(saving: boolean, unprotectedDraft = false) {
  const router = useRouter();
  const destination = useRef<string | null>(null);
  const saved = useRef(false);
  const [navigationMessage, setNavigationMessage] = useState<string | null>(null);
  const finishSave = useCallback((success: boolean) => {
    saved.current = success;
    if (success) setNavigationMessage(null);
    if (!success && destination.current) {
      setNavigationMessage("Your answer is still here. Retry saving to finish opening the page you chose.");
    }
  }, []);
  useEffect(() => {
    if (!saving && saved.current && destination.current) {
      const href = destination.current; destination.current = null; router.push(href);
    }
  }, [saving, router]);
  useEffect(() => {
    if (!saving && !unprotectedDraft) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      if (!saving) {
        if (window.confirm("This browser could not keep your unfinished answer. Leave and discard it?")) return;
      } else {
        destination.current = link.href;
        setNavigationMessage("Saving your review, then opening the page you chose…");
      }
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [saving, unprotectedDraft]);
  return { finishSave, navigationMessage };
}

/** The server may still finish after a lost response. Retrying uses the same attempt identity. */
export async function confirmReviewSave<T>(request: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Save confirmation timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
