import { expect, it } from "vitest";
import { authReturnPath } from "@/lib/auth-return-path";

it.each(["/practice", "/practice?sessionId=session-1", "/skills/new/one", "/settings#email-reminders", "/oauth/workos/complete"])("preserves an allowed return path %s", path => {
  expect(authReturnPath(path)).toBe(path);
});
it.each([undefined, "https://evil.example/practice", "//evil.example", "/\\evil.example", "/sign-in", "/api/auth/status", "/practice/../../api/secrets", "/practice\n", "javascript:alert(1)"])("rejects an unsafe or unsupported return path %s", path => {
  expect(authReturnPath(path)).toBe("/dashboard");
});

it("rejects duplicate or non-string redirect parameters", () => {
  expect(authReturnPath(["/practice", "/settings"])).toBe("/dashboard");
  expect(authReturnPath({ pathname: "/practice" })).toBe("/dashboard");
});
