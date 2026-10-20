import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentProfile, ConversationMessage, ConversationSummary } from "@chaq/shared";
import { AgentProfileView } from "../src/renderer/components/agent-profile";
import { api, type LoginUser } from "../src/renderer/lib/api";

type Result = { name: string; passed: boolean; error?: string };
const timestamp = "2026-01-01T00:00:00.000Z";
const user: LoginUser = { id: "profile-user", username: "profile-user", displayName: "Profile user", role: "USER", tokenBalance: 100, createdAt: timestamp };

function profileFixture(id: string): AgentProfile {
  return {
    agent: { id, name: id === "agent-a" ? "Agent A" : "Agent B", handle: id, tagline: "A profile", biography: "", profileStatus: "Original status", mood: "Calm", presence: "away", tags: [], status: "active", autonomyMode: "copilot", serviceFee: 0, updatedAt: timestamp, createdAt: timestamp, identity: { traits: [], interests: [] }, values: [] },
    owner: { displayName: user.displayName }, isOwner: true, isContact: false,
    stats: { posts: 0, relationships: 0, conversations: 0, daysActive: 1 }, posts: [], recentActivity: []
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
  while (!predicate() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  check(predicate(), message);
}

function fixture() {
  let readProfile: (id: string) => Promise<AgentProfile> = async (id) => profileFixture(id);
  let readConversation: (id: string) => Promise<ConversationSummary> = async (id) => ({ id: `conversation-${id}`, kind: "human_agent", title: id, participants: [], unreadCount: 0, createdAt: timestamp });
  let readMessages: () => Promise<ConversationMessage[]> = async () => [];
  let createPost: typeof api.createAgentPost = async () => { throw new Error("Unexpected post"); };
  const profileReads: string[] = [];
  const conversationReads: string[] = [];
  const receipts: string[] = [];
  const notices: string[] = [];
  let messageReads = 0;
  let closes = 0;
  const timers = new Map<number, () => void>();
  const originalFetch = window.fetch;
  const timerWindow: Window = window;
  const originalSetInterval = timerWindow.setInterval;
  const originalClearInterval = timerWindow.clearInterval;
  const mocks = {
    agentProfile: async (id: string) => { profileReads.push(id); return readProfile(id); },
    conversationWithAgent: async (id: string) => { conversationReads.push(id); return readConversation(id); },
    conversationMessages: async () => { messageReads += 1; return readMessages(); },
    markConversationRead: async (id: string) => { receipts.push(id); return { ok: true as const }; },
    createAgentPost: (...args: Parameters<typeof api.createAgentPost>) => createPost(...args)
  } satisfies Partial<typeof api>;
  const originals = Object.fromEntries(Object.keys(mocks).map((key) => [key, api[key as keyof typeof mocks]]));
  Object.assign(api, mocks);
  window.fetch = async () => { throw new Error("Unexpected network request in profile fixture"); };
  timerWindow.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = originalSetInterval.call(window, () => undefined, 60_000);
    if (delay === 3_000 && typeof handler === "function") timers.set(id, () => handler(...args));
    return id;
  };
  timerWindow.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); originalClearInterval.call(window, id); };
  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  let mounted = true;
  const render = async (agentId = "agent-a", initialChatOpen = false) => {
    await act(async () => { root.render(<AgentProfileView agentId={agentId} initialChatOpen={initialChatOpen} user={user} onClose={() => { closes += 1; }} onAgentChanged={() => undefined} onNotice={(message) => notices.push(message)} />); });
  };
  const button = (text: string) => {
    const node = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text || item.title === text);
    check(node, `missing button ${text}`);
    return node;
  };
  const field = (placeholder: string) => {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`);
    check(node, `missing field ${placeholder}`);
    return node;
  };
  return {
    container, profileReads, conversationReads, receipts, notices, render, button, field,
    setProfileRead: (read: typeof readProfile) => { readProfile = read; },
    setConversationRead: (read: typeof readConversation) => { readConversation = read; },
    setMessageRead: (read: typeof readMessages) => { readMessages = read; },
    setCreatePost: (create: typeof createPost) => { createPost = create; },
    messageReadCount: () => messageReads,
    closeCount: () => closes,
    timerCount: () => timers.size,
    tick: async () => { await act(async () => { for (const callback of [...timers.values()]) callback(); }); },
    click: async (text: string) => { await act(async () => { button(text).click(); }); },
    fill: async (placeholder: string, value: string) => {
      const node = field(placeholder);
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
    },
    unmount: async () => { await act(async () => root.unmount()); mounted = false; },
    dispose: async () => {
      if (mounted) await act(async () => root.unmount());
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
    name: "profile initial failure offers retry and close without an endless spinner or notification loop",
    async run(test) {
      test.setProfileRead(async () => { throw new Error("Profile unavailable"); });
      await test.render();
      await waitFor(() => Boolean(test.container.querySelector('[role="alert"]')), "initial load must show an error");
      check(test.container.querySelector("h1")?.textContent === "暂时无法打开主页", "failed load must leave loading state");
      check(test.container.querySelector("dialog")?.open, "failure must remain in an accessible closable dialog");
      await test.tick();
      check(test.profileReads.length === 1 && test.notices.length === 0, "initial failure must not keep retrying or spam notices");
      await test.click("关闭主页");
      check(test.closeCount() === 1, "failed profile can be dismissed");
      test.setProfileRead(async (id) => profileFixture(id));
      await test.click("重新加载");
      await waitFor(() => test.container.querySelector("h1")?.textContent === "Agent A", "retry must recover the profile");
      check(!test.container.querySelector('[role="alert"]'), "successful retry clears the failure");
      check(document.activeElement === test.button("关闭主页"), "recovery must replace the removed loading control with a focusable close action");
    }
  },
  {
    name: "profile refresh failure keeps post and status drafts and slow reads are not restarted by polling",
    async run(test) {
      await test.render();
      await test.fill("分享一点正在发生的事...", "Unsaved post");
      await test.click("编辑近况");
      await test.fill("一句近况", "Unsaved status");
      test.field("一句近况").focus();
      const pending = deferred<AgentProfile>();
      test.setProfileRead(() => pending.promise);
      await test.tick();
      await test.tick();
      check(test.profileReads.length === 2, "slow refresh must finish instead of being superseded every three seconds");
      await act(async () => pending.reject(new Error("Refresh interrupted")));
      check(test.container.querySelector("h1")?.textContent === "Agent A", "last good profile must remain visible");
      check(test.field("分享一点正在发生的事...").value === "Unsaved post" && test.field("一句近况").value === "Unsaved status", "refresh errors must preserve drafts");
      check(test.notices.length === 0, "background refresh errors belong in the local status message");
      test.setProfileRead(async (id) => profileFixture(id));
      await test.click("重试更新");
      check(!test.container.querySelector(".agent-profile-recovery"), "retry clears the refresh error");
      check(test.field("一句近况").value === "Unsaved status", "successful refresh must not overwrite an edit");
      check(document.activeElement === test.field("一句近况"), "background refresh must keep focus in the current draft");
    }
  },
  {
    name: "profile chat failure retries in place, retains its draft and stops polling when closed",
    async run(test) {
      test.setMessageRead(async () => { throw new Error("Messages unavailable"); });
      await test.render();
      await test.click("消息");
      await test.fill("发消息给 Agent A", "Unsent chat draft");
      check(test.container.querySelector(".agent-profile-chat [role=alert]")?.textContent?.includes("Messages unavailable"), "chat failure must offer a visible error");
      test.setMessageRead(async () => []);
      await test.click("重试会话");
      check(test.field("发消息给 Agent A").value === "Unsent chat draft", "retry must retain the chat draft");
      check(!test.container.querySelector(".agent-profile-chat [role=alert]"), "retry clears the chat error");
      await test.click("关闭会话");
      const before = test.messageReadCount();
      await test.tick();
      check(test.messageReadCount() === before, "closed chat must not poll messages");
      await test.click("消息");
      check(test.field("发消息给 Agent A").value === "Unsent chat draft", "reopening chat restores its draft");
    }
  },
  {
    name: "closing profile chat while it loads prevents a late reopen or read receipt",
    async run(test) {
      const pending = deferred<ConversationSummary>();
      test.setConversationRead(() => pending.promise);
      await test.render();
      await test.click("消息");
      check(test.container.querySelector(".agent-profile-chat [role=status]"), "opening chat displays loading feedback immediately");
      await test.click("关闭会话");
      await act(async () => pending.resolve({ id: "late-chat", kind: "human_agent", title: "late", participants: [], unreadCount: 0, createdAt: timestamp }));
      check(!test.container.querySelector(".agent-profile-chat"), "late response must not reopen the chat");
      check(test.messageReadCount() === 0 && test.receipts.length === 0, "cancelled open must not request messages or mark them read");
    }
  },
  {
    name: "switching profiles resets drafts and a previous publish cannot clear the new profile draft",
    async run(test) {
      const pending = deferred<Awaited<ReturnType<typeof api.createAgentPost>>>();
      test.setCreatePost(() => pending.promise);
      await test.render();
      await test.fill("分享一点正在发生的事...", "Post for A");
      await test.click("发布");
      await test.render("agent-b");
      check(test.field("分享一点正在发生的事...").value === "", "a new profile must not inherit another profile's draft");
      await test.fill("分享一点正在发生的事...", "Draft for B");
      await act(async () => pending.reject(new Error("Old post failed")));
      check(test.field("分享一点正在发生的事...").value === "Draft for B", "late mutation cannot modify a new profile draft");
      check(test.notices.length === 0 && test.profileReads.join(",") === "agent-a,agent-b", "old mutation must not notify or reload the new profile");
      check(!test.container.querySelector(".chaq-modal-notice"), "a stale mutation must not leak feedback into the new profile");
    }
  },
  {
    name: "failed profile publishing shows dismissible modal feedback and retains the draft",
    async run(test) {
      test.setCreatePost(async () => { throw new Error("Post could not be saved"); });
      await test.render();
      await test.fill("分享一点正在发生的事...", "Keep my unfinished post");
      await test.fill("心情", "Hopeful");
      await test.click("发布");
      const dialog = test.container.querySelector("dialog")!;
      const feedback = dialog.querySelector<HTMLElement>(".chaq-modal-notice");
      check(dialog.matches(":modal") && feedback?.textContent?.includes("Post could not be saved") && feedback.getClientRects().length, "publish errors must be visible within the native modal");
      check(test.notices.join() === "Post could not be saved", "modal feedback must preserve the existing notice callback");
      await test.click("关闭提示");
      check(dialog.open && !dialog.querySelector(".chaq-modal-notice"), "dismissing an error must retain the open profile");
      check(test.field("分享一点正在发生的事...").value === "Keep my unfinished post" && test.field("心情").value === "Hopeful", "failed publishing and notice dismissal must preserve every draft field");
      await test.click("发布");
      await test.render("agent-b");
      check(!test.container.querySelector(".chaq-modal-notice"), "switching profiles must clear the previous profile's notice");
    }
  },
  {
    name: "a delayed post success keeps edits made while publishing",
    async run(test) {
      const pending = deferred<Awaited<ReturnType<typeof api.createAgentPost>>>();
      test.setCreatePost(() => pending.promise);
      await test.render();
      await test.fill("分享一点正在发生的事...", "Submitted post");
      await test.click("发布");
      await test.fill("分享一点正在发生的事...", "Next post draft");
      await test.fill("心情", "New mood");
      await act(async () => pending.resolve({ id: "published", agentId: "agent-a", content: "Submitted post", mood: "", location: "", visibility: "public", mediaUrls: [], pinned: false, reactionCount: 0, commentCount: 0, likedByViewer: false, comments: [], createdAt: timestamp, updatedAt: timestamp }));
      check(test.field("分享一点正在发生的事...").value === "Next post draft" && test.field("心情").value === "New mood", "publishing must clear only the submitted values");
      check(test.notices.includes("动态已发布"), "successful publishing should acknowledge completion");
      check(test.container.querySelector(".chaq-modal-notice")?.textContent?.includes("动态已发布"), "successful publishing must acknowledge completion inside the open modal");
    }
  },
  {
    name: "profile selection and unmount reject stale loads and release polling",
    async run(test) {
      const old = deferred<AgentProfile>();
      const latest = deferred<AgentProfile>();
      test.setProfileRead((id) => id === "agent-a" ? old.promise : Promise.resolve(profileFixture(id)));
      await test.render();
      await test.render("agent-b");
      await act(async () => old.resolve(profileFixture("agent-a")));
      check(test.container.querySelector("h1")?.textContent === "Agent B", "a slow old profile must not replace the current one");
      test.setProfileRead(() => latest.promise);
      await test.tick();
      await test.unmount();
      await act(async () => latest.reject(new Error("Late unmounted failure")));
      check(test.timerCount() === 0 && !test.container.childElementCount && test.notices.length === 0, "unmount must release timers and suppress late errors");
    }
  }
];

export async function runProfileLifecycleCases(): Promise<Result[]> {
  const results: Result[] = [];
  for (const entry of cases) {
    const test = fixture();
    try {
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
