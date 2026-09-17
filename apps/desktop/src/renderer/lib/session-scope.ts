import type { LoginUser, UserSettings } from "./api";
import { SupersededRequestError } from "./latest-request";

export type AuthSession = { user: LoginUser; settings: UserSettings };
export type SessionSnapshot = { auth: AuthSession | null; generation: number };

/** A session generation owns all account data, including requests still in flight. */
export class SessionScope {
  private snapshot: SessionSnapshot = { auth: null, generation: 0 };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isCurrent(generation: number): boolean {
    return generation === this.snapshot.generation;
  }

  activate(auth: AuthSession): void {
    this.publish({ auth, generation: this.snapshot.generation + 1 });
  }

  end(): string | null {
    const accountId = this.snapshot.auth?.user.id ?? null;
    this.publish({ auth: null, generation: this.snapshot.generation + 1 });
    return accountId;
  }

  update(generation: number, update: AuthSession | ((current: AuthSession | null) => AuthSession | null)): void {
    if (!this.isCurrent(generation) || !this.snapshot.auth) return;
    const auth = typeof update === "function" ? update(this.snapshot.auth) : update;
    if (!auth || auth.user.id !== this.snapshot.auth.user.id) return;
    this.publish({ ...this.snapshot, auth });
  }

  /** Check both before starting a request and before returning its result. */
  bind<T extends object>(api: T, generation: number): T {
    return new Proxy(api, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          this.assertCurrent(generation);
          try {
            const result: unknown = await Reflect.apply(value, target, args);
            this.assertCurrent(generation);
            return result;
          } catch (error) {
            this.assertCurrent(generation);
            throw error;
          }
        };
      }
    });
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new SupersededRequestError();
  }

  private publish(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
