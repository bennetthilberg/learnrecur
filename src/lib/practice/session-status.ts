/** A save error can be a lost connection or an ended login; never guess which. */
export async function practiceSessionEnded(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "signedIn" in body && body.signedIn === false;
  } catch { return false; }
}
