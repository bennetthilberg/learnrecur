type StackParameter = { ParameterKey: string; ParameterValue?: string };
type ReservationOption = "enabled" | "disabled";

export function resolveWorkerReservation(
  explicit: ReservationOption | undefined,
  stackParameters: StackParameter[] | undefined,
  liveReservedConcurrency: number | undefined,
): ReservationOption | undefined {
  if (explicit) return explicit;
  if (liveReservedConcurrency === 0) {
    throw new Error("Worker reserved concurrency is zero; choose --reserve-concurrency explicitly before deploying");
  }
  if (liveReservedConcurrency !== undefined) return "enabled";
  const existing = stackParameters?.find((parameter) => parameter.ParameterKey === "ReserveWorkerConcurrency");
  if (existing && !["true", "false"].includes(existing.ParameterValue ?? "")) {
    throw new Error("Existing worker reservation parameter is invalid");
  }
  return undefined;
}
