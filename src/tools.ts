/**
 * MCP tool definitions for hx-multianim DevBridge.
 * Each tool maps to a DevBridge method, sent to one game (see instances.ts for which).
 *
 * Error handling: DevBridgeError from a call is caught and returned
 * as {isError: true} with structured JSON ({error, code}) so Claude can
 * differentiate not_connected / connection_failed / timeout / not_found / invalid_params / invalid_state / internal.
 */

import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DevBridgeError, HttpTransport } from "./bridge.js";
import type { EventBuffer } from "./events.js";
import type { Instance, InstanceRegistry } from "./instances.js";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };
type ToolResult = { content: ToolContent[]; isError?: boolean };

export interface ToolContext {
  registry: InstanceRegistry;
  events: EventBuffer;
  /** Host a HashLink game's DevBridge is on (HX_DEV_HOST). */
  defaultHost: string;
  token?: string;
  timeoutMs?: number;
}

/** Return a structured tool error with code for programmatic differentiation. */
function toolError(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof DevBridgeError) return toolError(error.code, error.message);
  throw error;
}

const target = z
  .string()
  .optional()
  .describe(
    'Which game to call: an id from list_instances ("http:9001", "web-1") or a HashLink port ("9002"). Optional when exactly one game is connected, or one was chosen with connect.',
  );

/** Resolve the target game and call a method on it, returning JSON or a structured isError. */
async function callBridge(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown> = {},
  targetId?: string,
): Promise<ToolResult> {
  try {
    const instance = await ctx.registry.resolve(targetId);
    const result = await instance.transport.call(method, params);
    return textResult(result);
  } catch (error) {
    return errorResult(error);
  }
}

/** Resize a PNG image buffer to the given dimensions. sharp is loaded only when a picture is scaled. */
async function scaleImage(png: Buffer, width: number, height: number): Promise<{ data: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const data = await sharp(png).resize(width, height).png().toBuffer();
  return { data, width, height };
}

function describeInstance(instance: Instance, current: string | null): Record<string, unknown> {
  return {
    id: instance.id,
    kind: instance.kind === "ws" ? "browser" : "hashlink",
    current: instance.id === current,
    connectedAt: instance.connectedAt.toISOString(),
    ...instance.info,
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // ---- Connection ----

  server.registerTool(
    "connect",
    {
      description:
        "Choose the game that tool calls go to when they name no target. For a HashLink game give its DevBridge port (and optionally host): it is pinged first, and nothing changes if the ping fails. For a game already known (see list_instances), such as a browser game connected to the relay, give its instance id. Not needed when exactly one game is connected: calls then go to it. The DevBridge port is printed to game stdout, e.g. [DevBridge] Listening on port 9002",
      inputSchema: {
        port: z.number().optional().describe("DevBridge port number of a HashLink game"),
        host: z.string().optional().describe("DevBridge host (default: localhost)"),
        instance: z.string().optional().describe('An instance id from list_instances, e.g. "web-1" or "http:9001"'),
      },
    },
    async ({ port, host, instance }) => {
      const before = ctx.registry.current;
      const unchanged = before ? ` Nothing changed: calls still go to ${before}.` : " Nothing changed.";
      if (instance !== undefined) {
        const known = ctx.registry.get(instance);
        if (!known) {
          const ids = ctx.registry.list().map((i) => i.id);
          return toolError("unknown_target", `No game "${instance}". Known: ${ids.length > 0 ? ids.join(", ") : "none"}.${unchanged}`);
        }
        try {
          const ping = await known.transport.call("ping");
          ctx.registry.select(known.id);
          return textResult({ connected: true, instance: known.id, ping });
        } catch (error) {
          if (error instanceof DevBridgeError) return toolError(error.code, `${known.id} did not answer a ping: ${error.message}.${unchanged}`);
          throw error;
        }
      }
      if (port === undefined) {
        return toolError("invalid_params", "connect needs port (a HashLink game's DevBridge) or instance (from list_instances).");
      }
      const targetHost = host ?? ctx.defaultHost;
      const probe = new HttpTransport(targetHost, port, { token: ctx.token, timeoutMs: ctx.timeoutMs });
      let ping: unknown;
      try {
        ping = await probe.call("ping");
      } catch (error) {
        if (error instanceof DevBridgeError) {
          return toolError(error.code, `Could not connect to ${targetHost}:${port}: ${error.message}.${unchanged}`);
        }
        throw error;
      }
      const added = ctx.registry.addHttp(targetHost, port);
      ctx.registry.select(added.id);
      return textResult({ connected: true, instance: added.id, host: targetHost, port, ping });
    },
  );

  server.registerTool(
    "list_instances",
    {
      description:
        "List the games this server can reach: browser games connected to the relay (app, title, URL, session), HashLink games already connected, and DevBridges answering a ping on the ten ports from the default one (9001-9010). Says which one calls go to when they name no target.",
      inputSchema: {
        scan: z.boolean().optional().describe("Ping the ten default ports for HashLink games not yet connected (default: true)"),
      },
    },
    async ({ scan }) => {
      const current = ctx.registry.current;
      const instances = ctx.registry.list().map((i) => describeInstance(i, current));
      const discovered: Array<Record<string, unknown>> = [];
      if (scan !== false) {
        const base = ctx.registry.defaultPort();
        const knownPorts = new Set(ctx.registry.list().filter((i) => i.kind === "http").map((i) => i.info.port));
        const probes = [];
        for (let port = base; port < base + 10; port++) {
          if (knownPorts.has(port)) continue;
          const probe = new HttpTransport(ctx.defaultHost, port, { token: ctx.token, timeoutMs: 700 });
          probes.push(
            probe.call("ping").then(
              (ping) => discovered.push({ id: `http:${port}`, kind: "hashlink", port, connected: false, ping }),
              (error) => {
                if (error instanceof DevBridgeError && error.code === "unauthorized") {
                  discovered.push({ id: `http:${port}`, kind: "hashlink", port, connected: false, error: "requires a token (HX_DEV_TOKEN)" });
                }
              },
            ),
          );
        }
        await Promise.all(probes);
        discovered.sort((a, b) => (a.port as number) - (b.port as number));
      }
      const relay = ctx.registry.relay;
      return textResult({
        current,
        relay: relay && relay.port > 0 ? { listening: relay.url, openPageWith: `?devbridge=${relay.url}` } : null,
        instances,
        discovered,
      });
    },
  );

  server.registerTool(
    "events",
    {
      description:
        "Read what the connected games pushed, oldest first, with a cursor: traces (trace), runtime errors (error), screen changes (screen_change), hot reloads with their errors (reload), parameter changes (parameter_change), breakpoint hits (debugger), game events (game_event), custom events (custom). Pass the lastId of the previous answer as since_id to get only what is new. This server keeps the last 1000 events of every game it is connected to, so nothing is lost between calls. 'missed' counts events that were pushed out before you read them.",
      inputSchema: {
        since_id: z.number().optional().describe("Only events with id > since_id (use lastId from the previous answer)"),
        kinds: z.array(z.string()).optional().describe('Only these kinds, e.g. ["error", "reload", "debugger"]'),
        limit: z.number().optional().describe("Max events to return (default: 100)"),
        target: z.string().optional().describe("Only events from this game (an instance id)"),
      },
    },
    async ({ since_id, kinds, limit, target: instance }) =>
      textResult(ctx.events.query({ since_id, kinds, limit, instance })),
  );

  // ---- Performance & Status ----

  server.registerTool(
    "performance",
    { description: "Get FPS, draw calls, triangle count, object count, and scene dimensions", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "performance", {}, target),
  );

  // ---- Scene Inspection ----

  server.registerTool(
    "list_screens",
    { description: "List all registered screens with their active/failed status", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "list_screens", {}, target),
  );

  server.registerTool(
    "list_builders",
    { description: "List all loaded .manim builders with their programmable names and parameter definitions", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "list_builders", {}, target),
  );

  server.registerTool(
    "scene_graph",
    {
      description: "Dump the scene graph tree showing object types, positions, visibility, and names",
      inputSchema: { depth: z.number().optional().describe("Maximum depth to traverse (default: 10)"), target },
    },
    async ({ depth, target }) => callBridge(ctx, "scene_graph", { depth }, target),
  );

  server.registerTool(
    "inspect_element",
    {
      description: "Get detailed info about a named element on a screen (position, size, visibility, text content)",
      inputSchema: {
        screen: z.string().describe("Screen name"),
        element: z.string().describe("Element name (h2d.Object.name)"),
        target,
      },
    },
    async ({ screen, element, target }) => callBridge(ctx, "inspect_element", { screen, element }, target),
  );

  // ---- Screenshot ----

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture the current frame as a PNG image. Provide width and/or height to scale down (aspect ratio is preserved when only one is given; error if both are given with wrong aspect ratio). In a browser game the picture is the render target's size, whatever the page's device pixel ratio.",
      inputSchema: {
        width: z.number().optional().describe("Target width in pixels. If only width is provided, height is computed to preserve aspect ratio."),
        height: z.number().optional().describe("Target height in pixels. If only height is provided, width is computed to preserve aspect ratio."),
        target,
      },
    },
    async ({ width, height, target }) => {
      try {
        const instance = await ctx.registry.resolve(target);
        const result = (await instance.transport.call("screenshot")) as {
          base64: string;
          width: number;
          height: number;
        };

        let imageData = result.base64;
        let finalWidth = result.width;
        let finalHeight = result.height;

        if (width !== undefined || height !== undefined) {
          const srcW = result.width;
          const srcH = result.height;
          const aspect = srcW / srcH;

          if (width !== undefined && height !== undefined) {
            const expectedHeight = Math.round(width / aspect);
            if (Math.abs(expectedHeight - height) > 1) {
              return toolError("invalid_params", `Aspect ratio mismatch: ${srcW}x${srcH} image cannot be scaled to ${width}x${height}. For width=${width}, height should be ~${expectedHeight}. Provide only one dimension to auto-compute the other.`);
            }
          }

          const targetW = width ?? Math.round(height! * aspect);
          const targetH = height ?? Math.round(width! / aspect);

          if (targetW < srcW || targetH < srcH) {
            const resized = await scaleImage(Buffer.from(result.base64, "base64"), targetW, targetH);
            imageData = resized.data.toString("base64");
            finalWidth = resized.width;
            finalHeight = resized.height;
          }
        }

        return {
          content: [
            { type: "image" as const, data: imageData, mimeType: "image/png" as const },
            { type: "text" as const, text: `Screenshot: ${finalWidth}x${finalHeight}${(finalWidth !== result.width || finalHeight !== result.height) ? ` (scaled from ${result.width}x${result.height})` : ""}` },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ---- State Manipulation ----

  server.registerTool(
    "set_parameter",
    {
      description: "Set a parameter on a live programmable BuilderResult (uses incremental mode)",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
        param: z.string().describe("Parameter name"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
        target,
      },
    },
    async ({ programmable, param, value, target }) =>
      callBridge(ctx, "set_parameter", { programmable, param, value }, target),
  );

  server.registerTool(
    "set_visibility",
    {
      description: "Toggle visibility of a named element on a screen",
      inputSchema: {
        screen: z.string().describe("Screen name"),
        element: z.string().describe("Element name"),
        visible: z.boolean().describe("Whether the element should be visible"),
        target,
      },
    },
    async ({ screen, element, visible, target }) =>
      callBridge(ctx, "set_visibility", { screen, element, visible }, target),
  );

  // ---- Hot Reload ----

  server.registerTool(
    "reload",
    {
      description:
        "Hot-reload a .manim file (or all changed files if no file specified). A HashLink game reads the file itself. A browser game cannot: give it the text, as content or as source_path (a file on this machine that this server reads and sends). On failure, errors[] entries include 'message', 'file', 'line', 'col', 'errorType' ('parse' | 'build' | 'signatureIncompatible'), and 'context'.",
      inputSchema: {
        file: z.string().optional().describe("Resource path to reload (e.g. 'ui/menu.manim'). Omit to reload all changed files (HashLink only)."),
        content: z.string().optional().describe("The file's new text. Required for a browser game unless source_path is given."),
        source_path: z.string().optional().describe("A path on this machine to read the file's text from, sent as content."),
        target,
      },
    },
    async ({ file, content, source_path, target }) => {
      let text = content;
      if (text === undefined && source_path !== undefined) {
        try {
          text = await readFile(source_path, "utf8");
        } catch (error) {
          return toolError("not_found", `Could not read source_path ${source_path}: ${(error as Error).message}`);
        }
      }
      return callBridge(ctx, "reload", { file, content: text }, target);
    },
  );

  // ---- Debugging ----

  server.registerTool(
    "eval_manim",
    {
      description: "Parse and validate a .manim source snippet. Returns parsed node names and per-node buildErrors[]. Each build error has 'node' (programmable name or '<filters>') and 'error' (message); runtime builder failures additionally include 'file', 'line', 'col', and optional 'code' ('not_a_number', 'missing_ref', etc.) for clickable diagnostics.",
      inputSchema: {
        source: z.string().describe("The .manim source code to parse"),
        target,
      },
    },
    async ({ source, target }) => callBridge(ctx, "eval_manim", { source }, target),
  );

  server.registerTool(
    "list_resources",
    { description: "List all loaded resources: sprite sheets, fonts, .manim files, .anim files", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "list_resources", {}, target),
  );

  // ---- Event Injection ----

  server.registerTool(
    "send_event",
    {
      description: `Inject an input event into the running application. Event types:
- click: mouse click (push + release) at x,y with button (0=left, 1=middle, 2=right)
- mouse_down / mouse_up: separate push/release at x,y
- move: mouse move to x,y
- key_down / key_up: keyboard key press/release with keyCode (hxd.Key constants)
- key_press: key_down + key_up combined
- text: text input with charCode
- wheel: mouse wheel with delta at x,y

A key down and up inside one frame is not seen by code that polls hxd.Key each frame: use send_events with a {step:1} between key_down and key_up.

Common key codes: SPACE=32, ENTER=13, ESCAPE=27, TAB=9, A=65, 0=48, UP=38, DOWN=40, LEFT=37, RIGHT=39, F1=112`,
      inputSchema: {
        type: z.enum(["click", "mouse_down", "mouse_up", "move", "key_down", "key_up", "key_press", "text", "wheel"])
          .describe("Event type"),
        x: z.number().optional().describe("Mouse X position (scene coordinates)"),
        y: z.number().optional().describe("Mouse Y position (scene coordinates)"),
        button: z.number().optional().describe("Mouse button: 0=left, 1=middle, 2=right"),
        keyCode: z.number().optional().describe("Keyboard key code (hxd.Key constants)"),
        charCode: z.number().optional().describe("Character code for text input"),
        delta: z.number().optional().describe("Mouse wheel delta (positive=scroll down)"),
        target,
      },
    },
    async ({ target, ...params }) => callBridge(ctx, "send_event", params, target),
  );

  // ======== v2: Game Control ========

  server.registerTool(
    "pause",
    {
      description: "Pause or resume the game loop. When paused, all game logic, animations, and rendering stop but the DevBridge remains responsive for inspection. Use step() to advance frame-by-frame while paused. A browser game's tab must be visible: a hidden tab stops its frames.",
      inputSchema: {
        paused: z.boolean().optional().describe("True to pause, false to resume (default: true)"),
        target,
      },
    },
    async ({ paused, target }) => callBridge(ctx, "pause", { paused }, target),
  );

  server.registerTool(
    "step",
    {
      description: "Advance the game by N frames while paused, then re-pause. Game must be paused first.",
      inputSchema: {
        frames: z.number().optional().describe("Number of frames to advance (default: 1, max: 100)"),
        target,
      },
    },
    async ({ frames, target }) => callBridge(ctx, "step", { frames }, target),
  );

  server.registerTool(
    "quit",
    { description: "Cleanly shut down the running game application (HashLink only: a browser page answers not_supported)", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "quit", {}, target),
  );

  // ======== v2: Trace & Error Capture ========

  server.registerTool(
    "get_traces",
    {
      description: "Get recent trace() output from the running application (ring buffer of last 200 lines)",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the trace buffer after reading (default: false)"),
        limit: z.number().optional().describe("Max number of lines to return (default: 50)"),
        target,
      },
    },
    async ({ clear, limit, target }) => callBridge(ctx, "get_traces", { clear, limit }, target),
  );

  server.registerTool(
    "get_errors",
    {
      description: "Get accumulated runtime errors/exceptions since last query. In a browser game, errors the page itself reports (uncaught exceptions, failed promises, a lost WebGL context, a resource that failed to load) are included, prefixed [browser].",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the error buffer after reading (default: true)"),
        target,
      },
    },
    async ({ clear, target }) => callBridge(ctx, "get_errors", { clear }, target),
  );

  server.registerTool(
    "get_debugger_hits",
    {
      description: "Poll recent hits from DevBridge.debugger(data, pause?) calls placed in the game (JS-debugger-style breakpoint). Each hit has {id, data, paused, file, line, method, timestamp}. Use since_id from a previous call as a cursor to get only new hits. Hits also appear in the events tool (kind 'debugger'). If paused=true, the game is paused at the hit — resume with pause({paused:false}).",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the buffer after reading (default: false)"),
        limit: z.number().optional().describe("Max hits to return (default: 50, max: 100)"),
        since_id: z.number().optional().describe("Only return hits with id > since_id. Use the lastId from a previous response as a cursor."),
        target,
      },
    },
    async ({ clear, limit, since_id, target }) =>
      callBridge(ctx, "get_debugger_hits", { clear, limit, since_id }, target),
  );

  // ======== v2: Deep Inspection ========

  server.registerTool(
    "get_parameters",
    {
      description: "Get current parameter values and definitions for a live programmable instance",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
        target,
      },
    },
    async ({ programmable, target }) => callBridge(ctx, "get_parameters", { programmable }, target),
  );

  server.registerTool(
    "list_interactives",
    {
      description: "List all registered interactive hit-test regions on a screen with their IDs, positions, and metadata",
      inputSchema: {
        screen: z.string().optional().describe("Screen name. If omitted, aggregates interactives from all active screens."),
        target,
      },
    },
    async ({ screen, target }) => callBridge(ctx, "list_interactives", { screen }, target),
  );

  server.registerTool(
    "list_slots",
    {
      description: "List all slots (swappable containers) on a programmable with their occupied/empty status",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
        target,
      },
    },
    async ({ programmable, target }) => callBridge(ctx, "list_slots", { programmable }, target),
  );

  server.registerTool(
    "get_tween_state",
    { description: "Get all active tweens/animations with their targets, duration, elapsed time, and progress", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "get_tween_state", {}, target),
  );

  server.registerTool(
    "get_screen_state",
    { description: "Get detailed screen manager state: mode, active screens, transition status, pause state, element/interactive counts", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "get_screen_state", {}, target),
  );

  server.registerTool(
    "find_element_at",
    {
      description: "Hit-test a screen position to find all scene graph objects at the given coordinates, sorted front-to-back by depth",
      inputSchema: {
        x: z.number().describe("X coordinate in scene space"),
        y: z.number().describe("Y coordinate in scene space"),
        relative_to: z.string().optional().describe("Element name for relative coordinates. If provided, x,y are in that element's local space"),
        target,
      },
    },
    async ({ x, y, relative_to, target }) => callBridge(ctx, "find_element_at", { x, y, relative_to }, target),
  );

  server.registerTool(
    "inspect_programmable",
    {
      description: "Deep inspection of a live programmable: current parameter values, slots, dynamic refs, named elements, interactives, and settings",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
        target,
      },
    },
    async ({ programmable, target }) => callBridge(ctx, "inspect_programmable", { programmable }, target),
  );

  // ======== v3: Health, Resources, Coordinates, Idle ========

  server.registerTool(
    "ping",
    { description: "Health check - returns uptime and port. Lightweight alternative to performance for connection testing.", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "ping", {}, target),
  );

  server.registerTool(
    "list_fonts",
    { description: "List all registered font names available for use in .manim files", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "list_fonts", {}, target),
  );

  server.registerTool(
    "list_atlases",
    { description: "List all loaded sprite atlases with their tile/sprite names", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "list_atlases", {}, target),
  );

  server.registerTool(
    "coordinate_transform",
    {
      description: "Transform coordinates between local and global space relative to a named element. Use to_local to convert scene coords to element-local, to_global to convert element-local to scene coords.",
      inputSchema: {
        element: z.string().describe("Element name (h2d.Object.name)"),
        x: z.number().describe("X coordinate"),
        y: z.number().describe("Y coordinate"),
        direction: z.enum(["to_local", "to_global"]).describe("Transform direction: to_local (scene→element) or to_global (element→scene)"),
        screen: z.string().optional().describe("Screen name to scope element search (searches all if omitted)"),
        target,
      },
    },
    async ({ element, x, y, direction, screen, target }) =>
      callBridge(ctx, "coordinate_transform", { element, x, y, direction, screen }, target),
  );

  server.registerTool(
    "wait_for_idle",
    { description: "Check if the system is idle (no active tweens, no screen transitions). Returns current state without blocking.", inputSchema: { target } },
    async ({ target }) => callBridge(ctx, "wait_for_idle", {}, target),
  );

  // ======== v5: Direct Actions ========

  server.registerTool(
    "click_button",
    {
      description: `Directly click an interactive button by its ID, bypassing coordinate-based hit testing. Works even if the button is scrolled off-screen or obscured by other elements. Use list_interactives to discover available button IDs.`,
      inputSchema: {
        id: z.string().describe("Interactive identifier (as returned by list_interactives)"),
        screen: z.string().optional().describe("Screen name to scope the search. If omitted, searches all active screens."),
        target,
      },
    },
    async ({ id, screen, target }) => callBridge(ctx, "click_interactive", { id, screen }, target),
  );

  // ======== v6: Batch Events ========

  server.registerTool(
    "send_events",
    {
      description: `Send a sequence of input events with game frame steps between them. Enables multi-step interactions (drag-and-drop, slider scrub, card hand drag) in a single call.

Each entry in the events array is either:
- An event: {type, x, y, button, ...} (same params as send_event)
- A frame step: {step: N} — advance N game frames (processes animations, state machines, zone detection)

The game must be paused for frame steps to work. Use auto_pause:true to auto-pause before and resume after.
A key must be held for at least a frame to be seen by code that polls keys: put {step:1} between key_down and key_up.

Example drag: [
  {type:"mouse_down", x:100, y:200},
  {step:2},
  {type:"move", x:200, y:150},
  {step:1},
  {type:"move", x:300, y:100},
  {step:1},
  {type:"mouse_up", x:300, y:100}
]`,
      inputSchema: {
        events: z.array(z.record(z.string(), z.any())).describe("Array of event objects ({type,x,y,...}) and frame steps ({step:N})"),
        auto_pause: z.boolean().optional().describe("Auto-pause before executing and resume after (default: false). Enables frame steps without manual pause/resume."),
        target,
      },
    },
    async ({ events, auto_pause, target }) => callBridge(ctx, "send_events", { events, auto_pause }, target),
  );

  // ======== v7: Active Programmables ========

  server.registerTool(
    "list_active_programmables",
    {
      description: `List all live incremental-mode programmables currently in the scene. Returns current parameter values, parameter definitions (types), named elements, slots, interactive counts, position, and visibility for each. Only programmables built with incremental:true are tracked.`,
      inputSchema: {
        programmable: z.string().optional().describe("Filter by programmable name. If omitted, returns all active programmables."),
        sceneGraph: z.boolean().optional().describe("Include scene graph subtree for each programmable (default: false)"),
        depth: z.number().optional().describe("Scene graph depth when sceneGraph is true (default: 6)"),
        target,
      },
    },
    async ({ programmable, sceneGraph, depth, target }) =>
      callBridge(ctx, "list_active_programmables", { programmable, sceneGraph, depth }, target),
  );

  // ======== v4: Layout Validation ========

  server.registerTool(
    "check_overlaps",
    {
      description: `Detect overlapping elements to find layout bugs and broken click targets.
- Interactive overlaps (severity: high): two clickable regions overlap, causing unreliable clicks
- Visual overlaps (severity: low): sibling elements with overlapping bounds (parent-child overlap is normal and ignored)
Returns overlap pairs with their bounds, overlap rectangle, and overlap area in pixels.`,
      inputSchema: {
        screen: z.string().optional().describe("Screen name. If omitted, checks all active screens."),
        mode: z.enum(["all", "interactives", "visual"]).optional().describe("What to check: 'interactives' for click regions only, 'visual' for sibling visual overlaps, 'all' for both (default: all)"),
        min_overlap_area: z.number().optional().describe("Minimum overlap area in px² to report (default: 1). Use higher values to filter trivial edge-touching."),
        include_hidden: z.boolean().optional().describe("Include non-visible/disabled elements (default: false)"),
        target,
      },
    },
    async ({ screen, mode, min_overlap_area, include_hidden, target }) =>
      callBridge(ctx, "check_overlaps", { screen, mode, min_overlap_area, include_hidden }, target),
  );

  // ======== v8: Custom game ops (query / command / event) ========

  server.registerTool(
    "list_game_ops",
    {
      description: `List game-specific custom operations registered by the running game. Returns {queries, commands, events}, each entry has {op|name, description, params|payload} where params/payload is a schema-lite hint (e.g. {lane: "int", count: "int?"}). Call this first to discover what the current game exposes, then use game_op to invoke a query/command, or get_game_events to poll events.`,
      inputSchema: { target },
    },
    async ({ target }) => callBridge(ctx, "list_game_ops", {}, target),
  );

  server.registerTool(
    "game_op",
    {
      description: `Invoke a game-specific custom query or command registered by the running game. Use list_game_ops to discover available ops and their param shapes. Returns {kind: "query"|"command", op, result}. Errors with code "not_found" for unknown ops, "internal" if the handler throws.`,
      inputSchema: {
        op: z.string().describe("Op identifier (from list_game_ops)"),
        params: z.record(z.string(), z.any()).optional().describe("Handler-specific params object"),
        target,
      },
    },
    async ({ op, params, target }) => callBridge(ctx, "game_op", { op, params }, target),
  );

  server.registerTool(
    "get_game_events",
    {
      description: `Poll custom game events emitted via DevBridge.emitEvent(name, data) on the Haxe side. They also appear in the events tool (kind "game_event"). Mirrors the get_debugger_hits cursor pattern: use since_id from the previous response to fetch only new events.`,
      inputSchema: {
        types: z.array(z.string()).optional().describe("Filter by event names (e.g. [\"unit_died\", \"wave_completed\"]). Omit to return all types."),
        since_id: z.number().optional().describe("Return only events with id > since_id. Use lastId from a previous response as a cursor."),
        limit: z.number().optional().describe("Max events to return (default: 50, max: 200)"),
        clear: z.boolean().optional().describe("Clear the buffer after reading (default: false)"),
        target,
      },
    },
    async ({ types, since_id, limit, clear, target }) =>
      callBridge(ctx, "get_game_events", { types, since_id, limit, clear }, target),
  );

  // ======== The game's data: tables, picks and trees (hx-multianim's DataRegistry) ========

  server.registerTool(
    "list_data",
    {
      description: `The game's data: every table, pick and tree it has, loaded from a .manim data block or built in the game's own code and registered with DataRegistry.registerTable. Returns [{name, kind, rows, key, source, says?}] by name, kind "table", "tree" (a table whose rows name each other, such as an upgrade tree) or "pick" (how a table is drawn from: {over, by, chance, draws, repeats, otherwise?} instead of rows and key). source says where it is, to open it: {manim, block, line} for a data block, {code, className, method, line} for a table built in code. Then get_data for one in full, roll_pick to draw from a pick.`,
      inputSchema: { target },
    },
    async ({ target }) => callData(ctx, "data_list", {}, target),
  );

  server.registerTool(
    "get_data",
    {
      description: `One table, pick or tree of the game's data in full, by its name from list_data (cards.all, AllCards). A table: {name, kind, key, source, says?, columns, rows, rowMeta?, tree?}; columns are {id, type (int, float, string, bool, enum, record, ref), optional?, many?, key?, whole?, options? (an enum's values), to? (the enum, the record, or the record a ref names), columns? (a record's own), unit?, meta? (the column's annotations, such as range)}; rows are plain objects, an enum's value and a ref's id as words, a record inside a row by its own columns; rowMeta is each row's annotations by id (@by(claude) is {by: "claude"}); a tree adds {tree: {by, edges: [{from, to}]}}. A pick: {over, by, chance, draws, repeats, otherwise?, source, odds: [{id, share, chance}], nothing}, its odds exact. Errors with code "not_found" for a name the game does not have.`,
      inputSchema: {
        name: z.string().describe("The name from list_data: cards.all, cards.reward, AllCards"),
        target,
      },
    },
    async ({ name, target }) => callData(ctx, "data_get", { name }, target),
  );

  server.registerTool(
    "roll_pick",
    {
      description: `Draw from one of the game's picks with the game's own picker and a seed: the rows the game draws from the same seed with new DataRandom(seed). The random is Mulberry32, so a tool with the usual JavaScript mulberry32 gets the same numbers from the same seed. Returns {name, seed, draws, picked: [ids]}. Draw many times with different seeds to see a pick's spread; get_data gives its exact odds.`,
      inputSchema: {
        name: z.string().describe("A pick's name from list_data (kind \"pick\"): cards.reward"),
        seed: z.number().int().optional().describe("The seed (default: 1)"),
        n: z.number().int().min(1).optional().describe("How many rows to draw (default: the pick's own draws)"),
        target,
      },
    },
    async ({ name, seed, n, target }) => callData(ctx, "data_pick", { name, seed, n }, target),
  );
}

/**
 * A call for the game's data. A game built on an hx-multianim that predates its data tables has no
 * such method, and is told so in words rather than as an unknown method.
 */
async function callData(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown>,
  targetId?: string,
): Promise<ToolResult> {
  try {
    const instance = await ctx.registry.resolve(targetId);
    return textResult(await instance.transport.call(method, params));
  } catch (error) {
    if (error instanceof DevBridgeError && error.code === "unknown_method")
      return toolError(
        "not_supported",
        `This game's DevBridge has no ${method}: its hx-multianim predates data tables (bh.multianim.data.DataRegistry). Update hx-multianim and build the game again.`,
      );
    return errorResult(error);
  }
}
