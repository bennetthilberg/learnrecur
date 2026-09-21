import "server-only";

import {
  AgentOperationItemStatus,
  AgentOperationStatus,
} from "@/generated/prisma/client";
import { reduceAgentOperationStatus } from "./status";
import { runAgentSerializable } from "./transactions";

const TERMINAL_OPERATION_STATUSES: AgentOperationStatus[] = [
  AgentOperationStatus.SUCCEEDED,
  AgentOperationStatus.PARTIAL,
  AgentOperationStatus.FAILED,
  AgentOperationStatus.CANCELED,
];

export async function reconcileAgentOperation(input: {
  operationId: string;
  userId: string;
  now: Date;
}) {
  return runAgentSerializable(async (tx) => {
    const items = await tx.agentSkillOperationItem.findMany({
      where: { operationId: input.operationId, userId: input.userId },
      select: { status: true },
    });
    if (items.length === 0) return null;
    const status = reduceAgentOperationStatus(items.map((item) => item.status));
    const activeCount = items.filter((item) => item.status === AgentOperationItemStatus.ACTIVE).length;
    const reusedCount = items.filter((item) => item.status === AgentOperationItemStatus.REUSED).length;
    const failedCount = items.filter((item) => item.status === AgentOperationItemStatus.FAILED).length;
    const terminal = TERMINAL_OPERATION_STATUSES.includes(status);
    await tx.agentSkillOperation.updateMany({
      where: {
        id: input.operationId,
        userId: input.userId,
        status: { notIn: TERMINAL_OPERATION_STATUSES },
      },
      data: {
        status,
        activeCount,
        reusedCount,
        failedCount,
        completedAt: terminal ? input.now : null,
      },
    });
    return { status, activeCount, reusedCount, failedCount, terminal };
  });
}
