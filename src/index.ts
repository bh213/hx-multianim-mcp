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

const port = parseInt(process.env.HX_DEV_PORT || "9001", 10);
const host = process.env.HX_DEV_HOST || "localhost";

const bridge = new DevBridge(host, port);

const server = new McpServer({
  name: "hx-multianim-dev",
  version: "1.0.0",
});

registerTools(server, bridge);

const transport = new StdioServerTransport();
await server.connect(transport);
