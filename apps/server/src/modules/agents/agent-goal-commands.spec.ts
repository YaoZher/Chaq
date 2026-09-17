import assert from "node:assert/strict";
import test from "node:test";
import { AgentGoalStatus, type AgentGoal, type Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma.service";
import { AgentRuntimeService } from "../agent-runtime/agent-runtime.service";
import { AgentsService } from "./agents.service";
import type { AgentGoalUpdate } from "./agent-goal-commands";

type GoalAction = { type: "update_goal"; goalId: string; status?: AgentGoalUpdate["status"]; progress?: number };
type GoalActionExecutor = {
  executeAction(
    state: { runId: string; context: { agent: { id: string }; tools: Array<{ name: string; enabled: boolean }> } },
    action: GoalAction,
    key: string
  ): Promise<{ summary: string; eventRecorded?: boolean }>;
};

function goalFixture() {
  const completedAt = new Date("2026-01-02T00:00:00.000Z");
  let goal: AgentGoal = {
    id: "goal-1", agentId: "agent-1", parentGoalId: null,
    title: "Ship an update", description: "", status: AgentGoalStatus.COMPLETED,
    priority: 50, progress: 1, success: "", dueAt: null, completedAt, metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: completedAt
  };
  let events: Array<{ idempotencyKey?: string; content: string }> = [];
  let writes = 0;
  let failEvent = false;
  const tx = {
    agentGoal: {
      findFirst: async ({ where }: { where: { id: string; agentId: string } }) =>
        goal.id === where.id && goal.agentId === where.agentId ? goal : null,
      updateMany: async ({ where, data }: { where: { id: string; agentId: string }; data: Partial<AgentGoal> }) => {
        if (goal.id !== where.id || goal.agentId !== where.agentId) return { count: 0 };
        goal = { ...goal, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
        writes += 1;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...goal })
    },
    agentEvent: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: { data: { idempotencyKey?: string; content: string } }) => {
        if (failEvent) throw new Error("Event storage failed");
        events.push(data);
        return data;
      }
    }
  };
  // Goal and event delegates are only available on the transaction client.
  const prisma = {
    agent: { findFirst: async () => ({ id: "agent-1", ownerId: "owner-1" }) },
    $transaction: async <T>(callback: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      const previousGoal = goal;
      const previousEvents = [...events];
      try {
        return await callback(tx as unknown as Prisma.TransactionClient);
      } catch (error) {
        goal = previousGoal;
        events = previousEvents;
        throw error;
      }
    }
  } as unknown as PrismaService;
  const agents = new AgentsService(prisma, {} as never, {} as never, {} as never);
  const runtime = new AgentRuntimeService(prisma, {} as never, {} as never) as unknown as GoalActionExecutor;
  return {
    manual: (input: AgentGoalUpdate, goalId = "goal-1") => agents.updateGoal("owner-1", "agent-1", goalId, input),
    autonomous: (input: Pick<AgentGoalUpdate, "status" | "progress">, goalId = "goal-1", key = "run-1:action:0") =>
      runtime.executeAction({
        runId: "run-1",
        context: { agent: { id: "agent-1" }, tools: [{ name: "manage_goal", enabled: true }] }
      }, { type: "update_goal", goalId, ...input }, key),
    goal: () => ({ ...goal }),
    events: () => [...events],
    writes: () => writes,
    failEvent: () => { failEvent = true; }
  };
}

for (const status of ["pending", "active", "blocked", "cancelled"] as const) {
  test(`owner and autonomous goal updates both clear completion time when changing to ${status}`, async () => {
    for (const entry of ["manual", "autonomous"] as const) {
      const fixture = goalFixture();
      await fixture[entry]({ status, progress: 0.25 });
      assert.equal(fixture.goal().status, status.toUpperCase());
      assert.equal(fixture.goal().completedAt, null);
      assert.equal(fixture.goal().progress, 0.25);
      assert.equal(fixture.events().length, 1);
    }
  });
}

test("both goal entry points preserve completion time for progress-only edits", async () => {
  for (const entry of ["manual", "autonomous"] as const) {
    const fixture = goalFixture();
    const original = fixture.goal();
    await fixture[entry]({ progress: 0.9 });
    assert.equal(fixture.goal().status, original.status);
    assert.equal(fixture.goal().completedAt, original.completedAt);
    assert.equal(fixture.goal().progress, 0.9);
  }
});

test("both goal entry points stamp completion and report one event", async () => {
  for (const entry of ["manual", "autonomous"] as const) {
    const fixture = goalFixture();
    const before = Date.now();
    await fixture[entry]({ status: "completed" });
    const completedAt = fixture.goal().completedAt;
    assert.ok(completedAt && completedAt.getTime() >= before && completedAt.getTime() <= Date.now());
    assert.equal(fixture.events().length, 1);
  }
});

test("replaying an autonomous goal action keeps its original write and event", async () => {
  const fixture = goalFixture();
  const first = await fixture.autonomous({ status: "completed" });
  const completedAt = fixture.goal().completedAt;
  const replay = await fixture.autonomous({ status: "completed" });
  assert.equal(first.eventRecorded, true);
  assert.deepEqual(replay, first);
  assert.equal(fixture.goal().completedAt, completedAt);
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.events().length, 1);
  assert.equal(fixture.events()[0].idempotencyKey, "run-1:action:0");
});

test("both goal entry points refuse another agent's goal without writing an event", async () => {
  for (const entry of ["manual", "autonomous"] as const) {
    const fixture = goalFixture();
    await assert.rejects(fixture[entry]({ status: "active" }, "foreign-goal"), /Goal not found/);
    assert.equal(fixture.writes(), 0);
    assert.equal(fixture.events().length, 0);
  }
});

test("goal state and audit event are part of the same transaction at both entry points", async () => {
  for (const entry of ["manual", "autonomous"] as const) {
    const fixture = goalFixture();
    const original = fixture.goal();
    fixture.failEvent();
    await assert.rejects(fixture[entry]({ status: "active" }), /Event storage failed/);
    assert.deepEqual(fixture.goal(), original);
    assert.equal(fixture.events().length, 0);
  }
});

test("shared goal command keeps owner parent validation and supports clearing the parent", async () => {
  const fixture = goalFixture();
  await assert.rejects(fixture.manual({ parentGoalId: "goal-1" }), /own parent/);
  await assert.rejects(fixture.manual({ parentGoalId: "foreign-goal" }), /Parent goal not found/);
  assert.equal(fixture.writes(), 0);
  await fixture.manual({ parentGoalId: null, dueAt: null });
  assert.equal(fixture.goal().parentGoalId, null);
  assert.equal(fixture.goal().dueAt, null);
});
