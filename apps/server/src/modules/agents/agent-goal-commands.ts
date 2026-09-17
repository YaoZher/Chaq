import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AgentGoalStatus, Prisma } from "@prisma/client";
import type { z } from "zod";
import type { agentGoalUpdateSchema } from "@chaq/shared";

export type AgentGoalUpdate = z.infer<typeof agentGoalUpdateSchema>;

/** Applies the same goal transition for owner requests and autonomous actions. */
export async function updateAgentGoal(
  tx: Prisma.TransactionClient,
  agentId: string,
  goalId: string,
  input: AgentGoalUpdate
) {
  if (input.parentGoalId !== undefined) {
    if (input.parentGoalId === goalId) throw new BadRequestException("A goal cannot be its own parent.");
    if (input.parentGoalId) {
      const parent = await tx.agentGoal.findFirst({
        where: { id: input.parentGoalId, agentId },
        select: { id: true }
      });
      if (!parent) throw new NotFoundException("Parent goal not found.");
    }
  }
  const changed = await tx.agentGoal.updateMany({
    where: { id: goalId, agentId },
    data: {
      parentGoalId: input.parentGoalId,
      title: input.title,
      description: input.description,
      status: input.status ? AgentGoalStatus[input.status.toUpperCase() as keyof typeof AgentGoalStatus] : undefined,
      priority: input.priority,
      progress: input.progress,
      success: input.success,
      dueAt: input.dueAt === null ? null : input.dueAt ? new Date(input.dueAt) : undefined,
      completedAt: input.status === "completed" ? new Date() : input.status ? null : undefined
    }
  });
  if (!changed.count) throw new NotFoundException("Goal not found.");
  return tx.agentGoal.findUniqueOrThrow({ where: { id: goalId } });
}
