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
      description: "Parse a .manim source snippet and return the parsed node names (for validation/debugging)",
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
        delta: z.number().optional().describe("Mouse wheel delta (positive=up)"),
      },
    },
    async (params) => {
      const result = await bridge.call("send_event", params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
