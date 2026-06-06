import { describe, expect, it } from "vitest";

import { getInngestEnvStatus, isInngestDevMode } from "@/lib/inngest/client";
import { parseExerciseRefillEventPayload } from "@/lib/inngest/events";

describe("Inngest configuration", () => {
  it("allows local development without cloud keys", () => {
    const env = {
      NODE_ENV: "development",
      INNGEST_APP_ID: "learnrecur-dev",
    } as NodeJS.ProcessEnv;

    expect(isInngestDevMode(env)).toBe(true);
    expect(getInngestEnvStatus(env)).toEqual({
      status: "ready",
      appId: "learnrecur-dev",
      isDev: true,
    });
  });

  it("requires event and signing keys outside dev mode", () => {
    const env = {
      NODE_ENV: "production",
      INNGEST_APP_ID: "learnrecur",
    } as NodeJS.ProcessEnv;

    expect(getInngestEnvStatus(env)).toEqual({
      status: "missing-env",
      message: "Missing Inngest environment configuration: INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY.",
    });
  });

  it("parses INNGEST_DEV as an explicit boolean instead of any non-empty string", () => {
    expect(
      isInngestDevMode({
        NODE_ENV: "production",
        INNGEST_DEV: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isInngestDevMode({
        NODE_ENV: "production",
        INNGEST_DEV: " yes ",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isInngestDevMode({
        NODE_ENV: "production",
        INNGEST_DEV: "http://localhost:8290",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("Inngest refill event payloads", () => {
  it("accepts a valid refill payload", () => {
    expect(
      parseExerciseRefillEventPayload({
        userId: "user_123",
        skillId: "skill_123",
        generationJobId: "job_123",
        targetReadyCount: 5,
        requestedAt: "2026-06-05T12:00:00.000Z",
      }),
    ).toEqual({
      userId: "user_123",
      skillId: "skill_123",
      generationJobId: "job_123",
      targetReadyCount: 5,
      requestedAt: "2026-06-05T12:00:00.000Z",
    });
  });

  it("rejects malformed payloads", () => {
    expect(() =>
      parseExerciseRefillEventPayload({
        userId: "user_123",
        skillId: "skill_123",
        generationJobId: "",
        targetReadyCount: 0,
        requestedAt: "2026-06-05T12:00:00.000Z",
        extra: true,
      }),
    ).toThrow();
  });
});
