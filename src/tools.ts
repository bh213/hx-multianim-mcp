/**
 * MCP tool definitions for hx-multianim DevBridge.
 * Each tool maps to a DevBridge HTTP method.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DevBridge } from "./bridge.js";

export function registerTools(server: McpServer, bridge: DevBridge): void {
  // ---- Performance & Status ----

  server.registerTool(
    "performance",
    { description: "Get FPS, draw calls, triangle count, object count, and scene dimensions" },
    async () => {
      const result = await bridge.call("performance");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- Scene Inspection ----

  server.registerTool(
    "list_screens",
    { description: "List all registered screens with their active/failed status" },
    async () => {
      const result = await bridge.call("list_screens");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_builders",
    { description: "List all loaded .manim builders with their programmable names and parameter definitions" },
    async () => {
      const result = await bridge.call("list_builders");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "scene_graph",
    {
      description: "Dump the scene graph tree showing object types, positions, visibility, and names",
      inputSchema: { depth: z.number().optional().describe("Maximum depth to traverse (default: 10)") },
    },
    async ({ depth }) => {
      const result = await bridge.call("scene_graph", { depth });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ screen, element }) => {
      const result = await bridge.call("inspect_element", { screen, element });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- Screenshot ----

  server.registerTool(
    "screenshot",
    {
      description: "Capture the current frame as a PNG image",
      inputSchema: {
        width: z.number().optional().describe("Width in pixels (default: scene width)"),
        height: z.number().optional().describe("Height in pixels (default: scene height)"),
      },
    },
    async ({ width, height }) => {
      const result = (await bridge.call("screenshot", { width, height })) as {
        base64: string;
        width: number;
        height: number;
      };
      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: "image/png" as const },
          { type: "text" as const, text: `Screenshot: ${result.width}x${result.height}` },
        ],
      };
    }
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
    async ({ programmable, param, value }) => {
      const result = await bridge.call("set_parameter", { programmable, param, value });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ screen, element, visible }) => {
      const result = await bridge.call("set_visibility", { screen, element, visible });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ file }) => {
      const result = await bridge.call("reload", { file });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ source }) => {
      const result = await bridge.call("eval_manim", { source });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_resources",
    { description: "List all loaded resources: sprite sheets, fonts, .manim files, .anim files" },
    async () => {
      const result = await bridge.call("list_resources");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async (params) => {
      const result = await bridge.call("send_event", params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ paused }) => {
      const result = await bridge.call("pause", { paused });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "step",
    {
      description: "Advance the game by N frames while paused, then re-pause. Game must be paused first.",
      inputSchema: {
        frames: z.number().optional().describe("Number of frames to advance (default: 1, max: 100)"),
      },
    },
    async ({ frames }) => {
      const result = await bridge.call("step", { frames });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "quit",
    { description: "Cleanly shut down the running game application" },
    async () => {
      const result = await bridge.call("quit");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ clear, limit }) => {
      const result = await bridge.call("get_traces", { clear, limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_errors",
    {
      description: "Get accumulated runtime errors/exceptions since last query",
      inputSchema: {
        clear: z.boolean().optional().describe("Clear the error buffer after reading (default: true)"),
      },
    },
    async ({ clear }) => {
      const result = await bridge.call("get_errors", { clear });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ programmable }) => {
      const result = await bridge.call("get_parameters", { programmable });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_interactives",
    {
      description: "List all registered interactive hit-test regions on a screen with their IDs, positions, and metadata",
      inputSchema: {
        screen: z.string().optional().describe("Screen name. If omitted, aggregates interactives from all active screens."),
      },
    },
    async ({ screen }) => {
      const result = await bridge.call("list_interactives", { screen });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_slots",
    {
      description: "List all slots (swappable containers) on a programmable with their occupied/empty status",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
      },
    },
    async ({ programmable }) => {
      const result = await bridge.call("list_slots", { programmable });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_tween_state",
    { description: "Get all active tweens/animations with their targets, duration, elapsed time, and progress" },
    async () => {
      const result = await bridge.call("get_tween_state");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_screen_state",
    { description: "Get detailed screen manager state: mode, active screens, transition status, pause state, element/interactive counts" },
    async () => {
      const result = await bridge.call("get_screen_state");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ x, y, relative_to }) => {
      const result = await bridge.call("find_element_at", { x, y, relative_to });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "inspect_programmable",
    {
      description: "Deep inspection of a live programmable: current parameter values, slots, dynamic refs, named elements, interactives, and settings",
      inputSchema: {
        programmable: z.string().describe("Programmable name"),
      },
    },
    async ({ programmable }) => {
      const result = await bridge.call("inspect_programmable", { programmable });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ======== v3: Health, Resources, Coordinates, Idle ========

  server.registerTool(
    "ping",
    { description: "Health check - returns uptime and port. Lightweight alternative to performance for connection testing." },
    async () => {
      const result = await bridge.call("ping");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_fonts",
    { description: "List all registered font names available for use in .manim files" },
    async () => {
      const result = await bridge.call("list_fonts");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "list_atlases",
    { description: "List all loaded sprite atlases with their tile/sprite names" },
    async () => {
      const result = await bridge.call("list_atlases");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ element, x, y, direction, screen }) => {
      const result = await bridge.call("coordinate_transform", { element, x, y, direction, screen });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "wait_for_idle",
    { description: "Check if the system is idle (no active tweens, no screen transitions). Returns current state without blocking." },
    async () => {
      const result = await bridge.call("wait_for_idle");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ id, screen }) => {
      const result = await bridge.call("click_interactive", { id, screen });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
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
    async ({ screen, mode, min_overlap_area, include_hidden }) => {
      const result = await bridge.call("check_overlaps", { screen, mode, min_overlap_area, include_hidden });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
