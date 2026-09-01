export function parseE2EUserCount(value: string | undefined) {
  const candidate = value ?? "2";
  if (!/^[2-6]$/.test(candidate)) {
    throw new Error("E2E_CLERK_USER_COUNT must be an integer between 2 and 6.");
  }
  return Number(candidate);
}
