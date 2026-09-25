import { describe, expect, it } from "vitest";
import { resolveWorkerReservation } from "../../scripts/aws-jobs-reservation";

describe("worker reservation migration", () => {
  it("preserves a live reservation when the old stack has no parameter", () => {
    expect(resolveWorkerReservation(undefined, [], 5)).toBe("enabled");
  });

  it("preserves a live reservation even when the stack parameter drifted", () => {
    expect(resolveWorkerReservation(undefined, [{ ParameterKey: "ReserveWorkerConcurrency", ParameterValue: "false" }], 5)).toBe("enabled");
  });

  it("reuses a current stack parameter when there is no live reservation", () => {
    expect(resolveWorkerReservation(undefined, [{ ParameterKey: "ReserveWorkerConcurrency", ParameterValue: "true" }], undefined)).toBeUndefined();
    expect(resolveWorkerReservation(undefined, [{ ParameterKey: "ReserveWorkerConcurrency", ParameterValue: "false" }], undefined)).toBeUndefined();
  });

  it("keeps new and unreserved old stacks on the template default", () => {
    expect(resolveWorkerReservation(undefined, undefined, undefined)).toBeUndefined();
    expect(resolveWorkerReservation(undefined, [], undefined)).toBeUndefined();
  });

  it("honors an explicit choice, including disabling a live reservation", () => {
    expect(resolveWorkerReservation("disabled", [], 5)).toBe("disabled");
    expect(resolveWorkerReservation("enabled", [], undefined)).toBe("enabled");
  });

  it("does not silently restart a function reserved at zero", () => {
    expect(() => resolveWorkerReservation(undefined, [], 0)).toThrow("reserved concurrency is zero");
  });
});
