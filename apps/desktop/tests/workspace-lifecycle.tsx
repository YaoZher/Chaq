import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentContact, AgentDetail, ConversationMessage, ConversationSummary } from "@chaq/shared";
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
  const directoryConversations: ConversationSummary[] = [];
  const directoryContacts: AgentContact[] = [];
  const conversationMessages: ConversationMessage[] = [];
  const reads: string[] = [];
  const notices: string[] = [];
  const imports: Array<{ agentId: string; payload: unknown }> = [];
  const pending = deferred<Awaited<ReturnType<typeof api.addAgentKnowledge>>>();
  const originalFetch = window.fetch;
  const mocks = {
    agents: async () => [...agents.values()].map((agent) => structuredClone(agent)),
    agentContacts: async () => structuredClone(directoryContacts),
    conversations: async () => structuredClone(directoryConversations),
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
    conversationMessages: async () => structuredClone(conversationMessages),
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
    container, reads, notices, imports, field, fill, click, directoryConversations, directoryContacts, conversationMessages,
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
  {
    name: "existing conversations replace duplicate partner rows while names and aliases remain searchable",
    async run(test) {
      test.directoryConversations.push({
        id: "conversation-agent-a", kind: "human_agent", title: "Existing conversation", unreadCount: 0, createdAt: timestamp,
        participants: [{ id: "participant-a", participantKind: "agent", participantId: "agent-a", displayNameSnapshot: "Former name", muted: false }]
      }, {
        id: "conversation-public", kind: "human_agent", title: "Public conversation", unreadCount: 0, createdAt: timestamp,
        participants: [{ id: "participant-public", participantKind: "agent", participantId: "public-agent", displayNameSnapshot: "Public partner", muted: false }]
      });
      test.directoryContacts.push({
        id: "contact-public", alias: "Morning buddy", muted: false, createdAt: timestamp, updatedAt: timestamp,
        agent: { ...agentFixture("public-agent"), name: "Public partner", profileStatus: "", mood: "" }
      });
      await test.click('[aria-label="刷新列表"]', "");
      check(test.container.querySelectorAll(".agent-inbox-row").length === 2, "existing conversations must be displayed");
      const partners = Array.from(test.container.querySelectorAll(".agent-directory-list .agent-directory-row strong")).map((item) => item.textContent);
      check(partners.length === 1 && partners[0] === "Agent B", "messages must only list partners without an existing conversation");
      check(test.container.querySelectorAll(".agent-inbox-row.active, .agent-directory-row.active").length === 1, "selection must have a single directory entry");
      await test.fill("搜索 Agent", "Agent A");
      check(test.container.querySelector(".agent-inbox-row strong")?.textContent === "Existing conversation", "current partner names must find renamed conversations");
      await test.fill("搜索 Agent", "Morning buddy");
      check(test.container.querySelector(".agent-inbox-row strong")?.textContent === "Public conversation", "contact aliases must find their conversations");
      await test.click(".qq-directory-tabs button", "联系人");
      check(test.container.querySelector(".agent-contact-list strong")?.textContent === "Morning buddy", "contact search must match aliases");
      await test.click('[aria-label="清空搜索"]', "");
      check(test.container.querySelectorAll(".agent-directory-list .agent-directory-row").length === 2, "contacts must retain the full owned partner list");
    }
  },
  {
    name: "the bottom shortcut stays outside message flow and settles at the actual bottom with reduced motion",
    async run(test) {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = (query) => ({ ...originalMatchMedia.call(window, query), matches: query === "(prefers-reduced-motion: reduce)" } as MediaQueryList);
      try {
        for (let index = 0; index < 24; index += 1) {
          test.conversationMessages.push({ id: `message-${index}`, conversationId: "conversation-agent-a", authorKind: "agent", authorId: "agent-a", kind: "text", content: `Message ${index}`, status: "delivered", createdAt: timestamp });
        }
        await test.click("[role=tab]", "会话");
        await test.click('[title="刷新"]', "");
        await waitFor(() => test.container.querySelectorAll(".agent-message-row").length === 24, "fixture messages must load");
        const list = test.container.querySelector<HTMLDivElement>(".agent-message-list")!;
        list.style.height = "180px";
        list.style.overflow = "auto";
        const scroll = list.scrollTo.bind(list);
        const behaviors: ScrollBehavior[] = [];
        list.scrollTo = ((options: ScrollToOptions) => { behaviors.push(options.behavior ?? "auto"); scroll(options); }) as typeof list.scrollTo;
        await act(async () => {
          list.scrollTop = 0;
          list.dispatchEvent(new Event("scroll"));
        });
        await waitFor(() => Boolean(test.container.querySelector(".agent-scroll-bottom")), "scrolling up must reveal the shortcut");
        check(!list.querySelector(".agent-scroll-bottom"), "shortcut must not increase the message scroll height");
        await test.click(".agent-scroll-bottom", "到底部");
        await waitFor(() => !test.container.querySelector(".agent-scroll-bottom"), "shortcut must disappear after reaching the actual bottom");
        check(list.scrollHeight - list.clientHeight - list.scrollTop < 2, "jump must reach the actual bottom of the message container");
        check(behaviors.length > 0 && behaviors.every((behavior) => behavior === "instant"), "reduced motion must avoid smooth programmatic scrolling");
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    }
  },
  {
    name: "message and contact navigation retain the active conversation",
    async run(test) {
      await test.click(".qq-directory-tabs button", "联系人");
      check(test.container.querySelector(".qq-directory-tabs button.active")?.textContent === "联系人", "contacts navigation must become active");
      check(test.selected() === "Agent A", "contact navigation must preserve the selected partner");
      await test.click(".qq-directory-tabs button", "发现");
      check(test.container.querySelector(".qq-discovery-card"), "discovery must show its entry point");
      check(test.container.querySelector(".agent-stage h2")?.textContent === "Agent A", "discovery must not discard the current conversation");
      await test.click(".qq-directory-tabs button", "消息");
      check(test.selected() === "Agent A", "returning to messages must restore the current selection");
    }
  },
  {
    name: "directory search can be cleared without replacing the active partner",
    async run(test) {
      await test.fill("搜索 Agent", "Agent B");
      const visible = Array.from(test.container.querySelectorAll(".agent-directory-row strong")).map((item) => item.textContent);
      check(visible.length === 1 && visible[0] === "Agent B", "search must filter the directory");
      check(test.container.querySelector(".agent-stage h2")?.textContent === "Agent A", "search must not change the active conversation");
      await test.click('[aria-label="清空搜索"]', "");
      check(test.field("搜索 Agent").value === "", "clear must reset the search text");
      check(test.selected() === "Agent A", "clear must restore the selected partner in the directory");
    }
  },
  {
    name: "chat details and emoji insertion work without losing the message draft",
    async run(test) {
      await test.click("[role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Hello");
      check(!test.container.querySelector(".qq-chat-details"), "details should start collapsed");
      await test.click('[aria-label="查看聊天详情"]', "");
      check(test.container.querySelector(".qq-chat-details h3")?.textContent === "Agent A", "details must describe the active partner");
      await test.click('[aria-label="关闭详情"]', "");
      check(!test.container.querySelector(".qq-chat-details"), "close must collapse the details pane");
      check(test.field("发消息给 Agent A").value === "Hello", "opening details must preserve the message draft");
      test.field("发消息给 Agent A").setSelectionRange(5, 5);
      await test.click('[aria-label="表情"]', "");
      await test.click(".qq-emoji-picker button", "👋");
      check(test.field("发消息给 Agent A").value === "Hello👋", "emoji must insert at the draft cursor");
      check(!test.container.querySelector(".qq-emoji-picker"), "emoji picker must close after insertion");
    }
  },
  {
    name: "Escape closes chat details after the foreground dialog has closed",
    async run(test) {
      await test.click("[role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Keep this draft");
      await test.click('[aria-label="查看聊天详情"]', "");
      await test.click('[aria-label="创建 Agent"]', "");
      check(test.container.querySelector(".agent-dialog"), "create dialog must open above chat details");
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      check(!test.container.querySelector(".agent-dialog"), "Escape must dismiss the foreground dialog");
      check(test.container.querySelector(".qq-chat-details"), "dismissing a dialog must preserve chat details behind it");
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      check(!test.container.querySelector(".qq-chat-details"), "Escape must dismiss chat details when no dialog is open");
      check(test.field("发消息给 Agent A").value === "Keep this draft", "keyboard dismissal must preserve the message draft");
    }
  },
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
