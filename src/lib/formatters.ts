export function formatJobStatus(status: string) {
  return status.toLowerCase().replaceAll("_", " ");
}

export function formatDisplayLabel(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function formatFsrsState(state: string) {
  return formatDisplayLabel(state);
}
