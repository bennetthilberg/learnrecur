import { expect, it } from "vitest";
import { getLocalWorkerFailureCode } from "@/lib/jobs/diagnostics";

it.each(["AccessDeniedException", "CredentialsProviderError", "ExpiredToken"])("exposes the safe AWS diagnostic %s without its message", (name) => {
  expect(getLocalWorkerFailureCode(Object.assign(new Error("private credential and request data"), { name }))).toBe(name);
});

it("exposes known job configuration codes", () => {
  expect(getLocalWorkerFailureCode(new Error("JOB_QUEUE_ENVIRONMENT_MISMATCH"))).toBe("JOB_QUEUE_ENVIRONMENT_MISMATCH");
});

it("does not serialize arbitrary errors or private validation inputs", () => {
  expect(getLocalWorkerFailureCode(new Error("postgres://private-database-password"))).toBe("JOB_LOCAL_FAILED");
  expect(getLocalWorkerFailureCode({ name: "private study material", message: "private answer" })).toBe("JOB_LOCAL_FAILED");
  expect(getLocalWorkerFailureCode(Object.assign(new Error("private input"), { name: "ZodError" }))).toBe("JOB_CONFIGURATION_INVALID");
});
