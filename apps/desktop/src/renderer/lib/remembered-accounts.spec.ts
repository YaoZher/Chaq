import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRememberedAccounts, saveRememberedAccounts, upsertRememberedAccount,
  RememberedCredentialWrites, type RememberedAccount, type RememberedCredential
} from "./remembered-accounts";

function account(id: string): RememberedAccount {
  return {
    expiresAt: "2999-01-01T00:00:00.000Z",
    user: { id, username: id, displayName: id, role: "USER", tokenBalance: 100, createdAt: "2026-01-01T00:00:00.000Z" },
    settings: {
      id: `settings-${id}`, userId: id, language: "zh", theme: "system",
      backgroundOpacity: 1, windowOpacity: 1, notificationSound: true, iconFlash: true
    }
  };
}

function storageFixture(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("chaq.rememberedAccounts", initial);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function credential(sessionToken: string): RememberedCredential {
  return { accountId: "alice", sessionToken, expiresAt: "2999-01-01T00:00:00.000Z" };
}

test("remembered account metadata never persists the login result's plaintext token", () => {
  const storage = storageFixture();
  const loginResult = { ...account("alice"), sessionToken: "secret-current-token" };
  saveRememberedAccounts(storage, [loginResult]);
  const saved = storage.getItem("chaq.rememberedAccounts")!;
  assert.equal(saved.includes("secret-current-token"), false);
  assert.equal(saved.includes("sessionToken"), false);
  assert.deepEqual(loadRememberedAccounts(storage), { accounts: [account("alice")], legacySessions: [] });
});

test("legacy credentials are separated for migration and disappear when metadata is rewritten", () => {
  const storage = storageFixture(JSON.stringify([{ ...account("alice"), sessionToken: "secret-legacy-token" }]));
  const loaded = loadRememberedAccounts(storage);
  assert.deepEqual(loaded.accounts, [account("alice")]);
  assert.deepEqual(loaded.legacySessions, [credential("secret-legacy-token")]);
  assert.equal(JSON.stringify(loaded.accounts).includes("secret-legacy-token"), false);
  saveRememberedAccounts(storage, loaded.accounts);
  assert.equal(storage.getItem("chaq.rememberedAccounts")!.includes("secret-legacy-token"), false);
  assert.deepEqual(loadRememberedAccounts(storage).legacySessions, []);
});

test("remembered accounts keep the six most recent unique accounts and refresh an existing account", () => {
  let accounts: RememberedAccount[] = [];
  for (let index = 0; index < 8; index += 1) accounts = upsertRememberedAccount(accounts, account(`user-${index}`));
  const refreshed = account("user-4");
  refreshed.user.displayName = "Updated account";
  accounts = upsertRememberedAccount(accounts, refreshed);
  const storage = storageFixture();
  saveRememberedAccounts(storage, accounts);
  assert.deepEqual(loadRememberedAccounts(storage).accounts.map((item) => item.user.id), [
    "user-4", "user-7", "user-6", "user-5", "user-3", "user-2"
  ]);
  assert.equal(loadRememberedAccounts(storage).accounts[0].user.displayName, "Updated account");
});

test("malformed stored metadata is ignored without preventing account selection", () => {
  for (const value of ["not-json", "null", "{}", "[null,12,{},false]"]) {
    assert.deepEqual(loadRememberedAccounts(storageFixture(value)), { accounts: [], legacySessions: [] });
  }
  assert.deepEqual(loadRememberedAccounts(storageFixture(JSON.stringify([null, {}, account("alice")]))).accounts, [account("alice")]);
});

test("logout deletion waits for an in-flight credential save and leaves no saved session", async () => {
  const saveStarted = deferred();
  const finishSave = deferred();
  const calls: string[] = [];
  const saved = new Map<string, string>();
  const writes = new RememberedCredentialWrites({
    saveRememberedSession: async (value) => {
      calls.push("save-start");
      saveStarted.resolve();
      await finishSave.promise;
      saved.set(value.accountId, value.sessionToken);
      calls.push("save-end");
    },
    deleteRememberedSession: async (id) => { calls.push("delete"); saved.delete(id); }
  });
  const save = writes.save(credential("old-token"));
  await saveStarted.promise;
  const logout = writes.delete("alice");
  await Promise.resolve();
  assert.deepEqual(calls, ["save-start"]);
  finishSave.resolve();
  await Promise.all([save, logout]);
  assert.deepEqual(calls, ["save-start", "save-end", "delete"]);
  assert.equal(saved.has("alice"), false);
});

test("a new login queued after logout keeps its newer credential", async () => {
  const finishSave = deferred();
  const calls: string[] = [];
  let saved: string | null = null;
  const writes = new RememberedCredentialWrites({
    saveRememberedSession: async (value) => {
      if (value.sessionToken === "old-token") await finishSave.promise;
      saved = value.sessionToken;
      calls.push(value.sessionToken);
    },
    deleteRememberedSession: async () => { saved = null; calls.push("delete"); }
  });
  const oldLogin = writes.save(credential("old-token"));
  const logout = writes.delete("alice");
  const newLogin = writes.save(credential("new-token"));
  finishSave.resolve();
  await Promise.all([oldLogin, logout, newLogin]);
  assert.deepEqual(calls, ["old-token", "delete", "new-token"]);
  assert.equal(saved, "new-token");
});

test("a failed credential save is reported but does not block logout deletion", async () => {
  const error = new Error("Secure storage is unavailable");
  let deleted = false;
  const writes = new RememberedCredentialWrites({
    saveRememberedSession: async () => { throw error; },
    deleteRememberedSession: async () => { deleted = true; }
  });
  const failed = assert.rejects(writes.save(credential("token")), (received) => received === error);
  await writes.delete("alice");
  await failed;
  assert.equal(deleted, true);
});

test("a failed credential deletion does not block a later login save", async () => {
  const error = new Error("Credential deletion failed");
  let saved: RememberedCredential | null = null;
  const writes = new RememberedCredentialWrites({
    saveRememberedSession: async (value) => { saved = value; },
    deleteRememberedSession: async () => { throw error; }
  });
  const failed = assert.rejects(writes.delete("alice"), (received) => received === error);
  await writes.save(credential("new-token"));
  await failed;
  assert.deepEqual(saved, credential("new-token"));
});
