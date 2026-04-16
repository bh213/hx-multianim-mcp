#!/usr/bin/env node

/**
 * MCP server entry point for hx-multianim DevBridge.
 * Communicates with Claude Code via stdio, forwards tool calls
 * as HTTP requests to the running Haxe application.
 *
 * Environment variables:
 *   HX_DEV_PORT - DevBridge port (default: 9001)
 *   HX_DEV_HOST - DevBridge host (default: localhost)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DevBridge } from "./bridge.js";
import { registerTools } from "./tools.js";
import { SseClient, type SseEvent } from "./sse.js";

const port = parseInt(process.env.HX_DEV_PORT || "9001", 10);
const host = process.env.HX_DEV_HOST || "localhost";

const bridge = new DevBridge(host, port);

const server = new McpServer(
  { name: "hx-multianim-dev", version: "1.10.0" },
  {
    capabilities: { logging: {} },
    instructions:
      "This server bridges Claude to a running hx-multianim (Haxe/Heaps) game via DevBridge.\n\n" +
      "IMPORTANT — CONNECT FIRST: You MUST call the `connect` tool before any other tool. All other tools will return a `not_connected` error until `connect` succeeds. The game's DevBridge port is printed to stdout on startup (e.g. `[DevBridge] Listening on port 9002`); default is 9001.\n\n" +
      "Breakpoints: game code can call `DevBridge.debugger(data, pause?)` (JS-debugger-style). Hits arrive as SSE `debugger` log notifications in real time AND via the pollable `get_debugger_hits` tool (use `since_id` as a cursor). If the hit paused the game, resume with `pause({paused:false})`.",
  },
);

const sse = new SseClient(host, port);
registerTools(server, bridge, sse);

// SSE: push game events as MCP log notifications
sse.on("event", (evt: SseEvent) => {
  try {
    const payload = JSON.parse(evt.data) as Record<string, unknown>;
    const message = (payload.message as string) ?? evt.data;

    switch (evt.event) {
      case "trace": {
        void server.sendLoggingMessage({ level: "info", logger: "game", data: message });
        break;
      }
      case "error": {
        const detail = payload.stack ? `${message}\n${payload.stack}` : message;
        void server.sendLoggingMessage({ level: "error", logger: "game", data: detail });
        break;
      }
      case "screen_change": {
        const entering = (payload.entering as string[]) ?? [];
        const leaving = (payload.leaving as string[]) ?? [];
        let summary = `Screen ${payload.action}: ${payload.previousMode} → ${payload.mode}`;
        if (entering.length > 0) summary += ` [+${entering.join(",")}]`;
        if (leaving.length > 0) summary += ` [-${leaving.join(",")}]`;
        if (payload.dialogName) summary += ` dialog=${payload.dialogName}`;
        void server.sendLoggingMessage({ level: "info", logger: "screen", data: summary });
        break;
      }
      case "reload": {
        const level = payload.status === "failed" ? "error"
          : payload.status === "needs_restart" ? "warning"
          : "info";
        let msg = `Reload ${payload.status}: ${payload.file}`;
        if (payload.rebuiltCount) msg += ` (${payload.rebuiltCount} rebuilt)`;
        if (payload.elapsedMs) msg += ` [${(payload.elapsedMs as number).toFixed(1)}ms]`;
        const errors = payload.errors as Array<{ file: string; line: number; col: number; message: string }> | undefined;
        if (errors?.length) {
          msg += "\n" + errors.map((e) => `  ${e.file}:${e.line}:${e.col} ${e.message}`).join("\n");
        }
        void server.sendLoggingMessage({ level, logger: "reload", data: msg });
        break;
      }
      case "parameter_change": {
        void server.sendLoggingMessage({
          level: "debug",
          logger: "param",
          data: `${payload.programmable}.${payload.param} = ${JSON.stringify(payload.value)}`,
        });
        break;
      }
      case "debugger": {
        const loc = payload.file ? `${payload.file as string}:${payload.line}` : "<unknown>";
        const dataStr = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
        const pausedStr = payload.paused ? " [PAUSED]" : "";
        void server.sendLoggingMessage({
          level: "warning",
          logger: "debugger",
          data: `#${payload.id} ${loc} ${payload.method as string}${pausedStr}\n${dataStr}`,
        });
        break;
      }
      case "custom": {
        const data = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
        void server.sendLoggingMessage({
          level: "info",
          logger: (payload.name as string) ?? "custom",
          data,
        });
        break;
      }
      default:
        void server.sendLoggingMessage({
          level: "debug",
          logger: "sse",
          data: `Unknown SSE event: ${evt.event}`,
        });
    }
  } catch {
    // Malformed SSE data — ignore
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const cleanup = () => {
  sse.stop();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
