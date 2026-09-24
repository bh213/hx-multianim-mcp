#!/usr/bin/env node

/**
 * MCP server entry point for hx-multianim DevBridge.
 * Communicates with Claude Code via stdio, forwards tool calls to running games: HashLink games
 * over their DevBridge's HTTP server, browser games over the relay they dial into.
 *
 * Command line:
 *   --listen[=PORT]   Relay mode: listen for browser games on PORT (default 9010, or the next free
 *                     port of ten, as the engine does). Same as setting HX_DEV_WS_PORT.
 *
 * Environment variables:
 *   HX_DEV_PORT        - HashLink DevBridge port tried when nothing is connected (default: 9001)
 *   HX_DEV_HOST        - HashLink DevBridge host (default: localhost)
 *   HX_DEV_READY_FILE  - a game writes {port} here once it listens; read in preference to HX_DEV_PORT
 *   HX_DEV_TOKEN       - sent to every game, and required of every browser game's hello
 *   HX_DEV_TIMEOUT_MS  - per-call timeout (default: 10000)
 *   HX_DEV_WS_PORT     - relay mode on this port (see --listen)
 *   HX_DEV_WS_HOST     - relay bind address (default: 127.0.0.1)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDevServer } from "./server.js";

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `--listen`, `--listen=9011`, `--listen 9011` → the relay port; absent → undefined. */
function listenPort(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--listen") return positiveInt(argv[i + 1]) ?? 9010;
    if (arg.startsWith("--listen=")) return positiveInt(arg.slice("--listen=".length)) ?? 9010;
  }
  return undefined;
}

const env = process.env;
const wsPort = listenPort(process.argv.slice(2)) ?? positiveInt(env.HX_DEV_WS_PORT);

const dev = await createDevServer({
  httpHost: env.HX_DEV_HOST || "localhost",
  httpPort: positiveInt(env.HX_DEV_PORT) ?? 9001,
  readyFile: env.HX_DEV_READY_FILE || undefined,
  token: env.HX_DEV_TOKEN || undefined,
  timeoutMs: positiveInt(env.HX_DEV_TIMEOUT_MS),
  listen: wsPort !== undefined ? { port: wsPort, host: env.HX_DEV_WS_HOST || "127.0.0.1" } : null,
});

if (dev.relay) {
  // stderr: stdout is the MCP stream.
  console.error(`[hx-multianim-mcp] Relay listening on ${dev.relay.url} — open a browser game with ?devbridge=${dev.relay.url}`);
}

const transport = new StdioServerTransport();
await dev.server.connect(transport);

const cleanup = () => {
  void dev.close().finally(() => process.exit(0));
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
