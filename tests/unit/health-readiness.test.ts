import { describe, expect, it, vi } from "vitest";

import { GET as healthGET } from "@/app/api/health/route";
import {
  handleHealthRequest,
  handleReadinessRequest,
  checkStorageReadiness,
  runReadinessChecks,
  verifyStorageBucketReadiness,
} from "@/lib/observability/readiness";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("health route", () => {
  it("returns a minimal public liveness response without dependency details", async () => {
    const response = await healthGET(
      new Request("http://localhost/api/health", {
        headers: {
          "x-request-id": "req_health_test",
          "x-correlation-id": "corr_health_test",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("x-request-id")).toBe("req_health_test");
    expect(response.headers.get("x-correlation-id")).toBe("corr_health_test");
  });

  it("returns a bounded failure signal when the liveness handler itself fails", async () => {
    const logger = createLogger();
    const response = await handleHealthRequest(
      new Request("http://localhost/api/health"),
      {
        logger,
        probe: async () => {
          throw new Error("private source text should never be returned");
        },
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unhealthy" });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private source text");
  });
});

describe("readiness route", () => {
  it("fails closed when storage configuration is missing", async () => {
    await expect(
      checkStorageReadiness({ status: "missing-env", message: "private configuration detail" }),
    ).rejects.toMatchObject({ category: "configuration" });
  });

  it("accepts an accessible empty readiness prefix", async () => {
    const listObjects = vi.fn().mockResolvedValue([]);
    await expect(
      checkStorageReadiness({ status: "ready", storage: { listObjects } as never }),
    ).resolves.toBeUndefined();
    expect(listObjects).toHaveBeenCalledWith({ prefix: "__learnrecur_readiness_probe__/" });
  });

  it("verifies the bucket itself instead of accepting an ambiguous object 404", async () => {
    const listObjects = vi.fn().mockRejectedValue(
      Object.assign(new Error("missing bucket"), { name: "NoSuchBucket", statusCode: 404 }),
    );

    await expect(verifyStorageBucketReadiness({ listObjects })).rejects.toMatchObject({
      name: "NoSuchBucket",
    });
    expect(listObjects).toHaveBeenCalledWith({ prefix: "__learnrecur_readiness_probe__/" });
  });

  it("requires the operator secret before running any readiness check", async () => {
    const check = vi.fn();
    const response = await handleReadinessRequest(
      new Request("http://localhost/api/readiness"),
      {
        secret: "readiness-secret",
        checks: [{ name: "database", run: check }],
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ status: "unauthorized" });
    expect(check).not.toHaveBeenCalled();
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("signals missing probe configuration without exposing dependency state", async () => {
    const check = vi.fn();
    const response = await handleReadinessRequest(
      new Request("http://localhost/api/readiness"),
      {
        secret: "",
        checks: [{ name: "database", run: check }],
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      categories: ["configuration"],
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("returns ready only when all authenticated checks pass", async () => {
    const logger = createLogger();
    const database = vi.fn();
    const storage = vi.fn(async () => undefined);
    const response = await handleReadinessRequest(
      new Request("http://localhost/api/readiness", {
        headers: { authorization: "Bearer readiness-secret" },
      }),
      {
        logger,
        secret: "readiness-secret",
        checks: [
          { name: "database", category: "database", run: database },
          { name: "storage", category: "storage", run: storage },
        ],
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: [
        { name: "database", status: "ok" },
        { name: "storage", status: "ok" },
      ],
    });
    expect(database).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded category when one authenticated dependency fails", async () => {
    const logger = createLogger();
    const response = await handleReadinessRequest(
      new Request("http://localhost/api/readiness", {
        headers: { authorization: "Bearer readiness-secret" },
      }),
      {
        secret: "readiness-secret",
        logger,
        checks: [
          {
            name: "database",
            category: "database",
            run: async () => {
              throw new Error("database password and private answer must not leak");
            },
          },
          { name: "storage", category: "storage", run: () => undefined },
        ],
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: [
        { name: "database", status: "failed", category: "database" },
        { name: "storage", status: "ok" },
      ],
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("database password");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private answer");
  });

  it("turns a hung check into a timeout category", async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await runReadinessChecks(
      [{
        name: "provider",
        category: "provider",
        run: (signal) => {
          receivedSignal = signal;
          return new Promise<void>(() => {});
        },
      }],
      5,
    );

    expect(result).toEqual({
      status: "not_ready",
      checks: [{ name: "provider", status: "failed", category: "timeout" }],
    });
    expect(receivedSignal?.aborted).toBe(true);
  });
});
