import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-access/access", () => ({
  authorizeAgentRead: vi.fn().mockResolvedValue(undefined),
  withAgentMutation: vi.fn(),
}));

import { getAgentNeedsAttention } from "@/lib/agent-access/progress";
import { AgentOperationError } from "@/lib/agent-access/operations";

describe("agent needs-attention cursor mapping", () => {
  it("maps a malformed domain cursor to invalid_input", async () => {
    const result = getAgentNeedsAttention(
      { userId: "learner-1" } as never,
      { limit: 1, cursor: "not-base64-json" },
    );
    await expect(result).rejects.toBeInstanceOf(AgentOperationError);
    await expect(result).rejects.toMatchObject({
      code: "invalid_input",
      message: "The needs-attention cursor is invalid. Request the first page and try again.",
    });
  });
});
