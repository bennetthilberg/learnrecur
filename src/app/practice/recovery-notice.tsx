"use client";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { writeRecovery } from "@/lib/practice/recovery";
export function RecoveryNotice({ storageKey, saving, needsSignIn = false }: { storageKey?: string; saving: boolean; needsSignIn?: boolean }) {
  const signIn = useRef<HTMLAnchorElement>(null);
  useEffect(() => { if (needsSignIn && !saving) signIn.current?.focus(); }, [needsSignIn, saving]);
  const pathname = usePathname();
  const search = useSearchParams();
  const returnPath = pathname + (search.size ? `?${search}` : "");
  if (!storageKey) return null;
  return <div className="practiceRecoveryNotice" role="status">
    <p>{needsSignIn ? "Your sign-in session ended. Sign in again to save this answer. Your answer is kept in this tab." : "Your unfinished answer is here."}</p>
    <button type="button" className="quietButton" disabled={saving} onClick={() => {
      writeRecovery(storageKey, null); window.location.reload();
    }}>Leave this answer and reload</button>
    {needsSignIn ? <a ref={signIn} className="primaryButton" href={`/sign-in?redirect_url=${encodeURIComponent(returnPath)}`}>Sign in to continue</a> : null}
  </div>;
}
