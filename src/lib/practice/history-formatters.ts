export function formatReviewDate(date: Date) {
  return date.toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

export function formatDueLabel(date: Date | null) {
  if (!date) {
    return "Not scheduled";
  }

  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
}

export function formatResponseTime(responseMs: number | null) {
  if (responseMs === null) {
    return "No response time";
  }

  return `${(responseMs / 1000).toFixed(1)}s response`;
}

export function formatReviewResult(result: string) {
  return result === "CORRECT" ? "Correct" : "Incorrect";
}

export function formatNullableHistoryEnum(value: string | null) {
  return value ? formatHistoryEnum(value) : "unknown";
}

export function formatHistoryEnum(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}
