/**
 * MCP tool definitions for hx-multianim DevBridge.
 * Each tool maps to a DevBridge HTTP method.
 *
 * Error handling: DevBridgeError from bridge.call() is caught and returned
 * as {isError: true} with structured JSON ({error, code}) so Claude can
 * differentiate connection_failed / not_found / invalid_params / invalid_state / internal.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { z } from "zod";
import { DevBridge, DevBridgeError } from "./bridge.js";
import type { SseClient } from "./sse.js";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };
type ToolResult = { content: ToolContent[]; isError?: boolean };

/** Return a structured tool error with code for programmatic differentiation. */
function toolError(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

/** Call bridge method and return JSON result, or structured isError on failure. */
async function callBridge(
  bridge: DevBridge,
  method: string,
  params?: Record<string, unknown>,
): Promise<ToolResult> {
  if (!bridge.connected) {
    return toolError("not_connected", "Not connected to a game instance. Call the 'connect' tool first with the appropriate port.");
  }
  try {
    const result = await bridge.call(method, params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof DevBridgeError) {
      return toolError(error.code, error.message);
    }
    throw error;
  }
}

/** Resize a PNG image buffer to the given dimensions. Returns resized PNG buffer and dimensions. */
async function scaleImage(png: Buffer, width: number, height: number): Promise<{ data: Buffer; width: number; height: number }> {
  const data = await sharp(png).resize(width, height).png().toBuffer();
  return { data, width, height };
}

export function registerTools(server: McpServer, bridge: DevBridge, sse: SseClient): void {
  // ---- Connection ----

  server.registerTool(
    "connect",
    {
      description: "Connect to a game instance on a specific port (and optionally host). Sets up both DevBridge and SSE connections. Must be called before using any other tools. Default port is 9001, but the actual port should be obtained from the game's stdout output, e.g.: [DevBridge] Listening on port 9002",
      inputSchema: {
        port: z.number().describe("DevBridge port number"),
        host: z.string().optional().describe("DevBridge host (default: localhost)"),
      },
    },
    async ({ port, host }) => {
      const targetHost = host ?? "localhost";
      bridge.reconnect(targetHost, port);
      sse.reconnect(targetHost, port);
      // Verify connection with a ping
      try {
        const result = await bridge.call("ping");
        return { content: [{ type: "text" as const, text: JSON.stringify({ connected: true, host: targetHost, port, ping: result }, null, 2) }] };
      } catch (error) {
        if (error instanceof DevBridgeError) {
          return toolError(error.code, `Switched to ${targetHost}:${port} but ping failed: ${error.message}`);
        }
        throw error;
      }
    },
  );

  // ---- Performance & Status ----

  server.registerTool(
    "performance",
    { description: "Get FPS, draw calls, triangle count, object count, and scene dimensions" },
    async () => callBridge(bridge, "performance"),
  );

  // ---- Scene Inspection ----

  server.registerTool(
    "list_screens",
    { description: "List all registered screens with their active/failed status" },
    async () => callBridge(bridge, "list_screens"),
  );

  server.registerTool(
    "list_builders",
    { description: "List all loaded .manim builders with their programmable names and parameter definitions" },
    async () => callBridge(bridge, "list_builders"),
  );

  server.registerTool(
    "scene_graph",
    {
      description: "Dump the scene graph tree showing object types, positions, visibility, and names",
      inputSchema: { depth: z.number().optional().describe("Maximum depth to traverse (default: 10)") },
    },
    async ({ depth }) => callBridge(bridge, "scene_graph", { depth }),
  );

  server.registerTool(
    "inspect_element",
    {
      description: "Get detailed info about a named element on a screen (position, size, visibility, text content)",
      inputSchema: {
        screen: z.string().describe("Screen name"),
        element: z.string().describe("Element name (h2d.Object.name)"),
      },
    },
    async ({ screen, element }) => callBridge(bridge, "inspect_element", { screen, element }),
  );

  // ---- Screenshot ----

  server.registerTool(
    "screenshot",
    {
      description: "Capture the current frame as a PNG image. Provide width and/or height to scale down (aspect ratio is preserved when only one is given; error if both are given with wrong aspect ratio).",
      inputSchema: {
        width: z.number().optional().describe("Target width in pixels. If only width is provided, height is computed to preserve aspect ratio."),
        height: z.number().optional().describe("Target height in pixels. If only height is provided, width is computed to preserve aspect ratio."),
      },
    },
    async ({ width, height }) => {
      if (!bridge.connected) {
        return toolError("not_connected", "Not connected to a game instance. Call the 'connect' tool first with the appropriate port.");
      }
      try {
        const result = (await bridge.call("screenshot")) as {
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
        if (error instanceof DevBridgeError) {
          return toolError(error.code, error.message);
        }
        throw error;
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
      },
    },
    async ({ programmable, param, value }) =>
      callBridge(bridge, "set_parameter", { programmable, param, value }),
  );

  server.registerTool(
    "set_visibility",
    {
      description: "Toggle visibility of a named element on a screen",
      inputSchema: {
        screen: z.string().describe("Screen name"),
        element: z.string().describe("Element name"),
        visible: z.boolean().describe("Whether the element should be visible"),
      },
    },
    async ({ screen, element, visible }) =>
      callBridge(bridge, "set_visibility", { screen, element, visible }),
  );

  // ---- Hot Reload ----

  server.registerTool(
    "reload",
    {
      description: "Hot-reload a .manim file (or all files if no file specified)",
      inputSchema: {
        file: z.string().optional().describe("Resource path to reload (e.g. 'ui/menu.manim'). Omit to reload all changed files."),
      },
    },
    async ({ file }) => callBridge(bridge, "reload", { file }),
  );

  // ---- Debugging ----

  server.registerTool(
    "eval_manim",
    {
      description: "Parse and validate a .manim source snippet. Returns parsed node names and any build errors (missing fonts, invalid tiles, type mismatches)",
      inputSchema: {
        source: z.string().describe("The .manim source code to parse"),
      },
    },
    async ({ source }) => callBridge(bridge, "eval_manim", { source }),
  );

  server.registerTool(
    "list_resources",
    { description: "List all loaded resources: sprite sheets, fonts, .manim files, .anim files" },
    async () => callBridge(bridge, "list_resources"),
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
      },
    },
    async (params) => callBridge(bridge, "send_event", params),
  );

  // ======== v2: Game Control ========

  server.registerTool(
    "pause",
    {
      description: "Pause or resume the game loop. When paused, all game logic, animations, and rendering stop but the DevBridge remains responsive for inspection. Use step() to advance frame-by-frame while paused.",
      inputSchema: {
        paused: z.boolean().optional().describe("True to pause, false to resume (default: true)"),
      },
    },
    async ({ paused }) => callBridge(bridge, "pause", { paused }),
  );

  server.registerTool(
    "step",
    {
      description: "Advance the game by N frames while paused, then re-pause. Game must be paused first.",
      inputSchema: {
        frames: z.number().optional().describe("Number of frames to advance (default: 1, max: 100)"),
      },
    },
    async ({ frames }) => callBridge(bridge, "step", { frames }),
  );

  server.registerTool(
    "quit",
    { description: "Cleanly shut down the running game application" },
    async () => callBridge(bridge, "quit"),
  );

  // ======== v2: Trace & Error Capture ========

  server.registerTool(
    "get_traces",
    {
      description: "Get recent trace() output from the running application (ring buffer of last 200 lines)",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the trace buffer after reading (default: false)"),
        limit: z.number().optional().describe("Max number of lines to return (default: 50)"),
      },
    },
    async ({ clear, limit }) => callBridge(bridge, "get_traces", { clear, limit }),
  );

  server.registerTool(
    "get_errors",
    {
      description: "Get accumulated runtime errors/exceptions since last query",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the error buffer after reading (default: true)"),
      },
    },
    async ({ clear }) => callBridge(bridge, "get_errors", { clear }),
  );

  // ======== v2: Deep Inspection ========

  server.registerTool(
    "get_parameters",
    {
      description: "Get current parameter values and definitions for a live programmable instance",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
      },
    },
    async ({ programmable }) => callBridge(bridge, "get_parameters", { programmable }),
  );

  server.registerTool(
    "list_interactives",
    {
      description: "List all registered interactive hit-test regions on a screen with their IDs, positions, and metadata",
      inputSchema: {
        screen: z.string().optional().describe("Screen name. If omitted, aggregates interactives from all active screens."),
      },
    },
    async ({ screen }) => callBridge(bridge, "list_interactives", { screen }),
  );

  server.registerTool(
    "list_slots",
    {
      description: "List all slots (swappable containers) on a programmable with their occupied/empty status",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
      },
    },
    async ({ programmable }) => callBridge(bridge, "list_slots", { programmable }),
  );

  server.registerTool(
    "get_tween_state",
    { description: "Get all active tweens/animations with their targets, duration, elapsed time, and progress" },
    async () => callBridge(bridge, "get_tween_state"),
  );

  server.registerTool(
    "get_screen_state",
    { description: "Get detailed screen manager state: mode, active screens, transition status, pause state, element/interactive counts" },
    async () => callBridge(bridge, "get_screen_state"),
  );

  server.registerTool(
    "find_element_at",
    {
      description: "Hit-test a screen position to find all scene graph objects at the given coordinates, sorted front-to-back by depth",
      inputSchema: {
        x: z.number().describe("X coordinate in scene space"),
        y: z.number().describe("Y coordinate in scene space"),
        relative_to: z.string().optional().describe("Element name for relative coordinates. If provided, x,y are in that element's local space"),
      },
    },
    async ({ x, y, relative_to }) => callBridge(bridge, "find_element_at", { x, y, relative_to }),
  );

  server.registerTool(
    "inspect_programmable",
    {
      description: "Deep inspection of a live programmable: current parameter values, slots, dynamic refs, named elements, interactives, and settings",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
      },
    },
    async ({ programmable }) => callBridge(bridge, "inspect_programmable", { programmable }),
  );

  // ======== v3: Health, Resources, Coordinates, Idle ========

  server.registerTool(
    "ping",
    { description: "Health check - returns uptime and port. Lightweight alternative to performance for connection testing." },
    async () => callBridge(bridge, "ping"),
  );

  server.registerTool(
    "list_fonts",
    { description: "List all registered font names available for use in .manim files" },
    async () => callBridge(bridge, "list_fonts"),
  );

  server.registerTool(
    "list_atlases",
    { description: "List all loaded sprite atlases with their tile/sprite names" },
    async () => callBridge(bridge, "list_atlases"),
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
      },
    },
    async ({ element, x, y, direction, screen }) =>
      callBridge(bridge, "coordinate_transform", { element, x, y, direction, screen }),
  );

  server.registerTool(
    "wait_for_idle",
    { description: "Check if the system is idle (no active tweens, no screen transitions). Returns current state without blocking." },
    async () => callBridge(bridge, "wait_for_idle"),
  );

  // ======== v5: Direct Actions ========

  server.registerTool(
    "click_button",
    {
      description: `Directly click an interactive button by its ID, bypassing coordinate-based hit testing. Works even if the button is scrolled off-screen or obscured by other elements. Use list_interactives to discover available button IDs.`,
      inputSchema: {
        id: z.string().describe("Interactive identifier (as returned by list_interactives)"),
        screen: z.string().optional().describe("Screen name to scope the search. If omitted, searches all active screens."),
      },
    },
    async ({ id, screen }) => callBridge(bridge, "click_interactive", { id, screen }),
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
      },
    },
    async ({ events, auto_pause }) => callBridge(bridge, "send_events", { events, auto_pause }),
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
      },
    },
    async ({ programmable, sceneGraph, depth }) =>
      callBridge(bridge, "list_active_programmables", { programmable, sceneGraph, depth }),
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
      },
    },
    async ({ screen, mode, min_overlap_area, include_hidden }) =>
      callBridge(bridge, "check_overlaps", { screen, mode, min_overlap_area, include_hidden }),
  );
}
