export function formatJobStatus(status: string) {
  return status.toLowerCase().replaceAll("_", " ");
}
