import { describe, expect, it } from "vitest";

import { getInngestEnvStatus, isInngestDevMode } from "@/lib/inngest/client";
import {
  parseExerciseRefillEventPayload,
  parseSourceUploadDraftEventPayload,
} from "@/lib/inngest/events";

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

  it("ignores INNGEST_DEV in production", () => {
    expect(
      isInngestDevMode({
        NODE_ENV: "production",
        INNGEST_DEV: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isInngestDevMode({
        NODE_ENV: "production",
        INNGEST_DEV: "http://localhost:8290",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      getInngestEnvStatus({
        NODE_ENV: "production",
        INNGEST_DEV: "1",
        INNGEST_APP_ID: "learnrecur",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      status: "missing-env",
      message: "Missing Inngest environment configuration: INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY.",
    });
  });

  it("parses INNGEST_DEV as an explicit boolean outside production", () => {
    expect(
      isInngestDevMode({
        NODE_ENV: "development",
        INNGEST_DEV: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isInngestDevMode({
        NODE_ENV: "development",
        INNGEST_DEV: " yes ",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isInngestDevMode({
        NODE_ENV: "development",
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

describe("Inngest source upload event payloads", () => {
  it("accepts a valid source upload draft payload", () => {
    expect(
      parseSourceUploadDraftEventPayload({
        userId: "user_123",
        sourceFileId: "source_123",
        requestedAt: "2026-06-05T12:00:00.000Z",
      }),
    ).toEqual({
      userId: "user_123",
      sourceFileId: "source_123",
      requestedAt: "2026-06-05T12:00:00.000Z",
    });
  });

  it("rejects malformed source upload draft payloads", () => {
    expect(() =>
      parseSourceUploadDraftEventPayload({
        userId: "user_123",
        sourceFileId: "",
        requestedAt: "2026-06-05T12:00:00.000Z",
        extra: true,
      }),
    ).toThrow();
  });
});
