import { describe, expect, it } from "vitest";

import { checkOpsAccessForEmail } from "@/lib/ops";

describe("ops access", () => {
  it("denies access when no founder emails are configured", () => {
    expect(checkOpsAccessForEmail("founder@example.com", { OPS_ALLOWED_EMAILS: "" })).toEqual({
      allowed: false,
      message: "Operations access is not configured. Set OPS_ALLOWED_EMAILS before using /ops.",
    });
  });

  it("allows only configured founder emails case-insensitively", () => {
    expect(
      checkOpsAccessForEmail("Founder@Example.com", {
        OPS_ALLOWED_EMAILS: "founder@example.com,ops@example.com",
      }),
    ).toEqual({
      allowed: true,
    });

    expect(
      checkOpsAccessForEmail("learner@example.com", {
        OPS_ALLOWED_EMAILS: "founder@example.com,ops@example.com",
      }),
    ).toMatchObject({
      allowed: false,
    });
  });
});
