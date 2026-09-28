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
  const pendingSend = deferred<ConversationMessage>();
  const sends: string[] = [];
  const readReceipts: string[] = [];
  const directoryReads: number[] = [];
  const pollTimers = new Map<number, () => void>();
  const timerWindow: Window = window;
  const originalSetInterval = timerWindow.setInterval;
  const originalClearInterval = timerWindow.clearInterval;
  const originalFetch = window.fetch;
  const mocks = {
    agents: async () => {
      directoryReads.push(Date.now());
      return [...agents.values()].map((agent) => structuredClone(agent));
    },
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
    markConversationRead: async (id: string) => {
      readReceipts.push(id);
      return { ok: true as const };
    },
    sendConversationMessage: async (conversationId: string) => {
      sends.push(conversationId);
      return pendingSend.promise;
    },
    addAgentKnowledge: async (agentId: string, payload: unknown) => {
      imports.push({ agentId, payload });
      return pending.promise;
    }
  } satisfies Partial<typeof api>;
  const originals = Object.fromEntries(Object.keys(mocks).map((key) => [key, api[key as keyof typeof mocks]]));
  Object.assign(api, mocks);
  window.fetch = async () => { throw new Error("Unexpected network request in workspace fixture"); };
  timerWindow.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = originalSetInterval.call(window, handler, delay, ...args);
    if (delay === 10_000 && typeof handler === "function") pollTimers.set(id, () => handler(...args));
    return id;
  };
  timerWindow.clearInterval = (id?: number) => {
    if (id !== undefined) pollTimers.delete(id);
    originalClearInterval.call(window, id);
  };
  const container = document.createElement("div");
  container.style.width = "1024px";
  container.style.height = "700px";
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  let mounted = false;

  function queryAll<T extends Element = Element>(selector: string): T[] {
    return Array.from(container.querySelectorAll<T>(selector)).filter((node) => !node.closest('[inert], [aria-hidden="true"]'));
  }

  function query<T extends Element = Element>(selector: string): T | null {
    return queryAll<T>(selector)[0] ?? null;
  }

  function field(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
    const node = query<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`);
    check(node, `missing field ${placeholder}`);
    return node;
  }

  async function click(selector: string, text: string): Promise<void> {
    const button = queryAll<HTMLButtonElement>(selector).find((item) => item.textContent === text);
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
    container, reads, notices, imports, field, fill, click, query, queryAll, sends, readReceipts, directoryReads, directoryConversations, directoryContacts, conversationMessages,
    selected: () => query(".agent-directory-row.active strong")?.textContent,
    pollTimerCount: () => pollTimers.size,
    tickPoll: async () => {
      await act(async () => { for (const callback of pollTimers.values()) callback(); });
    },
    setActive: async (active: boolean) => {
      await act(async () => { root.render(<AgentWorkspace active={active} user={user} providers={[]} skills={[]} onNotice={(message) => notices.push(message)} />); });
    },
    failSend: async () => {
      await act(async () => { pendingSend.reject(new Error("Message delivery interrupted")); });
    },
    finishSend: async () => {
      await act(async () => { pendingSend.resolve({ id: "sent-message", conversationId: "conversation-agent-a", authorKind: "user", authorId: user.id, kind: "text", content: "Pending message", status: "delivered", createdAt: timestamp }); });
    },
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
      const button = queryAll<HTMLButtonElement>(".agent-directory-row")
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
      timerWindow.setInterval = originalSetInterval;
      timerWindow.clearInterval = originalClearInterval;
    }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; run(test: Fixture): Promise<void> }> = [
  {
    name: "switching companion tabs preserves draft fields, validation and scroll position",
    async run(test) {
      await test.fill("长期记忆", "Unsaved memory across tabs");
      await test.click(".knowledge button", "索引");
      const field = test.field("长期记忆");
      const scroll = field.closest<HTMLDivElement>(".agent-panel-stack")!;
      scroll.style.height = "160px";
      scroll.style.flex = "0 0 160px";
      check(scroll.scrollHeight - scroll.clientHeight > 85, `memory fixture must have overflowing form content (client=${scroll.clientHeight}, content=${scroll.scrollHeight}, display=${getComputedStyle(scroll).display}, overflow=${getComputedStyle(scroll).overflowY}, hidden=${Boolean(scroll.closest('[hidden]'))})`);
      scroll.scrollTop = 85;
      const savedScroll = scroll.scrollTop;
      check(Math.abs(savedScroll - 85) < 1, "memory fixture must have a scrollable editor at the current display scale");
      const errors = test.queryAll(".field-error").map((item) => item.textContent).join("|");
      check(errors.length > 0, "invalid knowledge must display its validation errors");
      await test.click(".agent-tabs [role=tab]", "目标");
      await waitFor(() => Boolean(scroll.closest("[hidden]")), "inactive memory pane must finish exiting");
      check(field.closest("[inert]"), "inactive editor must not receive keyboard input");
      await test.click(".agent-tabs [role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Unsent chat draft");
      await test.click(".agent-tabs [role=tab]", "记忆");
      check(test.field("长期记忆") === field && field.value === "Unsaved memory across tabs", "return must reuse the unsaved memory editor");
      check(Math.abs(scroll.scrollTop - savedScroll) < 1, "return must restore the memory scroll position");
      check(test.queryAll(".field-error").map((item) => item.textContent).join("|") === errors, "tab switching must preserve validation feedback");
      await test.click(".agent-tabs [role=tab]", "会话");
      check(test.field("发消息给 Agent A").value === "Unsent chat draft", "chat draft must survive management tabs");
    }
  },
  {
    name: "tab keyboard navigation follows focus and wraps without exposing inactive panes",
    async run(test) {
      const stageTabs = test.query<HTMLElement>(".agent-tabs")!;
      async function press(group: HTMLElement, key: string, expected: string): Promise<void> {
        const current = group.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
        await act(async () => {
          current.focus();
          current.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        });
        const selected = group.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
        check(selected.textContent === expected, `${key} must select ${expected}`);
        check(document.activeElement === selected, `${key} must keep focus on the selected tab`);
        check(group.querySelectorAll('[tabindex="0"]').length === 1, "only the selected tab belongs in the tab order");
        const panel = document.getElementById(selected.getAttribute("aria-controls")!);
        check(panel?.getAttribute("aria-labelledby") === selected.id && !panel.inert, "selected tab must identify its accessible panel");
      }
      await press(stageTabs, "ArrowRight", "关系");
      await press(stageTabs, "End", "活动");
      await press(stageTabs, "Home", "会话");
      await press(stageTabs, "ArrowLeft", "活动");
      const directoryTabs = test.query<HTMLElement>(".qq-directory-tabs")!;
      await press(directoryTabs, "ArrowLeft", "发现");
      await press(directoryTabs, "ArrowRight", "消息");
      check(test.queryAll('.agent-stage-body > [role="tabpanel"]').length === 1, "only one companion pane must remain interactive");
    }
  },
  {
    name: "conversation drafts stay with their own companion",
    async run(test) {
      await test.click(".agent-tabs [role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Agent A draft");
      await test.selectB();
      check(test.field("发消息给 Agent B").value === "", "Agent A draft must not appear in Agent B's composer");
      await test.fill("发消息给 Agent B", "Agent B draft");
      const agentA = test.queryAll<HTMLButtonElement>(".agent-directory-row").find((item) => item.querySelector("strong")?.textContent === "Agent A")!;
      await act(async () => { agentA.click(); });
      await waitFor(() => test.query(".agent-stage h2")?.textContent === "Agent A", "Agent A must become current again");
      check(test.field("发消息给 Agent A").value === "Agent A draft", "returning to Agent A must recover its draft");
      await test.selectB();
      check(test.field("发消息给 Agent B").value === "Agent B draft", "returning to Agent B must recover its own draft");
    }
  },
  {
    name: "hidden workspaces suspend polling and read receipts, then refresh without replacing drafts",
    async run(test) {
      await test.fill("长期记忆", "Keep this editor when returning");
      const field = test.field("长期记忆");
      check(test.pollTimerCount() === 1, "visible workspace must own one polling timer");
      await test.tickPoll();
      const before = test.directoryReads.length;
      const receiptsBefore = test.readReceipts.length;
      await test.setActive(false);
      check(test.pollTimerCount() === 0, "hidden workspace must stop its polling timer");
      const incoming: ConversationMessage = { id: "background-message", conversationId: "conversation-agent-a", authorKind: "agent", authorId: "agent-a", kind: "text", content: "Arrived in background", status: "delivered", createdAt: timestamp };
      await act(async () => { window.dispatchEvent(new CustomEvent("chaq:realtime", { detail: { type: "conversation.message", payload: incoming } })); });
      await test.tickPoll();
      check(test.directoryReads.length === before, "hidden realtime updates must not start refresh requests");
      check(test.readReceipts.length === receiptsBefore, "hidden realtime messages must stay unread");
      await test.setActive(true);
      check(test.directoryReads.length === before + 1 && test.pollTimerCount() === 1, "returning must refresh immediately and resume one timer");
      check(test.readReceipts.length === receiptsBefore, "returning to a management tab must leave chat messages unread");
      check(test.field("长期记忆") === field && field.value === "Keep this editor when returning", "returning must keep the current editor and draft");
      await test.click(".agent-tabs [role=tab]", "会话");
      check(test.readReceipts.length === receiptsBefore + 1, "opening the chat must acknowledge its messages");
      check(test.queryAll(".agent-message-row").some((row) => row.textContent?.includes("Arrived in background")), "background arrivals must be visible after returning");
    }
  },
  ...[false, true].map((failed) => ({
    name: `a pending send can ${failed ? "fail" : "complete"} while its workspace is hidden`,
    async run(test: Fixture) {
      await test.click(".agent-tabs [role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Pending message");
      await test.click('[aria-label="发送消息"]', "发送");
      check(test.sends.length === 1 && test.sends[0] === "conversation-agent-a", "send must target the current conversation once");
      await test.setActive(false);
      if (failed) await test.failSend();
      else await test.finishSend();
      await test.setActive(true);
      check(test.field("发消息给 Agent A").value === (failed ? "Pending message" : ""), "failed delivery must recover the draft while successful delivery clears it");
      check(!test.query(".agent-chat-thinking"), "send completion must clear the busy state even while hidden");
      check(test.sends.length === 1, "returning must not submit the message again");
      if (!failed) check(test.queryAll(".agent-message-row").some((row) => row.textContent?.includes("Pending message")), "successful message must remain visible after the resume refresh");
    }
  })),
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
      check(test.queryAll(".agent-inbox-row").length === 2, "existing conversations must be displayed");
      const partners = Array.from(test.queryAll(".agent-directory-list .agent-directory-row strong")).map((item) => item.textContent);
      check(partners.length === 1 && partners[0] === "Agent B", "messages must only list partners without an existing conversation");
      check(test.queryAll(".agent-inbox-row.active, .agent-directory-row.active").length === 1, "selection must have a single directory entry");
      await test.fill("搜索 Agent", "Agent A");
      check(test.query(".agent-inbox-row strong")?.textContent === "Existing conversation", "current partner names must find renamed conversations");
      await test.fill("搜索 Agent", "Morning buddy");
      check(test.query(".agent-inbox-row strong")?.textContent === "Public conversation", "contact aliases must find their conversations");
      await test.click(".qq-directory-tabs button", "联系人");
      check(test.query(".agent-contact-list strong")?.textContent === "Morning buddy", "contact search must match aliases");
      await test.click('[aria-label="清空搜索"]', "");
      check(test.queryAll(".agent-directory-list .agent-directory-row").length === 2, "contacts must retain the full owned partner list");
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
        await waitFor(() => test.queryAll(".agent-message-row").length === 24, "fixture messages must load");
        const list = test.query<HTMLDivElement>(".agent-message-list")!;
        list.style.height = "180px";
        list.style.overflow = "auto";
        const scroll = list.scrollTo.bind(list);
        const behaviors: ScrollBehavior[] = [];
        list.scrollTo = ((options: ScrollToOptions) => { behaviors.push(options.behavior ?? "auto"); scroll(options); }) as typeof list.scrollTo;
        await act(async () => {
          list.scrollTop = 0;
          list.dispatchEvent(new Event("scroll"));
        });
        await waitFor(() => Boolean(test.query(".agent-scroll-bottom")), "scrolling up must reveal the shortcut");
        check(!list.querySelector(".agent-scroll-bottom"), "shortcut must not increase the message scroll height");
        await test.click(".agent-scroll-bottom", "到底部");
        await waitFor(() => !test.query(".agent-scroll-bottom"), "shortcut must disappear after reaching the actual bottom");
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
      check(test.query(".qq-directory-tabs button.active")?.textContent === "联系人", "contacts navigation must become active");
      check(test.selected() === "Agent A", "contact navigation must preserve the selected partner");
      await test.click(".qq-directory-tabs button", "发现");
      check(test.query(".qq-discovery-card"), "discovery must show its entry point");
      check(test.query(".agent-stage h2")?.textContent === "Agent A", "discovery must not discard the current conversation");
      await test.click(".qq-directory-tabs button", "消息");
      check(test.selected() === "Agent A", "returning to messages must restore the current selection");
    }
  },
  {
    name: "directory search can be cleared without replacing the active partner",
    async run(test) {
      await test.fill("搜索 Agent", "Agent B");
      const visible = Array.from(test.queryAll(".agent-directory-row strong")).map((item) => item.textContent);
      check(visible.length === 1 && visible[0] === "Agent B", "search must filter the directory");
      check(test.query(".agent-stage h2")?.textContent === "Agent A", "search must not change the active conversation");
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
      check(!test.query(".qq-chat-details"), "details should start collapsed");
      await test.click('[aria-label="查看聊天详情"]', "");
      check(test.query(".qq-chat-details h3")?.textContent === "Agent A", "details must describe the active partner");
      test.query<HTMLButtonElement>('[aria-label="关闭详情"]')!.focus();
      await test.click('[aria-label="关闭详情"]', "");
      check(!test.query(".qq-chat-details"), "close must collapse the details pane");
      check(document.activeElement === test.query('[aria-label="查看聊天详情"]'), "closing a focused drawer must return focus to its toggle");
      check(test.field("发消息给 Agent A").value === "Hello", "opening details must preserve the message draft");
      test.field("发消息给 Agent A").setSelectionRange(5, 5);
      await test.click('[aria-label="表情"]', "");
      await test.click(".qq-emoji-picker button", "👋");
      check(test.field("发消息给 Agent A").value === "Hello👋", "emoji must insert at the draft cursor");
      check(!test.query(".qq-emoji-picker"), "emoji picker must close after insertion");
    }
  },
  {
    name: "Escape closes chat details after the foreground dialog has closed",
    async run(test) {
      await test.click("[role=tab]", "会话");
      await test.fill("发消息给 Agent A", "Keep this draft");
      await test.click('[aria-label="查看聊天详情"]', "");
      await test.click('[aria-label="创建 Agent"]', "");
      check(test.query(".agent-dialog"), "create dialog must open above chat details");
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      check(!test.query(".agent-dialog"), "Escape must dismiss the foreground dialog");
      check(test.query(".qq-chat-details"), "dismissing a dialog must preserve chat details behind it");
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      check(!test.query(".qq-chat-details"), "Escape must dismiss chat details when no dialog is open");
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
      check(test.query(".agent-stage h2")?.textContent === "Agent B", "Agent B detail must remain visible");
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
      await waitFor(() => Boolean(test.query(".agent-knowledge-list")?.textContent?.includes("failed")), "failed source must become available for rebuilding");
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
      await waitFor(() => Boolean(test.query(".agent-knowledge-list")?.textContent?.includes("ready")), "indexed source must appear after success");
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
