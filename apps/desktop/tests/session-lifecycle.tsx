/// <reference path="../src/renderer/vite-env.d.ts" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChaqApi } from "../src/preload";
import { api } from "../src/renderer/lib/api";
import { isSupersededRequest } from "../src/renderer/lib/latest-request";
import { loadRememberedAccounts, saveRememberedAccounts, type RememberedCredential } from "../src/renderer/lib/remembered-accounts";
import { useSession, type SessionState } from "../src/renderer/lib/use-session";
import { runWorkspaceLifecycleCases } from "./workspace-lifecycle";
import { runSettingsLifecycleCases } from "./settings-lifecycle";

type Result = { name: string; passed: boolean; error?: string };
declare global {
  interface Window {
    sessionTest: { complete(results: Result[]): void };
  }
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function loginResult(id: string): Awaited<ReturnType<typeof api.login>> {
  return {
    sessionToken: `test-session-${id}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id,
      username: id,
      displayName: `User ${id}`,
      role: "USER",
      tokenBalance: 100,
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    settings: {
      id: `settings-${id}`,
      userId: id,
      language: "en",
      theme: "light",
      backgroundOpacity: 1,
      windowOpacity: 0.9,
      notificationSound: false,
      iconFlash: false
    }
  };
}

const accountA = loginResult("account-a");
const accountB = loginResult("account-b");
type Options = { utility?: boolean; remembered?: Array<typeof accountA> };

function fixture(options: Options = {}) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const saved = new Map<string, RememberedCredential>();
  const listeners = new Set<() => void>();
  const modes: string[] = [];
  const vaultEvents: string[] = [];
  const calls: Array<{ path: string; token: string | null }> = [];
  const pendingFetches = new Map<string, ReturnType<typeof deferred<Response>>[]>();
  const originalLocal = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  const originalSession = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  const originalFetch = window.fetch;
  let sessionState: SessionState | null = null;
  let closes = 0;
  let broadcasts = 0;
  let saveBarrier: Promise<void> | null = null;
  let mounted = false;
  saveRememberedAccounts(local, options.remembered ?? []);
  for (const account of options.remembered ?? []) {
    saved.set(account.user.id, { accountId: account.user.id, sessionToken: account.sessionToken, expiresAt: account.expiresAt });
  }
  Object.defineProperty(window, "localStorage", { configurable: true, value: local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });

  function emitLogout() {
    for (const callback of listeners) callback();
  }

  window.chaq = {
    auth: {
      onLoggedOut: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
      // The Electron main process delivers broadcasts to other windows only.
      broadcastLogout: async () => { broadcasts += 1; },
      consumeWindowBootstrap: async () => options.utility ? accountA.sessionToken : null,
      saveRememberedSession: async (value: RememberedCredential) => {
        vaultEvents.push(`save-start:${value.accountId}`);
        if (saveBarrier) await saveBarrier;
        saved.set(value.accountId, value);
        vaultEvents.push(`save-end:${value.accountId}`);
      },
      deleteRememberedSession: async (accountId: string) => {
        saved.delete(accountId);
        vaultEvents.push(`delete:${accountId}`);
      },
      getRememberedSession: async (accountId: string) => saved.get(accountId) ?? null
    },
    window: {
      setMode: async (mode: string) => { modes.push(mode); },
      setOpacity: async () => undefined,
      close: async () => { closes += 1; }
    }
  } as unknown as ChaqApi;

  window.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname.replace(/^\/api/, "");
    const token = new Headers(init?.headers).get("x-session-token");
    calls.push({ path: pathname, token });
    const pending = pendingFetches.get(pathname)?.shift();
    if (pending) return pending.promise;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const account = token === accountB.sessionToken || payload.username === accountB.user.username ? accountB : accountA;
    if (pathname === "/auth/login") return response(account);
    if (pathname === "/auth/logout") return response({ ok: true });
    if (pathname === "/users/me") return response(account.user);
    if (pathname === "/users/me/settings") return response(account.settings);
    throw new Error(`Unexpected fixture request: ${pathname}`);
  };

  function Harness() {
    sessionState = useSession(Boolean(options.utility));
    return <output data-session-state>{sessionState.booting ? "booting" : sessionState.auth?.user.id ?? "signed-out"}</output>;
  }

  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  return {
    local, session, saved, modes, vaultEvents, calls,
    state: () => { check(sessionState, "hook must be mounted"); return sessionState; },
    metadataIds: () => loadRememberedAccounts(local).accounts.map((account) => account.user.id),
    closeCount: () => closes,
    broadcastCount: () => broadcasts,
    listenerCount: () => listeners.size,
    holdSaves: (promise: Promise<void> | null) => { saveBarrier = promise; },
    deferFetch: (pathname: string) => {
      const pending = deferred<Response>();
      const queue = pendingFetches.get(pathname) ?? [];
      queue.push(pending);
      pendingFetches.set(pathname, queue);
      return pending;
    },
    broadcast: () => act(async () => { emitLogout(); }),
    login: (account: typeof accountA) => act(async () => {
      check(sessionState, "hook must be mounted");
      await sessionState.login({ username: account.user.username, password: "test-password" }, true);
    }),
    mount: async () => {
      await act(async () => { root.render(<Harness />); });
      mounted = true;
      const deadline = Date.now() + 2_000;
      // Response.json() can settle on a later task even when fetch is mocked.
      while (sessionState?.booting && Date.now() < deadline) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
      check(sessionState && !sessionState.booting, "initial restoration must complete");
      check(container.querySelector("[data-session-state]"), "hook must render into a real DOM");
    },
    unmount: async () => {
      if (mounted) await act(async () => { root.unmount(); });
      mounted = false;
      equal(listeners.size, 0, "unmount must remove logout listeners");
    },
    dispose: async () => {
      if (mounted) await act(async () => { root.unmount(); });
      mounted = false;
      container.remove();
      window.fetch = originalFetch;
      Object.defineProperty(window, "localStorage", originalLocal);
      Object.defineProperty(window, "sessionStorage", originalSession);
    }
  };
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

type Fixture = ReturnType<typeof fixture>;
type Case = { name: string; options?: Options; run(test: Fixture): Promise<void> };
const cases: Case[] = [
  {
    name: "mount, login, and logout broadcast clear only the current account credentials",
    options: { remembered: [accountB] },
    async run(test) {
      equal(test.listenerCount(), 1, "mount installs one logout listener");
      await test.login(accountA);
      equal(test.state().auth?.user.id, accountA.user.id, "login activates the account");
      check(test.saved.has(accountA.user.id), "login stores the selected credential");
      await test.broadcast();
      equal(test.state().auth, null, "broadcast clears authentication");
      equal(test.session.getItem("chaq.sessionToken"), null, "broadcast clears active token");
      equal(test.local.getItem("chaq.sessionToken"), null, "broadcast leaves no legacy token");
      check(!test.saved.has(accountA.user.id), "broadcast removes the current vault credential");
      check(test.saved.has(accountB.user.id), "broadcast preserves another account's vault credential");
      equal(test.metadataIds(), [accountB.user.id], "broadcast preserves other account metadata");
      equal(test.modes.at(-1), "login", "broadcast switches to the login window mode");
    }
  },
  {
    name: "a login response arriving after logout cannot restore authentication",
    async run(test) {
      const delayed = test.deferFetch("/auth/login");
      let login!: Promise<void>;
      await act(async () => { login = test.state().login({ username: accountA.user.username, password: "test-password" }, true); });
      check(test.state().busy, "login is pending");
      await test.broadcast();
      await act(async () => { delayed.resolve(response(accountA)); await login; });
      equal(test.state().auth, null, "late login cannot reactivate the scope");
      equal(test.session.getItem("chaq.sessionToken"), null, "late login cannot install its token");
      equal([...test.saved.keys()], [], "late login cannot save a credential");
      check(!test.modes.includes("main"), "late login cannot open the main window");
    }
  },
  {
    name: "an old account refresh cannot write to the session after logout",
    async run(test) {
      await test.login(accountA);
      const previous = test.state();
      const delayed = test.deferFetch("/users/me");
      let rejected = false;
      const request = previous.scope.bind(api, previous.generation).me().then((user) => {
        previous.scope.update(previous.generation, (current) => current && { ...current, user });
      }).catch((error) => { rejected = isSupersededRequest(error); });
      await act(async () => { await test.state().logout(); });
      await act(async () => { delayed.resolve(response({ ...accountA.user, tokenBalance: 999 })); await request; });
      check(rejected, "old refresh is rejected as superseded");
      equal(test.state().auth, null, "old refresh cannot recreate an auth session");
      equal(test.calls.find((call) => call.path === "/auth/logout")?.token, accountA.sessionToken, "revocation uses the old token before local cleanup");
    }
  },
  {
    name: "a new login remains isolated from an old scope and its delayed refresh",
    async run(test) {
      await test.login(accountA);
      const previous = test.state();
      const oldApi = previous.scope.bind(api, previous.generation);
      const delayed = test.deferFetch("/users/me");
      let rejected = false;
      const refresh = oldApi.me().then((user) => {
        previous.scope.update(previous.generation, (current) => current && { ...current, user });
      }).catch((error) => { rejected = isSupersededRequest(error); });
      await test.broadcast();
      await test.login(accountB);
      const generation = test.state().generation;
      await act(async () => { delayed.resolve(response(accountA.user)); await refresh; });
      check(rejected, "old response is rejected after another account logs in");
      equal(test.state().auth?.user.id, accountB.user.id, "new account stays active");
      equal(test.state().generation, generation, "old response cannot change the new generation");
      equal(test.session.getItem("chaq.sessionToken"), accountB.sessionToken, "new credential remains installed");
      const callsBefore = test.calls.length;
      await oldApi.me().then(() => { throw new Error("an old scope must not start a new request"); }, (error) => {
        check(isSupersededRequest(error), "an old scope rejects before network access");
      });
      equal(test.calls.length, callsBefore, "an old scope cannot make requests with the new token");
      await act(async () => { previous.scope.update(previous.generation, { user: accountA.user, settings: accountA.settings }); });
      equal(test.state().auth?.user.id, accountB.user.id, "old state setters cannot overwrite the new account");
    }
  },
  {
    name: "utility window logout closes the window without clearing remembered account metadata",
    options: { utility: true, remembered: [accountA, accountB] },
    async run(test) {
      const metadata = test.local.getItem("chaq.rememberedAccounts");
      equal(test.state().auth?.user.id, accountA.user.id, "utility bootstrap restores its scoped session");
      await test.broadcast();
      equal(test.state().auth, null, "utility broadcast clears authentication");
      equal(test.session.getItem("chaq.sessionToken"), null, "utility broadcast clears its token");
      equal(test.closeCount(), 1, "utility window closes");
      equal(test.local.getItem("chaq.rememberedAccounts"), metadata, "utility logout leaves metadata unchanged");
      equal([...test.saved.keys()], [accountA.user.id, accountB.user.id], "utility logout leaves the account vault unchanged");
    }
  },
  {
    name: "utility initiated logout waits for revocation and broadcasts before closing",
    options: { utility: true, remembered: [accountA, accountB] },
    async run(test) {
      const delayed = test.deferFetch("/auth/logout");
      let logout!: Promise<void>;
      await act(async () => { logout = test.state().logout(); });
      equal(test.state().auth, null, "utility clears its visible account immediately");
      equal(test.closeCount(), 0, "utility stays alive while revocation is pending");
      equal(test.broadcastCount(), 1, "other windows are notified before closing");
      equal(test.calls.find((call) => call.path === "/auth/logout")?.token, accountA.sessionToken, "revocation uses the active credential");
      await act(async () => { delayed.resolve(response({ ok: true })); await logout; });
      equal(test.closeCount(), 1, "utility closes only after its request finishes");
      equal(test.metadataIds(), [accountA.user.id, accountB.user.id], "main window remains responsible for account metadata");
    }
  },
  {
    name: "logout deletion follows an in-flight vault save and cannot undo a later login",
    async run(test) {
      const blockedSave = deferred<void>();
      test.holdSaves(blockedSave.promise);
      let oldLogin!: Promise<void>;
      await act(async () => { oldLogin = test.state().login({ username: accountA.user.username, password: "test-password" }, true); });
      check(test.vaultEvents.includes(`save-start:${accountA.user.id}`), "first credential save is pending");
      await test.broadcast();
      equal(test.session.getItem("chaq.sessionToken"), null, "logout clears the token before slow vault cleanup");
      let newLogin!: Promise<void>;
      await act(async () => { newLogin = test.state().login({ username: accountB.user.username, password: "test-password" }, true); });
      test.holdSaves(null);
      await act(async () => { blockedSave.resolve(); await Promise.all([oldLogin, newLogin]); });
      equal(test.state().auth?.user.id, accountB.user.id, "later login succeeds after the stale save finishes");
      equal([...test.saved.keys()], [accountB.user.id], "stale saved credential is deleted before the new credential is saved");
      equal(test.metadataIds(), [accountB.user.id], "metadata belongs only to the active remembered account");
      equal(test.modes.at(-1), "main", "old cleanup cannot resize the later login to login mode");
      check(test.vaultEvents.indexOf(`save-end:${accountA.user.id}`) < test.vaultEvents.indexOf(`delete:${accountA.user.id}`), "deletion is ordered after the stale save");
    }
  },
  {
    name: "unmount removes the broadcast listener and rejects a late login response",
    async run(test) {
      const delayed = test.deferFetch("/auth/login");
      let login!: Promise<void>;
      await act(async () => { login = test.state().login({ username: accountA.user.username, password: "test-password" }, true); });
      const previous = test.state();
      await test.unmount();
      await act(async () => { delayed.resolve(response(accountA)); await login; });
      equal(previous.scope.getSnapshot().auth, null, "unmounted session cannot activate");
      equal(test.session.getItem("chaq.sessionToken"), null, "unmounted login cannot write a credential");
      equal([...test.saved.keys()], [], "unmounted login does not write to the vault");
    }
  }
];

async function main() {
  const results: Result[] = [];
  for (const entry of cases) {
    const test = fixture(entry.options);
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
  results.push(...await runWorkspaceLifecycleCases());
  results.push(...await runSettingsLifecycleCases());
  window.sessionTest.complete(results);
}

main().catch((error) => window.sessionTest.complete([{
  name: "session lifecycle harness",
  passed: false,
  error: error instanceof Error ? error.stack : String(error)
}]));
