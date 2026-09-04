import { describe, expect, it, vi } from "vitest";

import {
  constantTimeSecretEqual,
  getReadinessProbeSecret,
  getRequestContext,
  logOperationalEvent,
  redactOperationalValue,
  REDACTED_OPERATIONAL_VALUE,
} from "@/lib/observability";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("operational observability", () => {
  it("emits JSON with the supported operational fields", () => {
    const logger = createLogger();

    logOperationalEvent(
      {
        operation: "provider.exercise-generation",
        status: "failed",
        requestId: "req_123",
        correlationId: "corr_123",
        durationMs: 245,
        provider: "google",
        model: "gemini-3.8-flash",
        retryCount: 1,
        errorCategory: "provider",
        details: { candidateCount: 3 },
      },
      logger,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();

    const event = JSON.parse(logger.error.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "learnrecur.operational",
      operation: "provider.exercise-generation",
      status: "failed",
      requestId: "req_123",
      correlationId: "corr_123",
      durationMs: 245,
      provider: "google",
      model: "gemini-3.8-flash",
      retryCount: 1,
      errorCategory: "provider",
      details: { candidateCount: 3 },
    });
    expect(typeof event.timestamp).toBe("string");
  });

  it("redacts sensitive values recursively without removing safe fields", () => {
    const sourceText = "private lesson text that must not appear in logs";
    const answer = "the learner's private answer";
    const providerPayload = { response: "private provider response" };
    const redacted = redactOperationalValue({
      safe: {
        operation: "skill-generation",
        count: 2,
        message: `Contact learner@example.com at https://example.com/upload?X-Amz-Signature=secret`,
      },
      nested: {
        source: sourceText,
        sourceText,
        rawPrompt: sourceText,
        answers: [answer],
        choices: [answer],
        token: "token-value",
        tokensUsed: "token-count-must-not-be-logged",
        emailAddress: "learner@example.com",
        providerPayload,
        deeper: [{ presignedUrl: "https://s3.example.com/file?signature=secret" }],
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(sourceText);
    expect(serialized).not.toContain(answer);
    expect(serialized).not.toContain("private provider response");
    expect(serialized).not.toContain("learner@example.com");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("signature=secret");
    expect(redacted).toMatchObject({
      safe: {
        operation: "skill-generation",
        count: 2,
        message: expect.stringContaining("[REDACTED_EMAIL]"),
      },
      nested: {
        source: REDACTED_OPERATIONAL_VALUE,
        sourceText: REDACTED_OPERATIONAL_VALUE,
        rawPrompt: REDACTED_OPERATIONAL_VALUE,
        answers: REDACTED_OPERATIONAL_VALUE,
        choices: REDACTED_OPERATIONAL_VALUE,
        token: REDACTED_OPERATIONAL_VALUE,
        tokensUsed: REDACTED_OPERATIONAL_VALUE,
        emailAddress: REDACTED_OPERATIONAL_VALUE,
        providerPayload: REDACTED_OPERATIONAL_VALUE,
        deeper: [{ presignedUrl: REDACTED_OPERATIONAL_VALUE }],
      },
    });
  });

  it("redacts common credential-shaped strings and bounds long values", () => {
    const redacted = redactOperationalValue({
      message: "Bearer very-secret-token sk_live_example-secret",
      longValue: "x".repeat(700),
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("very-secret-token");
    expect(serialized).not.toContain("sk_live_example-secret");
    expect(serialized.length).toBeLessThan(700);
    expect(serialized).toContain("[TRUNCATED]");
  });

  it("compares readiness secrets without accepting empty or mismatched values", () => {
    expect(constantTimeSecretEqual("readiness-secret", "readiness-secret")).toBe(true);
    expect(constantTimeSecretEqual("readiness-secret", "different-secret")).toBe(false);
    expect(constantTimeSecretEqual("readiness-secret", "readiness-secret ")).toBe(false);
    expect(constantTimeSecretEqual("", "")).toBe(false);
    expect(constantTimeSecretEqual(null, "readiness-secret")).toBe(false);
  });

  it("reads and trims only the narrowly scoped readiness secret", () => {
    const readinessSecret = "r".repeat(32);
    expect(
      getReadinessProbeSecret({ READINESS_PROBE_SECRET: ` ${readinessSecret} ` }),
    ).toBe(readinessSecret);
    expect(
      getReadinessProbeSecret({ READINESS_PROBE_SECRET: "too-short" }),
    ).toBeUndefined();
    expect(getReadinessProbeSecret({ READINESS_PROBE_SECRET: " " })).toBeUndefined();
    expect(getReadinessProbeSecret({ CLERK_SECRET_KEY: "not-the-probe-secret" })).toBeUndefined();
  });

  it("uses safe incoming IDs and generates bounded IDs when headers are invalid", () => {
    const context = getRequestContext(
      new Request("http://localhost/api/health", {
        headers: {
          "x-request-id": "req_client_123",
          "x-correlation-id": "corr_client_123",
        },
      }),
    );

    expect(context).toEqual({
      requestId: "req_client_123",
      correlationId: "corr_client_123",
    });

    const generated = getRequestContext(
      new Request("http://localhost/api/health", {
        headers: { "x-request-id": "learner@example.com" },
      }),
    );
    expect(generated.requestId).toMatch(/^req_[a-f0-9]{32}$/);
    expect(generated.correlationId).toBe(generated.requestId);
  });
});
