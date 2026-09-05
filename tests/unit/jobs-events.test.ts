import { describe, expect, it } from "vitest";
import { parseExerciseRefillEventPayload, parseMaterialBatchActivationEventPayload, parseSourceUploadDraftEventPayload } from "@/lib/jobs/events";

describe("AWS job refill event payloads", () => {
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

describe("AWS job source upload event payloads", () => {
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

describe("AWS job material batch activation payloads", () => {
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
