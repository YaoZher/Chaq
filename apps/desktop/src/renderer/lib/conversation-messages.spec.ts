import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "@chaq/shared";
import { ConversationMessages } from "./conversation-messages";
import { isSupersededRequest } from "./latest-request";
import { PendingMessageKey } from "./message-idempotency";

function message(id: string, second: number, conversationId = "chat-a"): ConversationMessage {
  return { id, conversationId, authorKind: "user", authorId: "viewer", kind: "text", content: id, status: "delivered", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

test("a late poll preserves realtime and send arrivals and orders them once by message ID", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const snapshot = deferred<ConversationMessage[]>();
  const loading = resource.load(selection, () => snapshot.promise);
  const reply = { ...message("reply", 3), authorKind: "agent" as const };
  assert.equal(resource.receiveRealtime({ type: "conversation.message", payload: reply }), true);
  resource.receive(selection, message("sent", 2));
  resource.receiveRealtime({ type: "conversation.message", payload: message("sent", 2) });
  snapshot.resolve([message("older", 1)]);
  await loading;
  assert.deepEqual(resource.getSnapshot().map((row) => row.id), ["older", "sent", "reply"]);
});

test("a send response is deduplicated when a poll already observed the committed message", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const sent = message("sent", 1);
  await resource.load(selection, async () => [sent]);
  resource.receive(selection, sent);
  assert.deepEqual(resource.getSnapshot(), [sent]);
});

test("an older snapshot cannot replace a newer completed poll even if its transport ignores cancellation", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const slow = deferred<ConversationMessage[]>();
  let signal!: AbortSignal;
  const first = resource.load(selection, (requestSignal) => { signal = requestSignal; return slow.promise; });
  await resource.load(selection, async () => [message("newer", 2)]);
  assert.equal(signal.aborted, true);
  await first;
  slow.resolve([message("older", 1)]);
  await Promise.resolve();
  assert.deepEqual(resource.getSnapshot().map((row) => row.id), ["newer"]);
});

test("switching away and back rejects old loads and send replies for the same conversation ID", async () => {
  const resource = new ConversationMessages();
  const oldSelection = resource.select("chat-a")!;
  const slow = deferred<ConversationMessage[]>();
  const first = resource.load(oldSelection, () => slow.promise);
  resource.select("chat-b");
  const currentSelection = resource.select("chat-a")!;
  await assert.rejects(first, isSupersededRequest);
  assert.equal(oldSelection.signal.aborted, true);
  assert.equal(resource.receive(oldSelection, message("late-send", 1)), false);
  await resource.load(currentSelection, async () => [message("current", 2)]);
  slow.resolve([message("stale-poll", 1)]);
  await Promise.resolve();
  assert.deepEqual(resource.getSnapshot().map((row) => row.id), ["current"]);
});

test("arrivals survive missing snapshots until confirmed, then follow the server's bounded history", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const sent = message("sent", 2);
  resource.receive(selection, sent);
  await resource.load(selection, async () => [message("older", 1)]);
  await resource.load(selection, async () => [message("older", 1)]);
  assert.deepEqual(resource.getSnapshot().map((row) => row.id), ["older", "sent"]);
  await resource.load(selection, async () => [sent, message("next", 3)]);
  await resource.load(selection, async () => [message("next", 3)]);
  assert.deepEqual(resource.getSnapshot().map((row) => row.id), ["next"]);
});

test("a snapshot started before a realtime update cannot roll its status back", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const snapshot = deferred<ConversationMessage[]>();
  const loading = resource.load(selection, () => snapshot.promise);
  const read = { ...message("sent", 1), status: "read" as const };
  resource.receive(selection, read);
  snapshot.resolve([message("sent", 1)]);
  await loading;
  assert.deepEqual(resource.getSnapshot(), [read]);
});

test("failed refreshes preserve messages and an unchanged retry can merge the server's same message", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const attempts = new PendingMessageKey(() => "attempt-0001");
  const firstKey = attempts.begin("chat-a", "hello");
  const committed = { ...message("sent", 1), content: "hello" };
  resource.receiveRealtime({ type: "conversation.message", payload: committed });
  await assert.rejects(resource.load(selection, async () => { throw new Error("offline"); }), /offline/);
  const retryKey = attempts.begin("chat-a", "hello");
  assert.equal(retryKey, firstKey);
  resource.receive(selection, committed);
  attempts.succeeded(retryKey);
  assert.deepEqual(resource.getSnapshot(), [committed]);
  assert.equal(attempts.matches("chat-a", "hello"), false);
});

test("snapshots and realtime events cannot introduce another conversation's messages", async () => {
  const resource = new ConversationMessages();
  const selection = resource.select("chat-a")!;
  const mine = message("mine", 1);
  const other = message("other", 2, "chat-b");
  await resource.load(selection, async () => [mine, mine, other]);
  assert.equal(resource.receive(selection, other), false);
  assert.equal(resource.receiveRealtime({ type: "conversation.message", payload: other }), false);
  assert.equal(resource.receiveRealtime({ type: "conversation.message", payload: { id: "incomplete", conversationId: "chat-a", content: "x" } }), false);
  assert.equal(resource.receiveRealtime({ type: "realtime.heartbeat", payload: mine }), false);
  assert.deepEqual(resource.getSnapshot(), [mine]);
  resource.select(null);
  assert.deepEqual(resource.getSnapshot(), []);
  assert.equal(resource.receiveRealtime({ type: "conversation.message", payload: mine }), false);
});
