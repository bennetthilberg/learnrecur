import { describe, expect, it } from "vitest";

import { shouldDeleteManagedClerkUser } from "../e2e/support/clerk-orphans";
import {
  assertManagedE2EDatabaseName,
  isManagedE2EDatabaseName,
  withDatabase,
} from "../e2e/support/database-schema";

const now = Date.UTC(2026, 8, 1);

describe("authenticated E2E isolation", () => {
  it("accepts only CI-owned database names", () => {
    expect(isManagedE2EDatabaseName("e2e_33532585618_1")).toBe(true);
    expect(isManagedE2EDatabaseName("neondb")).toBe(false);
    expect(() => assertManagedE2EDatabaseName('e2e_1" WITH (FORCE)')).toThrow();
  });

  it("selects an isolated database without discarding connection options", () => {
    const result = new URL(
      withDatabase(
        "postgresql://test:secret@example.test/db?sslmode=require&schema=public",
        "e2e_33532585618_1",
      ),
    );

    expect(result.pathname).toBe("/e2e_33532585618_1");
    expect(result.searchParams.get("sslmode")).toBe("require");
    expect(result.searchParams.has("schema")).toBe(false);
  });

  it("removes prior CI users immediately but protects recent local runs", () => {
    expect(shouldDeleteManagedClerkUser(testUser("ci", now), { ci: true, now })).toBe(true);
    expect(shouldDeleteManagedClerkUser(testUser("local", now), { ci: true, now })).toBe(false);
    expect(
      shouldDeleteManagedClerkUser(testUser("local", now - 25 * 60 * 60 * 1_000), {
        ci: false,
        now,
      }),
    ).toBe(true);
  });

  it("does not delete users unless both the email and private marker agree", () => {
    const user = testUser("ci", now);
    user.privateMetadata.learnrecurE2E = {
      runId: "different-run-id",
      scope: "ci",
      workerIndex: 0,
    };

    expect(shouldDeleteManagedClerkUser(user, { ci: true, now })).toBe(false);
  });
});

function testUser(scope: "ci" | "local", createdAt: number) {
  return {
    createdAt,
    emailAddresses: [
      { emailAddress: "learnrecur-e2e-a1b2c3d4e5f60718-0+clerk_test@example.com" },
    ],
    id: "user_test",
    privateMetadata: {
      learnrecurE2E: {
        runId: "a1b2c3d4e5f60718",
        scope,
        workerIndex: 0,
      },
    },
  };
}
