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
  { name: "hx-multianim-dev", version: "1.0.0" },
  { capabilities: { logging: {} } },
);

registerTools(server, bridge);

// SSE: push game traces and errors as MCP log notifications
const sse = new SseClient(host, port);
sse.on("event", (evt: SseEvent) => {
  try {
    const payload = JSON.parse(evt.data) as { message?: string; stack?: string };
    const message = payload.message ?? evt.data;
    if (evt.event === "trace") {
      void server.sendLoggingMessage({ level: "info", logger: "game", data: message });
    } else if (evt.event === "error") {
      const detail = payload.stack ? `${message}\n${payload.stack}` : message;
      void server.sendLoggingMessage({ level: "error", logger: "game", data: detail });
    }
  } catch {
    // Malformed SSE data — ignore
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
sse.start();

const cleanup = () => {
  sse.stop();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
