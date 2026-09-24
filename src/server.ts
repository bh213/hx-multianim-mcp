/**
 * Builds the MCP server: tools, the instance registry, the event buffer, and (in relay mode) the
 * WebSocket relay browser games dial into. index.ts runs it over stdio; tests run it in memory.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_CALL_TIMEOUT_MS } from "./bridge.js";
import { type BufferedEvent, EventBuffer } from "./events.js";
import { InstanceRegistry } from "./instances.js";
import { WsRelay } from "./relay.js";
import { registerTools } from "./tools.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface ServerOptions {
  /** Host of a HashLink game's DevBridge (HX_DEV_HOST, default localhost). */
  httpHost?: string;
  /** Port tried when nothing is connected (HX_DEV_PORT, default 9001). */
  httpPort?: number;
  /** HX_DEV_READY_FILE: read for the port in preference to httpPort. */
  readyFile?: string;
  /** HX_DEV_TOKEN: sent to every game, required of every browser game's hello. */
  token?: string;
  /** Per-call timeout (HX_DEV_TIMEOUT_MS, default 10 s). */
  timeoutMs?: number;
  /** Relay mode: listen here for browser games (--listen, HX_DEV_WS_PORT). Null: off. */
  listen?: { port: number; host?: string } | null;
  /** Probe the default HTTP port on the first call when no game is known (default true). */
  autoDiscover?: boolean;
  /** Keep this many pushed events for the events tool (default 1000). */
  eventCapacity?: number;
}

export interface DevServer {
  server: McpServer;
  registry: InstanceRegistry;
  events: EventBuffer;
  relay: WsRelay | null;
  close(): Promise<void>;
}

const INSTRUCTIONS =
  "This server bridges Claude to running hx-multianim (Haxe/Heaps) games via their DevBridge: a HashLink game over HTTP, or a game in a browser page over a WebSocket relay.\n\n" +
  "Which game: with exactly one game connected, every tool goes to it and `connect` is not needed. With none, the first call looks for a HashLink game on the default port (9001). With several, pass `target` (an id from `list_instances`, e.g. \"http:9001\" or \"web-1\") or choose one with `connect`. A HashLink game prints its port on startup (`[DevBridge] Listening on port 9002`).\n\n" +
  "Browser games: when this server runs with --listen, a page opened with ?devbridge=ws://127.0.0.1:9010 connects by itself and appears in `list_instances`. The tab must be visible (a hidden tab stops its frames). `reload` needs the file's text (content or source_path) and `quit` is not supported there.\n\n" +
  "Events: `events` returns everything the games pushed (traces, errors, reloads, screen changes, breakpoints, game events) with a cursor — use it rather than relying on log notifications.\n\n" +
  "Breakpoints: game code can call `DevBridge.debugger(data, pause?)` (JS-debugger-style). Hits appear in `events` (kind 'debugger') and in `get_debugger_hits` (use `since_id` as a cursor). If the hit paused the game, resume with `pause({paused:false})`.";

export async function createDevServer(options: ServerOptions = {}): Promise<DevServer> {
  const httpHost = options.httpHost ?? "localhost";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const events = new EventBuffer(options.eventCapacity ?? 1000);

  let relay: WsRelay | null = null;
  if (options.listen) {
    relay = new WsRelay({ port: options.listen.port, host: options.listen.host, token: options.token, timeoutMs });
    await relay.start();
  }

  const registry = new InstanceRegistry({
    events,
    token: options.token,
    timeoutMs,
    defaultHost: httpHost,
    defaultPort: options.httpPort ?? 9001,
    readyFile: options.readyFile,
    relay: relay ?? undefined,
    autoDiscover: options.autoDiscover,
  });

  const server = new McpServer(
    { name: "hx-multianim-dev", version: VERSION },
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(server, { registry, events, defaultHost: httpHost, token: options.token, timeoutMs });

  // Every pushed event also goes out as an MCP log notification, for clients that show them.
  const unsubscribe = events.onEvent((event) => {
    const several = registry.list().length > 1;
    const log = formatLogMessage(event, several);
    if (log && server.isConnected()) void server.sendLoggingMessage(log).catch(() => {});
  });

  if (relay) {
    relay.on("game", (game) => {
      const hello = game.hello;
      events.push(game.id, "instance", { status: "connected", app: hello.app, title: hello.title, url: hello.url, session: hello.session });
    });
    relay.on("game_closed", (game) => events.push(game.id, "instance", { status: "disconnected" }));
  }

  return {
    server,
    registry,
    events,
    relay,
    async close() {
      unsubscribe();
      registry.close();
      if (relay) await relay.close();
      await server.close();
    },
  };
}

type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

/** How an event reads as an MCP log notification. */
export function formatLogMessage(event: BufferedEvent, withInstance: boolean): { level: LogLevel; logger: string; data: string } | null {
  const payload = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
  const prefix = withInstance ? `[${event.instance}] ` : "";
  const message = typeof payload.message === "string" ? payload.message : JSON.stringify(event.data);

  switch (event.kind) {
    case "trace":
      return { level: "info", logger: "game", data: prefix + message };
    case "error": {
      const detail = payload.stack ? `${message}\n${String(payload.stack)}` : message;
      return { level: "error", logger: "game", data: prefix + detail };
    }
    case "screen_change": {
      const entering = (payload.entering as string[]) ?? [];
      const leaving = (payload.leaving as string[]) ?? [];
      let summary = `Screen ${String(payload.action)}: ${String(payload.previousMode)} → ${String(payload.mode)}`;
      if (entering.length > 0) summary += ` [+${entering.join(",")}]`;
      if (leaving.length > 0) summary += ` [-${leaving.join(",")}]`;
      if (payload.dialogName) summary += ` dialog=${String(payload.dialogName)}`;
      return { level: "info", logger: "screen", data: prefix + summary };
    }
    case "reload": {
      const level: LogLevel = payload.status === "failed" ? "error" : payload.status === "needs_restart" ? "warning" : "info";
      let msg = `Reload ${String(payload.status)}: ${String(payload.file)}`;
      if (payload.rebuiltCount) msg += ` (${String(payload.rebuiltCount)} rebuilt)`;
      if (typeof payload.elapsedMs === "number" && payload.elapsedMs) msg += ` [${payload.elapsedMs.toFixed(1)}ms]`;
      const errors = payload.errors as Array<{ file: string; line: number; col: number; message: string }> | undefined;
      if (errors?.length) msg += "\n" + errors.map((e) => `  ${e.file}:${e.line}:${e.col} ${e.message}`).join("\n");
      return { level, logger: "reload", data: prefix + msg };
    }
    case "parameter_change":
      return {
        level: "debug",
        logger: "param",
        data: `${prefix}${String(payload.programmable)}.${String(payload.param)} = ${JSON.stringify(payload.value)}`,
      };
    case "debugger": {
      const loc = payload.file ? `${String(payload.file)}:${String(payload.line)}` : "<unknown>";
      const dataStr = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
      const pausedStr = payload.paused ? " [PAUSED]" : "";
      return {
        level: "warning",
        logger: "debugger",
        data: `${prefix}#${String(payload.id)} ${loc} ${String(payload.method)}${pausedStr}\n${dataStr}`,
      };
    }
    case "game_event": {
      const dataStr = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
      return { level: "info", logger: "game_event", data: `${prefix}#${String(payload.id)} ${String(payload.name)} ${dataStr}` };
    }
    case "custom": {
      const data = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
      return { level: "info", logger: typeof payload.name === "string" ? payload.name : "custom", data: prefix + data };
    }
    case "instance":
      return { level: "notice", logger: "instance", data: `${event.instance} ${String(payload.status)}${payload.title ? `: ${String(payload.title)}` : ""}` };
    case "dropped":
      return { level: "warning", logger: "events", data: `${prefix}${String(payload.missed)} event(s) lost while the socket was busy or down` };
    default:
      return { level: "debug", logger: "sse", data: `${prefix}Unknown event: ${event.kind}` };
  }
}
