/**
 * The games this server can talk to, and which one a tool call goes to.
 *
 * - An HTTP instance (`http:9001`) is a HashLink game's DevBridge. It is added by `connect`, by a
 *   `target` naming its port, or found on the first call when nothing else is connected (the port
 *   in HX_DEV_READY_FILE, else HX_DEV_PORT, else 9001, answering a ping).
 * - A browser instance (`web-1`) is added when a page's hello reaches the relay, and keeps its id
 *   while the page keeps its session (a reconnect after the relay restarts is the same game).
 *
 * A call goes to its `target` when given, else to the game chosen with `connect`, else to the only
 * game there is. With none it answers not_connected, with several ambiguous_target.
 */

import { readFileSync } from "node:fs";
import { type BridgeTransport, DevBridgeError, HttpTransport } from "./bridge.js";
import type { EventBuffer } from "./events.js";
import type { RelayGame, WsRelay } from "./relay.js";
import { SseClient, type SseEvent } from "./sse.js";

export interface Instance {
  id: string;
  kind: "http" | "ws";
  transport: BridgeTransport;
  connectedAt: Date;
  /** For HTTP: host/port. For a browser game: its hello (app, title, url, session, ...). */
  info: Record<string, unknown>;
}

export interface RegistryOptions {
  events: EventBuffer;
  token?: string;
  timeoutMs?: number;
  /** Where to look for a HashLink game when nothing is connected. */
  defaultHost: string;
  defaultPort: number;
  /** HX_DEV_READY_FILE: a game writes {port} here once it listens; read in preference to defaultPort. */
  readyFile?: string;
  relay?: WsRelay;
  /** Probe the default HTTP port on the first call when no game is known (default true). */
  autoDiscover?: boolean;
}

interface HttpEntry extends Instance {
  sse: SseClient;
}

export function httpInstanceId(host: string, port: number): string {
  return host === "localhost" || host === "127.0.0.1" ? `http:${port}` : `http:${host}:${port}`;
}

export class InstanceRegistry {
  private http = new Map<string, HttpEntry>();
  private currentId: string | null = null;
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
    const relay = options.relay;
    if (relay) {
      relay.on("event", (gameId: string, kind: string, data: unknown) => options.events.push(gameId, kind, data));
    }
  }

  get current(): string | null {
    return this.currentId;
  }

  get relay(): WsRelay | undefined {
    return this.options.relay;
  }

  /** Every game known now: HTTP instances added so far, browser games connected to the relay. */
  list(): Instance[] {
    const out: Instance[] = [...this.http.values()].map(({ sse: _sse, ...rest }) => rest);
    for (const game of this.options.relay?.list() ?? []) out.push(fromRelayGame(game));
    return out;
  }

  get(id: string): Instance | undefined {
    const entry = this.http.get(id);
    if (entry) return entry;
    const game = this.options.relay?.get(id);
    return game ? fromRelayGame(game) : undefined;
  }

  /** Adds (or returns) the HTTP instance for host:port, and subscribes to its /sse events. */
  addHttp(host: string, port: number): Instance {
    const id = httpInstanceId(host, port);
    const existing = this.http.get(id);
    if (existing) return existing;
    const transport = new HttpTransport(host, port, { token: this.options.token, timeoutMs: this.options.timeoutMs });
    const sse = new SseClient(host, port, this.options.token);
    sse.on("event", (evt: SseEvent) => {
      let data: unknown = evt.data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        // keep the raw text
      }
      this.options.events.push(id, evt.event, data);
    });
    sse.start();
    const entry: HttpEntry = { id, kind: "http", transport, connectedAt: new Date(), info: { host, port }, sse };
    this.http.set(id, entry);
    return entry;
  }

  removeHttp(id: string): void {
    const entry = this.http.get(id);
    if (!entry) return;
    entry.sse.stop();
    entry.transport.close();
    this.http.delete(id);
    if (this.currentId === id) this.currentId = null;
  }

  /** Makes `id` the game calls go to when they name no target. */
  select(id: string): void {
    this.currentId = id;
  }

  /** The instance a call should go to. Throws DevBridgeError when there is none, or no single one. */
  async resolve(target?: string): Promise<Instance> {
    if (target !== undefined && target !== "") return this.resolveTarget(target);

    if (this.currentId) {
      const current = this.get(this.currentId);
      if (current) return current;
      throw new DevBridgeError(
        "connection_failed",
        `The game chosen with connect (${this.currentId}) is not connected now. A browser game dials back by itself while its page is open; see list_instances.`,
      );
    }

    const all = this.list();
    if (all.length === 1) return all[0];
    if (all.length > 1) {
      throw new DevBridgeError(
        "ambiguous_target",
        `${all.length} games are connected (${all.map((i) => i.id).join(", ")}). Pass target, or choose one with connect({instance}).`,
      );
    }

    const found = this.options.autoDiscover === false ? null : await this.discover();
    if (found) return found;
    throw new DevBridgeError("not_connected", this.notConnectedMessage());
  }

  private notConnectedMessage(): string {
    const port = this.defaultPort();
    let msg = `No game connected, and no DevBridge answered on ${this.options.defaultHost}:${port}. For a HashLink game call connect({port}) with the port it printed ([DevBridge] Listening on port N).`;
    const relay = this.options.relay;
    if (relay && relay.port > 0) {
      msg += ` A browser game connects by itself when its page is opened with ?devbridge=${relay.url}.`;
    } else {
      msg += " For a browser game, start this server with --listen and open the page with ?devbridge=ws://127.0.0.1:9010.";
    }
    return msg;
  }

  private async resolveTarget(target: string): Promise<Instance> {
    const known = this.get(target);
    if (known) return known;
    const http = parseHttpTarget(target, this.options.defaultHost);
    if (http) return this.addHttp(http.host, http.port);
    const ids = this.list().map((i) => i.id);
    throw new DevBridgeError(
      "unknown_target",
      `No game "${target}". Known: ${ids.length > 0 ? ids.join(", ") : "none"}. A HashLink game can be named by port ("9001" or "http:9001").`,
    );
  }

  /** The port a HashLink game is expected on: HX_DEV_READY_FILE's, else the default. */
  defaultPort(): number {
    if (this.options.readyFile) {
      try {
        const ready = JSON.parse(readFileSync(this.options.readyFile, "utf8")) as { port?: unknown };
        if (typeof ready.port === "number" && ready.port > 0) return ready.port;
      } catch {
        // no file yet, or not JSON
      }
    }
    return this.options.defaultPort;
  }

  private async discover(): Promise<Instance | null> {
    const host = this.options.defaultHost;
    const port = this.defaultPort();
    const probe = new HttpTransport(host, port, { token: this.options.token, timeoutMs: 1500 });
    try {
      await probe.call("ping");
    } catch {
      return null;
    }
    return this.addHttp(host, port);
  }

  close(): void {
    for (const id of [...this.http.keys()]) this.removeHttp(id);
  }
}

function fromRelayGame(game: RelayGame): Instance {
  return {
    id: game.id,
    kind: "ws",
    transport: game.transport,
    connectedAt: game.connectedAt,
    info: { ...game.hello, origin: game.origin },
  };
}

/** "9001", "http:9001", "http:host:9001", "host:9001" → host/port; anything else → null. */
export function parseHttpTarget(target: string, defaultHost: string): { host: string; port: number } | null {
  const text = target.startsWith("http:") && !target.startsWith("http://") ? target.slice(5) : target.replace(/^http:\/\//, "");
  const match = /^(?:(.+):)?(\d{1,5})$/.exec(text);
  if (!match) return null;
  const port = Number(match[2]);
  if (port <= 0 || port > 65535) return null;
  return { host: match[1] ?? defaultHost, port };
}
