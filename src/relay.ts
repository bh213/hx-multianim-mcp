/**
 * The relay: a WebSocket server games in browser pages dial into. A page cannot listen on a
 * port, so the roles are reversed: this process listens and the game (the DevBridge's
 * WebSocketTransport, pointed here with `?devbridge=ws://127.0.0.1:9010`) connects.
 *
 * Wire (one JSON object per message):
 *   game  → relay  {"kind":"hello","protocol":1,"app","title","url","session","token"?,...}
 *   relay → game   {"kind":"welcome","protocol":1,"instance":"web-1"}
 *   relay → game   {"kind":"call","id":7,"method":"list_screens","params":{}}
 *   game  → relay  {"kind":"result","id":7,"ok":true,"result":{...}} | {"kind":"result","id":7,"ok":false,"error","code"}
 *   game  → relay  {"kind":"event","seq":42,"event":"trace","data":{...}}
 *
 * A socket that sends anything but a valid hello first is closed (4400); a hello without the
 * right token, when one is configured, is closed with 4401.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { type BridgeTransport, DEFAULT_CALL_TIMEOUT_MS, DevBridgeError, definedOnly } from "./bridge.js";

export const RELAY_PROTOCOL = 1;
export const CLOSE_BAD_HELLO = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
const HELLO_TIMEOUT_MS = 5000;

export interface HelloInfo {
  protocol: number;
  session: string;
  app?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

/** Calls to one browser game over its socket. */
export class WsGameTransport implements BridgeTransport {
  readonly kind = "ws" as const;
  private socket: WebSocket;
  private readonly timeoutMs: number;
  private readonly label: string;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }
  >();

  constructor(socket: WebSocket, label: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    this.socket = socket;
    this.label = label;
    this.timeoutMs = timeoutMs;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs: number = this.timeoutMs): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(
        new DevBridgeError(
          "connection_failed",
          `Browser game ${this.label} is disconnected. It dials back by itself while its page is open (see list_instances).`,
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DevBridgeError(
            "timeout",
            `Browser game ${this.label} did not answer ${method} within ${timeoutMs} ms (is its tab hidden? a background tab stops its frames)`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ kind: "call", id, method, params: definedOnly(params) }), (err) => {
        if (!err) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new DevBridgeError("connection_failed", `Could not send ${method} to ${this.label}: ${err.message}`));
      });
    });
  }

  /** A `result` frame from the game. */
  onResult(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; code?: unknown }): void {
    const id = typeof frame.id === "number" ? frame.id : -1;
    const entry = this.pending.get(id);
    if (!entry) return; // answered after its timeout
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (frame.ok === true) entry.resolve(frame.result);
    else
      entry.reject(
        new DevBridgeError(
          typeof frame.code === "string" ? frame.code : "internal",
          typeof frame.error === "string" ? frame.error : `${entry.method} failed`,
        ),
      );
  }

  /** Rejects every call still waiting: the socket is gone. */
  failAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DevBridgeError("connection_failed", `${reason} before answering ${entry.method}`));
      this.pending.delete(id);
    }
  }

  close(): void {
    this.failAll(`Browser game ${this.label} was closed`);
    try {
      this.socket.close(1000, "relay closing");
    } catch {
      // already closed
    }
  }
}

export interface RelayGame {
  /** Stable while the page keeps its session: `web-1`, `web-2`, ... */
  id: string;
  hello: HelloInfo;
  origin: string | undefined;
  connectedAt: Date;
  transport: WsGameTransport;
}

export interface RelayOptions {
  port: number;
  host?: string;
  token?: string;
  timeoutMs?: number;
  /** How many ports to try, from `port` up, when one is busy (as the engine does). */
  portTries?: number;
}

/**
 * Emits:
 * - "game" (game: RelayGame) — a hello was accepted (also on a reconnect, with the same id)
 * - "game_closed" (game: RelayGame) — its socket closed
 * - "event" (gameId: string, kind: string, data: unknown) — an event frame; a gap in `seq` is
 *   reported as kind "dropped" with {missed}
 */
export class WsRelay extends EventEmitter {
  private server: WebSocketServer | null = null;
  private readonly options: RelayOptions;
  private games = new Map<string, RelayGame>();
  private idBySession = new Map<string, string>();
  private lastSeq = new Map<string, number>();
  private nextGameNumber = 1;
  port = 0;

  constructor(options: RelayOptions) {
    super();
    this.options = options;
  }

  get host(): string {
    return this.options.host ?? "127.0.0.1";
  }

  get url(): string {
    return `ws://${this.host}:${this.port}`;
  }

  /** Binds `port`, or the next free one of `portTries`; resolves to the port bound. */
  async start(): Promise<number> {
    const tries = Math.max(1, this.options.portTries ?? 10);
    let lastError: unknown;
    for (let i = 0; i < tries; i++) {
      const port = this.options.port === 0 ? 0 : this.options.port + i;
      try {
        this.server = await listen(port, this.host);
        const address = this.server.address();
        this.port = typeof address === "object" && address ? address.port : port;
        this.server.on("connection", (socket, request) => this.onConnection(socket, request));
        return this.port;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
      }
    }
    throw new Error(`Relay could not listen on ${this.host}:${this.options.port}+: ${String(lastError)}`);
  }

  list(): RelayGame[] {
    return [...this.games.values()];
  }

  get(id: string): RelayGame | undefined {
    return this.games.get(id) ?? this.games.get(this.idBySession.get(id) ?? "");
  }

  async close(): Promise<void> {
    for (const game of this.games.values()) game.transport.close();
    this.games.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    let game: RelayGame | null = null;
    const helloTimer = setTimeout(() => {
      if (!game) socket.close(CLOSE_BAD_HELLO, "expected a hello frame");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        if (!game) socket.close(CLOSE_BAD_HELLO, "frames must be JSON");
        return;
      }
      if (!game) {
        clearTimeout(helloTimer);
        game = this.accept(socket, request, frame);
        return;
      }
      if (frame.kind === "result") game.transport.onResult(frame);
      else if (frame.kind === "event") this.onEventFrame(game, frame);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!game) return;
      game.transport.failAll(`Browser game ${game.id} disconnected`);
      // A newer socket for the same session may already have replaced this one.
      if (this.games.get(game.id) === game) {
        this.games.delete(game.id);
        this.emit("game_closed", game);
      }
    });
    socket.on("error", () => {
      // close follows
    });
  }

  private accept(socket: WebSocket, request: IncomingMessage, frame: Record<string, unknown>): RelayGame | null {
    if (frame.kind !== "hello" || typeof frame.session !== "string" || frame.session === "") {
      socket.close(CLOSE_BAD_HELLO, "the first frame must be a hello with a session");
      return null;
    }
    if (frame.protocol !== RELAY_PROTOCOL) {
      socket.close(CLOSE_BAD_HELLO, `unsupported protocol ${String(frame.protocol)}, this relay speaks ${RELAY_PROTOCOL}`);
      return null;
    }
    if (this.options.token && !tokensEqual(typeof frame.token === "string" ? frame.token : "", this.options.token)) {
      socket.close(CLOSE_UNAUTHORIZED, "token required (HX_DEV_TOKEN)");
      return null;
    }
    const session = frame.session;
    let id = this.idBySession.get(session);
    if (!id) {
      id = `web-${this.nextGameNumber++}`;
      this.idBySession.set(session, id);
    }
    const { token: _token, kind: _kind, ...info } = frame;
    const previous = this.games.get(id);
    const game: RelayGame = {
      id,
      hello: info as HelloInfo,
      origin: request.headers.origin,
      connectedAt: new Date(),
      transport: new WsGameTransport(socket, id, this.options.timeoutMs),
    };
    this.games.set(id, game);
    if (previous) previous.transport.close(); // a reconnect replaced the old socket
    this.lastSeq.delete(id);
    socket.send(JSON.stringify({ kind: "welcome", protocol: RELAY_PROTOCOL, instance: id }));
    this.emit("game", game);
    return game;
  }

  private onEventFrame(game: RelayGame, frame: Record<string, unknown>): void {
    const kind = typeof frame.event === "string" ? frame.event : "unknown";
    if (typeof frame.seq === "number") {
      const last = this.lastSeq.get(game.id);
      if (last !== undefined && frame.seq > last + 1) {
        this.emit("event", game.id, "dropped", { missed: frame.seq - last - 1 });
      }
      this.lastSeq.set(game.id, frame.seq);
    }
    this.emit("event", game.id, kind, frame.data);
  }
}

function listen(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, host });
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      server.on("error", () => {});
      resolve(server);
    });
  });
}

/** Compares without returning early on the first differing character. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
