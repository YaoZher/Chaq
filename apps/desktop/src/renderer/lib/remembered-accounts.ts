import type { LoginUser, UserSettings } from "./api";

export type RememberedAccount = { expiresAt: string; user: LoginUser; settings: UserSettings };
export type RememberedCredential = { accountId: string; sessionToken: string; expiresAt: string };
type MetadataStorage = Pick<Storage, "getItem" | "setItem">;
type CredentialVault = {
  saveRememberedSession(value: RememberedCredential): Promise<void>;
  deleteRememberedSession(accountId: string): Promise<void>;
};

export function loadRememberedAccounts(storage: MetadataStorage): {
  accounts: RememberedAccount[];
  legacySessions: RememberedCredential[];
} {
  try {
    const parsed: unknown = JSON.parse(storage.getItem("chaq.rememberedAccounts") || "[]");
    if (!Array.isArray(parsed)) return { accounts: [], legacySessions: [] };
    const accounts: RememberedAccount[] = [];
    const legacySessions: RememberedCredential[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const account = value as Partial<RememberedAccount> & { sessionToken?: unknown };
      if (!account.user?.id || !account.settings || typeof account.expiresAt !== "string") continue;
      accounts.push({ expiresAt: account.expiresAt, user: account.user, settings: account.settings });
      if (typeof account.sessionToken === "string" && account.sessionToken) {
        legacySessions.push({ accountId: account.user.id, sessionToken: account.sessionToken, expiresAt: account.expiresAt });
      }
    }
    return { accounts: accounts.slice(0, 6), legacySessions: legacySessions.slice(0, 6) };
  } catch {
    return { accounts: [], legacySessions: [] };
  }
}

export function saveRememberedAccounts(storage: MetadataStorage, accounts: RememberedAccount[]): void {
  const metadata = accounts.slice(0, 6).map(({ expiresAt, user, settings }) => ({ expiresAt, user, settings }));
  storage.setItem("chaq.rememberedAccounts", JSON.stringify(metadata));
}

export function upsertRememberedAccount(accounts: RememberedAccount[], account: RememberedAccount): RememberedAccount[] {
  return [account, ...accounts.filter((item) => item.user.id !== account.user.id)].slice(0, 6);
}

/** Logout deletion must run after any pending save of the same credential. */
export class RememberedCredentialWrites {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly vault: CredentialVault) {}

  save(value: RememberedCredential): Promise<void> {
    return this.enqueue(() => this.vault.saveRememberedSession(value));
  }

  delete(accountId: string): Promise<void> {
    return this.enqueue(() => this.vault.deleteRememberedSession(accountId));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
