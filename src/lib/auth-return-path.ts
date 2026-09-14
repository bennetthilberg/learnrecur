/** Only relative product routes may become post-sign-in destinations. */
export function authReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/dashboard";
  const url = new URL(value, "https://learnrecur.invalid");
  if (!/^\/(dashboard|practice|history|skills|collections|settings)(\/|$)/.test(url.pathname) && url.pathname !== "/oauth/workos/complete") return "/dashboard";
  return url.pathname + url.search + url.hash;
}
