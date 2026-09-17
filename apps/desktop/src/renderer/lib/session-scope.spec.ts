import assert from "node:assert/strict";
import test from "node:test";
import { SupersededRequestError } from "./latest-request";
import { SessionScope, type AuthSession } from "./session-scope";

function session(id: string): AuthSession {
  return {
    user: { id, username: id, displayName: id, role: "USER", tokenBalance: 100, createdAt: "2026-01-01T00:00:00.000Z" },
    settings: {
      id: `settings-${id}`, userId: id, language: "zh", theme: "system",
      backgroundOpacity: 1, windowOpacity: 1, notificationSound: true, iconFlash: true
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

const transitions = [
  { name: "logout", run: (scope: SessionScope) => { scope.end(); } },
  { name: "switching accounts", run: (scope: SessionScope) => { scope.activate(session("bob")); } },
  { name: "logging in to the same account again", run: (scope: SessionScope) => { scope.activate(session("alice")); } }
];

for (const transition of transitions) {
  for (const outcome of ["success", "failure"] as const) {
    test(`an old request ${outcome} is rejected after ${transition.name}`, async () => {
      const scope = new SessionScope();
      scope.activate(session("alice"));
      const response = deferred<string>();
      const api = scope.bind({ read: () => response.promise }, scope.getSnapshot().generation);
      const pending = api.read();
      transition.run(scope);
      const active = scope.getSnapshot();
      const rejected = assert.rejects(pending, SupersededRequestError);
      if (outcome === "success") response.resolve("alice's private response");
      else response.reject(new Error("alice's request failed"));
      await rejected;
      assert.equal(scope.getSnapshot(), active);
    });
  }

  test(`an old bound API cannot start another operation after ${transition.name}`, async () => {
    const scope = new SessionScope();
    scope.activate(session("alice"));
    let calls = 0;
    const api = scope.bind({ mutate: async () => { calls += 1; } }, scope.getSnapshot().generation);
    transition.run(scope);
    await assert.rejects(api.mutate(), SupersededRequestError);
    assert.equal(calls, 0);
  });
}

test("the active session receives ordinary successes and the original request error", async () => {
  const scope = new SessionScope();
  scope.activate(session("alice"));
  const error = new Error("The active request failed");
  const api = scope.bind({
    read: async () => "current response",
    fail: async () => { throw error; }
  }, scope.getSnapshot().generation);
  assert.equal(await api.read(), "current response");
  await assert.rejects(api.fail(), (received) => received === error);
});

test("a late account refresh cannot revive a logged-out session or run its updater", () => {
  const scope = new SessionScope();
  scope.activate(session("alice"));
  const generation = scope.getSnapshot().generation;
  assert.equal(scope.end(), "alice");
  const loggedOut = scope.getSnapshot();
  let updaterCalls = 0;
  scope.update(generation, () => { updaterCalls += 1; return session("alice"); });
  scope.update(generation, session("alice"));
  scope.update(loggedOut.generation, session("alice"));
  assert.equal(updaterCalls, 0);
  assert.equal(scope.getSnapshot(), loggedOut);
  assert.equal(scope.getSnapshot().auth, null);
});

test("stale and cross-account updates cannot replace the new account", () => {
  const scope = new SessionScope();
  scope.activate(session("alice"));
  const oldGeneration = scope.getSnapshot().generation;
  scope.activate(session("bob"));
  const active = scope.getSnapshot();
  scope.update(oldGeneration, session("alice"));
  scope.update(active.generation, session("alice"));
  scope.update(active.generation, () => session("alice"));
  scope.update(active.generation, () => null);
  assert.equal(scope.getSnapshot(), active);
  scope.update(active.generation, (current) => current && {
    ...current, user: { ...current.user, tokenBalance: 75 }
  });
  assert.equal(scope.getSnapshot().auth?.user.id, "bob");
  assert.equal(scope.getSnapshot().auth?.user.tokenBalance, 75);
  assert.equal(scope.getSnapshot().generation, active.generation);
});

test("refreshes from a previous login cannot overwrite the same account's new session", () => {
  const scope = new SessionScope();
  scope.activate(session("alice"));
  const oldGeneration = scope.getSnapshot().generation;
  const next = session("alice");
  next.user.tokenBalance = 500;
  scope.activate(next);
  scope.update(oldGeneration, session("alice"));
  assert.equal(scope.getSnapshot().auth?.user.tokenBalance, 500);
});
