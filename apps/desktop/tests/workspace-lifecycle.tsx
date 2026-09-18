import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentDetail, ConversationSummary } from "@chaq/shared";
import { AgentWorkspace } from "../src/renderer/components/agent-workspace";
import { api, type LoginUser } from "../src/renderer/lib/api";

type Result = { name: string; passed: boolean; error?: string };
const timestamp = "2026-01-01T00:00:00.000Z";
const user: LoginUser = {
  id: "workspace-user", username: "workspace-user", displayName: "Workspace user",
  role: "USER", tokenBalance: 100, createdAt: timestamp
};

function agentFixture(id: string): AgentDetail {
  return {
    id, ownerId: user.id, name: id === "agent-a" ? "Agent A" : "Agent B", handle: id,
    tagline: "", biography: "", persona: "Test agent", tone: "plain", values: [],
    worldview: "", boundaries: "", identity: { traits: [], interests: [] }, tags: [],
    autonomyMode: "copilot", visibility: "private", serviceFee: 0, temperature: 0.7,
    initiative: 0.5, reflectionDepth: 0.5, scheduleEveryMinutes: 60,
    dailyTokenBudget: 1000, dailyActionBudget: 10, status: "active", presence: "away",
    tokensUsedToday: 0, actionsUsedToday: 0, activeGoalCount: 0, unreadCount: 0,
    createdAt: timestamp, updatedAt: timestamp, knowledgeSources: [], memories: [],
    relationships: [], goals: [], tasks: [], tools: [], recentRuns: [], recentEvents: []
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  check(predicate(), message);
}

function fixture() {
  const agents = new Map(["agent-a", "agent-b"].map((id) => [id, agentFixture(id)]));
  const reads: string[] = [];
  const notices: string[] = [];
  const imports: Array<{ agentId: string; payload: unknown }> = [];
  const pending = deferred<Awaited<ReturnType<typeof api.addAgentKnowledge>>>();
  const originalFetch = window.fetch;
  const mocks = {
    agents: async () => [...agents.values()].map((agent) => structuredClone(agent)),
    agentContacts: async () => [],
    conversations: async () => [],
    agent: async (id: string) => {
      reads.push(id);
      const agent = agents.get(id);
      check(agent, `unexpected agent ${id}`);
      return structuredClone(agent);
    },
    agentActivity: async () => [],
    conversationWithAgent: async (id: string): Promise<ConversationSummary> => ({
      id: `conversation-${id}`, kind: "human_agent", title: id,
      participants: [], unreadCount: 0, createdAt: timestamp
    }),
    conversationMessages: async () => [],
    markConversationRead: async () => ({ ok: true as const }),
    addAgentKnowledge: async (agentId: string, payload: unknown) => {
      imports.push({ agentId, payload });
      return pending.promise;
    }
  } satisfies Partial<typeof api>;
  const originals = Object.fromEntries(Object.keys(mocks).map((key) => [key, api[key as keyof typeof mocks]]));
  Object.assign(api, mocks);
  window.fetch = async () => { throw new Error("Unexpected network request in workspace fixture"); };
  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  let mounted = false;

  function field(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`);
    check(node, `missing field ${placeholder}`);
    return node;
  }

  async function click(selector: string, text: string): Promise<void> {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find((item) => item.textContent === text);
    check(button, `missing button ${text}`);
    await act(async () => { button.click(); });
  }

  async function fill(placeholder: string, value: string): Promise<void> {
    const node = field(placeholder);
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    await act(async () => {
      setter.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  return {
    container, reads, notices, imports, field, fill,
    selected: () => container.querySelector(".agent-directory-row.active strong")?.textContent,
    mount: async () => {
      await act(async () => { root.render(<AgentWorkspace user={user} providers={[]} skills={[]} onNotice={(message) => notices.push(message)} />); });
      mounted = true;
      await waitFor(() => container.querySelector(".agent-stage h2")?.textContent === "Agent A", "initial agent must load");
      await click("[role=tab]", "记忆");
    },
    startImport: async () => {
      await fill("知识标题", "Original knowledge title");
      await fill("知识内容", "Original knowledge draft");
      await click(".knowledge button", "索引");
      check(imports.length === 1 && imports[0].agentId === "agent-a", "import must be pending for Agent A");
    },
    selectB: async () => {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-directory-row"))
        .find((item) => item.querySelector("strong")?.textContent === "Agent B");
      check(button, "Agent B must appear in the directory");
      await act(async () => { button.click(); });
      await waitFor(() => container.querySelector(".agent-stage h2")?.textContent === "Agent B", "Agent B must load before the import finishes");
    },
    finishImport: async (failed: boolean) => {
      agents.get("agent-a")!.knowledgeSources.push({
        id: "source-a", agentId: "agent-a", kind: "note", status: failed ? "failed" : "ready",
        title: "Original knowledge title", summary: "Original knowledge draft",
        chunkCount: failed ? 0 : 1, error: failed ? "Index temporarily unavailable" : null,
        createdAt: timestamp, updatedAt: timestamp
      });
      await act(async () => {
        if (failed) pending.reject(new Error("Index temporarily unavailable"));
        else pending.resolve({ id: "source-a", chunkCount: 1 });
      });
      await waitFor(() => notices.length > 0, "import completion must reach the component");
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      mounted = false;
    },
    dispose: async () => {
      if (mounted) await act(async () => { root.unmount(); });
      container.remove();
      Object.assign(api, originals);
      window.fetch = originalFetch;
    }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; run(test: Fixture): Promise<void> }> = [
  ...[false, true].map((failed) => ({
    name: `a ${failed ? "failed" : "successful"} knowledge import cannot reselect an agent after switching away`,
    async run(test: Fixture) {
      await test.startImport();
      await test.selectB();
      await test.fill("知识内容", "Agent B draft");
      const readsBefore = test.reads.length;
      await test.finishImport(failed);
      check(test.selected() === "Agent B", "late Agent A completion must not change the selected agent");
      check(test.container.querySelector(".agent-stage h2")?.textContent === "Agent B", "Agent B detail must remain visible");
      check(test.field("知识内容").value === "Agent B draft", "late completion must preserve Agent B's draft");
      check(test.reads.length === readsBefore, "a stale mutation must not start another selection or refresh");
    }
  })),
  {
    name: "an unmounted workspace cannot restart refreshes when its knowledge import finishes",
    async run(test) {
      await test.startImport();
      const readsBefore = test.reads.length;
      await test.unmount();
      await test.finishImport(false);
      check(test.reads.length === readsBefore, "unmounted mutation must not restart agent requests");
      check(test.container.childElementCount === 0, "unmounted workspace must remain empty");
    }
  },
  {
    name: "a failed knowledge import refreshes its recovery entry without discarding the draft",
    async run(test) {
      await test.startImport();
      const originalField = test.field("知识内容");
      await test.finishImport(true);
      await waitFor(() => Boolean(test.container.querySelector(".agent-knowledge-list")?.textContent?.includes("failed")), "failed source must become available for rebuilding");
      check(test.selected() === "Agent A", "refresh must preserve Agent A selection");
      check(test.field("知识内容") === originalField, "refresh must not unmount the memory panel");
      check(test.field("知识标题").value === "Original knowledge title", "failed import must retain its title");
      check(test.field("知识内容").value === "Original knowledge draft", "failed import must retain its content");
    }
  },
  {
    name: "a successful knowledge import refreshes the source while preserving other unsaved fields",
    async run(test) {
      await test.fill("长期记忆", "Unsaved memory draft");
      await test.startImport();
      const originalField = test.field("长期记忆");
      await test.finishImport(false);
      await waitFor(() => Boolean(test.container.querySelector(".agent-knowledge-list")?.textContent?.includes("ready")), "indexed source must appear after success");
      check(test.field("知识内容").value === "" && test.field("知识标题").value === "", "successful import clears only the submitted knowledge fields");
      check(test.field("长期记忆") === originalField, "refresh must keep the memory editor mounted");
      check(test.field("长期记忆").value === "Unsaved memory draft", "unsubmitted memory must survive the knowledge refresh");
    }
  }
];

export async function runWorkspaceLifecycleCases(): Promise<Result[]> {
  const results: Result[] = [];
  for (const entry of cases) {
    const test = fixture();
    try {
      await test.mount();
      await entry.run(test);
      results.push({ name: entry.name, passed: true });
    } catch (error) {
      results.push({ name: entry.name, passed: false, error: error instanceof Error ? error.stack : String(error) });
    } finally {
      await test.dispose();
    }
  }
  return results;
}
