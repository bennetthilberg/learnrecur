import { describe, expect, it } from "vitest";
import { Inngest } from "inngest";

import {
  createLearnRecurInngestClient,
  getInngestClientEnv,
  getInngestEnvStatus,
  getInngestServeOrigin,
  isInngestDevMode,
} from "@/lib/inngest/client";
import {
  parseExerciseRefillEventPayload,
  parseMaterialBatchActivationEventPayload,
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

  it("does not pass production INNGEST_DEV URLs through to the SDK", () => {
    const env = {
      NODE_ENV: "production",
      INNGEST_DEV: "http://localhost:8290",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_EVENT_KEY: "event-key",
      INNGEST_SIGNING_KEY: "signkey-prod-test",
    } as NodeJS.ProcessEnv;
    const client = new Inngest({
      id: "learnrecur",
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
      isDev: isInngestDevMode(env),
    }).setEnvVars(getInngestClientEnv(env)) as unknown as {
      apiBaseUrl: string;
      eventBaseUrl: string;
      mode: string;
    };

    expect(client.mode).toBe("cloud");
    expect(client.apiBaseUrl).toBe("https://api.inngest.com/");
    expect(client.eventBaseUrl).toBe("https://inn.gs/");
  });

  it("keeps production INNGEST_DEV URLs scrubbed after SDK env resets", () => {
    const env = {
      NODE_ENV: "production",
      INNGEST_DEV: "http://localhost:8290",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_EVENT_KEY: "event-key",
      INNGEST_SIGNING_KEY: "signkey-prod-test",
    } as NodeJS.ProcessEnv;
    const client = createLearnRecurInngestClient(env) as unknown as {
      apiBaseUrl: string;
      eventBaseUrl: string;
      setEnvVars: (env: NodeJS.ProcessEnv) => unknown;
    };

    client.setEnvVars(env);

    expect(client.apiBaseUrl).toBe("https://api.inngest.com/");
    expect(client.eventBaseUrl).toBe("https://inn.gs/");
  });

  it("uses the local app origin for dev function registration", () => {
    expect(
      getInngestServeOrigin({
        NODE_ENV: "development",
        INNGEST_DEV: "1",
        INNGEST_SERVE_ORIGIN: "https://alpha.learnrecur.com",
        NEXT_PUBLIC_APP_URL: "http://localhost:3100/skills",
      } as NodeJS.ProcessEnv),
    ).toBe("http://localhost:3100");
  });

  it("falls back to localhost when dev inherits a deployed app URL", () => {
    expect(
      getInngestServeOrigin({
        NODE_ENV: "development",
        INNGEST_DEV: "1",
        INNGEST_SERVE_ORIGIN: "https://alpha.learnrecur.com",
        NEXT_PUBLIC_APP_URL: "https://alpha.learnrecur.com",
      } as NodeJS.ProcessEnv),
    ).toBe("http://localhost:3000");
  });

  it("does not override the serve origin outside dev mode", () => {
    expect(
      getInngestServeOrigin({
        NODE_ENV: "production",
        INNGEST_DEV: "1",
        INNGEST_SERVE_ORIGIN: "https://alpha.learnrecur.com",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
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

describe("Inngest material batch activation payloads", () => {
  it("requires the batch item and its reserved generation job", () => {
    const payload = {
      userId: "user_123",
      batchId: "batch_123",
      itemId: "item_123",
      generationJobId: "job_123",
      requestedAt: "2026-07-09T12:00:00.000Z",
    };

    expect(parseMaterialBatchActivationEventPayload(payload)).toEqual(payload);
    expect(() =>
      parseMaterialBatchActivationEventPayload({ ...payload, generationJobId: "" }),
    ).toThrow();
    expect(() =>
      parseMaterialBatchActivationEventPayload({ ...payload, extra: true }),
    ).toThrow();
  });
});
