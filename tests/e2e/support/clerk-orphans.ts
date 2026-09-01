const testEmailPattern =
  /^learnrecur-e2e-([a-f0-9]{16})-([0-9]+)\+clerk_test@example\.com$/;
const staleLocalUserAgeMs = 24 * 60 * 60 * 1_000;

export type ManagedClerkUser = {
  createdAt: number;
  emailAddresses: Array<{ emailAddress: string }>;
  id: string;
  privateMetadata: Record<string, unknown>;
};

export function shouldDeleteManagedClerkUser(
  user: ManagedClerkUser,
  options: { ci: boolean; now: number },
) {
  const email = user.emailAddresses
    .map((candidate) => candidate.emailAddress)
    .find((candidate) => testEmailPattern.test(candidate));
  if (!email) {
    return false;
  }

  const emailMatch = testEmailPattern.exec(email);
  const metadata = user.privateMetadata.learnrecurE2E;
  if (!emailMatch || !isRecord(metadata)) {
    return false;
  }

  const runId = metadata.runId;
  const scope = metadata.scope;
  const workerIndex = metadata.workerIndex;
  if (
    runId !== emailMatch[1] ||
    workerIndex !== Number.parseInt(emailMatch[2], 10) ||
    (scope !== "ci" && scope !== "local")
  ) {
    return false;
  }

  if (options.ci && scope === "ci") {
    return true;
  }

  return options.now - user.createdAt >= staleLocalUserAgeMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
