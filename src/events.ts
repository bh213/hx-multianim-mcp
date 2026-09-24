/**
 * Everything the connected games push (traces, errors, screen changes, reloads, parameter
 * changes, breakpoints, game events), kept here with a cursor so the model can read it with the
 * `events` tool. MCP log notifications carry the same events, but clients do not reliably put
 * those in the model's context, so the pollable buffer is the one that counts.
 */

export interface BufferedEvent {
  /** Monotonic across every instance, from 1. */
  id: number;
  /** Which game sent it (`http:9001`, `web-1`, ...). */
  instance: string;
  /** The DevBridge's event name: trace, error, screen_change, reload, parameter_change, debugger, game_event, custom. */
  kind: string;
  /** When this server received it (ISO time). */
  time: string;
  data: unknown;
}

export interface EventQuery {
  since_id?: number;
  kinds?: string[];
  instance?: string;
  limit?: number;
}

export interface EventQueryResult {
  events: BufferedEvent[];
  /** The newest id in the buffer: pass it as `since_id` next time. */
  lastId: number;
  /** Events newer than `since_id` that were pushed out of the buffer before this read. */
  missed: number;
}

export class EventBuffer {
  private readonly capacity: number;
  private items: BufferedEvent[] = [];
  private nextId = 1;
  private listeners: Array<(event: BufferedEvent) => void> = [];

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  push(instance: string, kind: string, data: unknown): BufferedEvent {
    const event: BufferedEvent = { id: this.nextId++, instance, kind, time: new Date().toISOString(), data };
    this.items.push(event);
    if (this.items.length > this.capacity) this.items.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  onEvent(listener: (event: BufferedEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  query(query: EventQuery = {}): EventQueryResult {
    const since = query.since_id ?? 0;
    const limit = Math.max(1, Math.min(query.limit ?? 100, this.capacity));
    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const matching = this.items.filter(
      (e) => e.id > since && (!kinds || kinds.has(e.kind)) && (!query.instance || e.instance === query.instance),
    );
    const oldest = this.items.length > 0 ? this.items[0].id : this.nextId;
    const missed = since < oldest - 1 ? oldest - 1 - since : 0;
    return {
      events: matching.slice(0, limit),
      lastId: matching.length > limit ? matching[limit - 1].id : this.lastId,
      missed,
    };
  }
}
