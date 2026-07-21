export function summarizeMaterialDraftBatch(
  statuses: readonly (
    | "PLANNED"
    | "GENERATING"
    | "READY"
    | "FAILED"
    | "EXCLUDED"
    | "ACTIVATING"
    | "ACTIVE"
  )[],
) {
  const readyCount = statuses.filter((status) => status === "READY").length;
  const failedCount = statuses.filter((status) => status === "FAILED").length;
  const excludedCount = statuses.filter((status) => status === "EXCLUDED").length;
  const activatedCount = statuses.filter((status) => status === "ACTIVE").length;
  const terminal = statuses.every((status) =>
    ["READY", "FAILED", "EXCLUDED", "ACTIVE"].includes(status),
  );
  const usableCount = readyCount + activatedCount;
  const status = !terminal
    ? statuses.some((item) => item === "ACTIVATING")
      ? "ACTIVATING"
      : "GENERATING"
    : failedCount > 0 && usableCount > 0
      ? "PARTIAL"
      : failedCount > 0
        ? "FAILED"
        : activatedCount > 0 && readyCount === 0
          ? "COMPLETE"
          : "READY";

  return {
    status,
    readyCount,
    failedCount,
    excludedCount,
    activatedCount,
    terminal,
  } as const;
}
