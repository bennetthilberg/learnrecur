import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";

const { transaction } = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: transaction }),
}));

import {
  isAgentSerializationConflict,
  runAgentSerializable,
} from "@/lib/agent-access/transactions";

function knownRequest(
  code: string,
  meta?: Record<string, unknown>,
) {
  return new Prisma.PrismaClientKnownRequestError("database error", {
    code,
    clientVersion: "test",
    meta,
  });
}

describe("agent transaction conflict handling", () => {
  beforeEach(() => {
    transaction.mockReset();
  });

  it.each([
    [knownRequest("P2034"), true],
    [knownRequest("P2010", { code: "40001" }), true],
    [knownRequest("P2010", { code: "40P01" }), true],
    [
      knownRequest("P2010", {
        driverAdapterError: {
          cause: { kind: "TransactionWriteConflict" },
        },
      }),
      true,
    ],
    [
      knownRequest("P2010", {
        driverAdapterError: {
          cause: { originalCode: "40P01", kind: "Other" },
        },
      }),
      true,
    ],
    [knownRequest("P2010", { code: "23505" }), false],
    [knownRequest("P2002", { code: "40001" }), false],
    [new Error("database error"), false],
  ] as const)("classifies only retryable serialization errors (%j)", (error, expected) => {
    expect(isAgentSerializationConflict(error)).toBe(expected);
  });

  it("reruns a database callback after an adapter serialization conflict", async () => {
    const conflict = knownRequest("P2010", {
      driverAdapterError: {
        cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
      },
    });
    let callbackRuns = 0;
    transaction.mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => {
      await work({});
      throw conflict;
    });
    transaction.mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => work({}));

    await expect(
      runAgentSerializable(async () => {
        callbackRuns += 1;
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(callbackRuns).toBe(2);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unrelated P2010 error", async () => {
    const failure = knownRequest("P2010", { code: "23505" });
    transaction.mockRejectedValue(failure);

    await expect(runAgentSerializable(async () => "unreachable")).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
