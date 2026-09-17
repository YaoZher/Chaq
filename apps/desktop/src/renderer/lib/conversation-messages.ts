import type { ConversationMessage } from "@chaq/shared";
import { LatestRequestGate, SupersededRequestError, isSupersededRequest, type LatestRequestToken } from "./latest-request";

type Arrival = { message: ConversationMessage; revision: number };

/** One selected conversation, shared by polling, realtime events and send replies. */
export class ConversationMessages {
  private readonly selections = new LatestRequestGate();
  private readonly snapshots = new LatestRequestGate();
  private selection: LatestRequestToken | null = null;
  private messages: ConversationMessage[] = [];
  private readonly arrivals = new Map<string, Arrival>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  get current(): LatestRequestToken | null {
    return this.selection;
  }

  getSnapshot = (): ConversationMessage[] => this.messages;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(conversationId: string | null): LatestRequestToken | null {
    if (conversationId && this.selection?.resourceId === conversationId) return this.selection;
    this.selections.cancel();
    this.snapshots.cancel();
    this.selection = conversationId ? this.selections.begin(conversationId) : null;
    this.arrivals.clear();
    this.revision = 0;
    this.publish([]);
    return this.selection;
  }

  isCurrent(selection: LatestRequestToken): boolean {
    return this.selection === selection && this.selections.isCurrent(selection);
  }

  async load(
    selection: LatestRequestToken,
    read: (signal: AbortSignal) => Promise<ConversationMessage[]>
  ): Promise<void> {
    if (!this.isCurrent(selection)) throw new SupersededRequestError();
    const request = this.snapshots.begin(selection.resourceId);
    const startedRevision = this.revision;
    try {
      const rows = await this.snapshots.guard(request, read(request.signal));
      if (!this.isCurrent(selection)) throw new SupersededRequestError();
      if (!this.snapshots.isCurrent(request)) return;
      const merged = new Map(rows.filter((row) => row.conversationId === selection.resourceId).map((row) => [row.id, row]));
      for (const [id, arrival] of this.arrivals) {
        // A send/realtime arrival stays visible until a later snapshot has seen
        // it. Do not turn the server's recent-message window into an unbounded log.
        if (merged.has(id) && arrival.revision <= startedRevision) this.arrivals.delete(id);
        else merged.set(id, arrival.message);
      }
      this.publish([...merged.values()]);
    } catch (error) {
      // A newer poll for this conversation owns the snapshot now. Selection
      // cancellation still rejects so foreground actions stop for old chats.
      if (this.isCurrent(selection) && !this.snapshots.isCurrent(request) && isSupersededRequest(error)) return;
      throw error;
    }
  }

  receive(selection: LatestRequestToken, message: ConversationMessage): boolean {
    if (!this.isCurrent(selection) || message.conversationId !== selection.resourceId) return false;
    this.arrivals.set(message.id, { message, revision: ++this.revision });
    const merged = new Map(this.messages.map((row) => [row.id, row]));
    merged.set(message.id, message);
    this.publish([...merged.values()]);
    return true;
  }

  receiveRealtime(event: unknown): boolean {
    if (!this.selection || !event || typeof event !== "object" || !("type" in event) || event.type !== "conversation.message") return false;
    const message = "payload" in event ? event.payload : null;
    return isConversationMessage(message) && this.receive(this.selection, message);
  }

  private publish(messages: ConversationMessage[]): void {
    this.messages = messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    for (const listener of this.listeners) listener();
  }
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ConversationMessage>;
  return typeof message.id === "string"
    && typeof message.conversationId === "string"
    && typeof message.content === "string"
    && typeof message.createdAt === "string"
    && Number.isFinite(Date.parse(message.createdAt))
    && ["user", "agent", "system"].includes(message.authorKind ?? "")
    && ["text", "system", "action", "summary"].includes(message.kind ?? "")
    && ["pending", "delivered", "read", "failed"].includes(message.status ?? "");
}
