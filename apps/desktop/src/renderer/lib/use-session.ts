import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { LatestRequestGate, isSupersededRequest, type LatestRequestToken } from "./latest-request";
import {
  loadRememberedAccounts,
  saveRememberedAccounts,
  upsertRememberedAccount,
  RememberedCredentialWrites,
  type RememberedAccount
} from "./remembered-accounts";
import { SessionScope } from "./session-scope";

type LoginResult = Awaited<ReturnType<typeof api.login>>;

export function useSession(utilityWindow: boolean) {
  const [scope] = useState(() => new SessionScope());
  const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot);
  const [credentialWrites] = useState(() => new RememberedCredentialWrites(window.chaq.auth));
  const requests = useRef(new LatestRequestGate());
  const pendingAccountId = useRef<string | null>(null);
  const accountsRef = useRef<RememberedAccount[]>([]);
  const [rememberedAccounts, setAccounts] = useState<RememberedAccount[]>([]);
  const [selectedRememberedId, setSelectedRememberedId] = useState<string | null>(null);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [notice, setNotice] = useState("");
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);

  function storeAccounts(accounts: RememberedAccount[]): void {
    accountsRef.current = accounts;
    saveRememberedAccounts(localStorage, accounts);
    setAccounts(accounts);
  }

  function removeAccount(accountId: string): void {
    const accounts = accountsRef.current.filter((account) => account.user.id !== accountId);
    storeAccounts(accounts);
    setSelectedRememberedId(accounts[0]?.user.id ?? null);
    setShowAccountForm(accounts.length === 0);
  }

  async function applyLoggedOutState(deferWindowClose = false): Promise<void> {
    const accountId = scope.getSnapshot().auth?.user.id ?? pendingAccountId.current;
    requests.current.cancel();
    pendingAccountId.current = null;
    localStorage.removeItem("chaq.sessionToken");
    sessionStorage.removeItem("chaq.sessionToken");
    scope.end();
    setBusy(false);
    setBooting(false);
    setLoginError("");
    setNotice("");
    if (!utilityWindow && accountId) removeAccount(accountId);
    // Invoke window cleanup immediately. A later login must not be resized by a
    // delayed credential deletion or logout network response.
    const windowCleanup = utilityWindow
      ? deferWindowClose ? Promise.resolve() : window.chaq.window.close()
      : window.chaq.window.setMode("login");
    const credentialCleanup = !utilityWindow && accountId
      ? credentialWrites.delete(accountId).catch(() => undefined)
      : Promise.resolve();
    await Promise.allSettled([windowCleanup, credentialCleanup]);
  }

  useEffect(() => {
    const unsubscribe = window.chaq.auth.onLoggedOut(() => { void applyLoggedOutState(); });
    void restoreSession();
    return () => {
      unsubscribe();
      requests.current.cancel();
      scope.end();
    };
  }, [scope, credentialWrites, utilityWindow]);

  async function restoreSession(): Promise<void> {
    const request = requests.current.begin("restore");
    const guard = <T,>(operation: Promise<T>) => requests.current.guard(request, operation);
    try {
      if (utilityWindow) {
        const token = await guard(window.chaq.auth.consumeWindowBootstrap());
        if (token) sessionStorage.setItem("chaq.sessionToken", token);
        if (!token && !sessionStorage.getItem("chaq.sessionToken")) {
          setLoginError("窗口授权已失效，请关闭后从主窗口重新打开。");
          return;
        }
        const [user, settings] = await guard(Promise.all([api.me(), api.settings()]));
        scope.activate({ user, settings });
        return;
      }

      await guard(window.chaq.window.setMode("login"));
      const loaded = loadRememberedAccounts(localStorage);
      let accounts = loaded.accounts;
      // Remove plaintext legacy credentials before attempting vault migration.
      storeAccounts(accounts);
      let migrationError = "";
      for (const legacy of loaded.legacySessions) {
        pendingAccountId.current = legacy.accountId;
        try {
          await guard(credentialWrites.save(legacy));
        } catch (error) {
          if (!requests.current.isCurrent(request)) return;
          migrationError = messageOf(error);
        }
      }
      const legacyToken = localStorage.getItem("chaq.sessionToken");
      localStorage.removeItem("chaq.sessionToken");
      if (legacyToken) {
        sessionStorage.setItem("chaq.sessionToken", legacyToken);
        try {
          const [user, settings] = await guard(Promise.all([api.me(), api.settings()]));
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          pendingAccountId.current = user.id;
          await guard(credentialWrites.save({ accountId: user.id, sessionToken: legacyToken, expiresAt }));
          accounts = upsertRememberedAccount(accounts, { expiresAt, user, settings });
        } catch (error) {
          if (!requests.current.isCurrent(request)) return;
          migrationError = messageOf(error);
        }
      }
      sessionStorage.removeItem("chaq.sessionToken");
      storeAccounts(accounts);
      setSelectedRememberedId(accounts[0]?.user.id ?? null);
      setShowAccountForm(accounts.length === 0);
      if (migrationError) setLoginError(`旧登录状态未能安全迁移，请重新登录。${migrationError}`);
    } catch (error) {
      if (requests.current.isCurrent(request) && !isSupersededRequest(error)) setLoginError(messageOf(error));
    } finally {
      if (requests.current.isCurrent(request)) {
        pendingAccountId.current = null;
        setBooting(false);
      }
    }
  }

  async function finishLogin(request: LatestRequestToken, result: LoginResult, remember: boolean): Promise<void> {
    if (!requests.current.isCurrent(request)) return;
    pendingAccountId.current = result.user.id;
    sessionStorage.setItem("chaq.sessionToken", result.sessionToken);
    try {
      if (remember) {
        await requests.current.guard(request, credentialWrites.save({
          accountId: result.user.id, sessionToken: result.sessionToken, expiresAt: result.expiresAt
        }));
        storeAccounts(upsertRememberedAccount(accountsRef.current, {
          expiresAt: result.expiresAt, user: result.user, settings: result.settings
        }));
        setSelectedRememberedId(result.user.id);
      } else {
        await requests.current.guard(request, credentialWrites.delete(result.user.id));
        removeAccount(result.user.id);
      }
    } catch (error) {
      if (!requests.current.isCurrent(request)) return;
      setNotice(`已登录，但无法更新本机的记住账号设置：${messageOf(error)}`);
    }
    await requests.current.guard(request, window.chaq.window.setMode("main"));
    await requests.current.guard(request, window.chaq.window.setOpacity(result.settings.windowOpacity));
    pendingAccountId.current = null;
    scope.activate({ user: result.user, settings: result.settings });
  }

  async function authenticate(operation: () => Promise<LoginResult>, remember: boolean, rememberedId?: string): Promise<void> {
    const request = requests.current.begin("login");
    if (pendingAccountId.current) void credentialWrites.delete(pendingAccountId.current).catch(() => undefined);
    pendingAccountId.current = null;
    sessionStorage.removeItem("chaq.sessionToken");
    if (scope.getSnapshot().auth) scope.end();
    setLoginError("");
    setBusy(true);
    try {
      const result = await requests.current.guard(request, operation());
      await finishLogin(request, result, remember);
    } catch (error) {
      if (!requests.current.isCurrent(request) || isSupersededRequest(error)) return;
      sessionStorage.removeItem("chaq.sessionToken");
      if (rememberedId && error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        removeAccount(rememberedId);
        setShowAccountForm(true);
        void credentialWrites.delete(rememberedId).catch(() => undefined);
        setLoginError(`登录状态已失效，请重新输入账号密码。${messageOf(error)}`);
      } else {
        setLoginError(messageOf(error));
      }
    } finally {
      if (requests.current.isCurrent(request)) {
        pendingAccountId.current = null;
        setBooting(false);
        setBusy(false);
      }
    }
  }

  async function loginWithRemembered(accountId: string): Promise<void> {
    // Capture the generation before reading the vault so a late read cannot
    // install a credential after another login or a logout broadcast.
    await authenticate(async () => {
      const request = requests.current.snapshot();
      const credential = await window.chaq.auth.getRememberedSession(accountId);
      if (!requests.current.isCurrent(request)) throw new ApiError("登录请求已取消。", 409);
      if (!credential) throw new ApiError("登录状态已过期。", 401);
      pendingAccountId.current = accountId;
      sessionStorage.setItem("chaq.sessionToken", credential.sessionToken);
      const [user, settings] = await Promise.all([api.me(), api.settings()]);
      return { ...credential, user, settings };
    }, true, accountId);
  }

  async function logout(): Promise<void> {
    // Start revocation while the old credential is still available to request().
    const revocation = api.logout().catch(() => undefined);
    // A utility window must stay alive until its own revocation and broadcast
    // finish. Incoming broadcasts can still close other utility windows at once.
    const cleanup = applyLoggedOutState(utilityWindow);
    await Promise.allSettled([revocation, cleanup, window.chaq.auth.broadcastLogout()]);
    if (utilityWindow) await window.chaq.window.close();
  }

  return {
    ...snapshot, scope, booting, busy, notice, loginError, setLoginError,
    rememberedAccounts, selectedRememberedId, setSelectedRememberedId,
    showAccountForm, setShowAccountForm,
    login: (payload: Parameters<typeof api.login>[0], remember: boolean) => authenticate(() => api.login(payload), remember),
    register: (payload: Parameters<typeof api.register>[0], remember: boolean) => authenticate(() => api.register(payload), remember),
    loginWithRemembered, logout
  };
}

export type SessionState = ReturnType<typeof useSession>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
