# hx-multianim-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects Claude (or any MCP client) to a running [hx-multianim](https://github.com/bh213/hx-multianim) application via its DevBridge.

> **Call `connect` first.** All other tools return a `not_connected` error until `connect` succeeds. The DevBridge port is printed to game stdout as `[DevBridge] Listening on port N` (default 9001).

## Tools

| Tool | Description |
|------|-------------|
| `performance` | FPS, draw calls, triangle count, scene dimensions |
| `list_screens` | Registered screens with active/failed status |
| `list_builders` | Loaded `.manim` builders and their parameters |
| `scene_graph` | Recursive scene tree dump |
| `inspect_element` | Position, size, visibility of a named element |
| `screenshot` | Capture current frame as PNG |
| `set_parameter` | Modify a programmable parameter at runtime |
| `set_visibility` | Toggle element visibility |
| `reload` | Hot-reload `.manim` files |
| `eval_manim` | Parse and validate `.manim` snippets |
| `list_resources` | All loaded sprites, fonts, `.manim`, `.anim` files |
| `send_event` | Inject mouse, keyboard, and wheel events |
| `get_debugger_hits` | Poll `DevBridge.debugger(data, pause?)` breakpoint hits (ring buffer, cursor-based) |

## Breakpoints from game code

Call `DevBridge.debugger(data, pause)` anywhere in your game code to capture a data snapshot (with auto-captured file/line/method):

```haxe
screenManager.devBridge.debugger({hp: unit.hp, target: unit.target?.name});     // pauses by default
screenManager.devBridge.debugger({fps: hxd.Timer.fps()}, false);                 // push-only, no pause
```

Hits are delivered two ways:
- **Push** — real-time `debugger` SSE events surfaced as warning-level MCP log notifications.
- **Poll** — `get_debugger_hits` tool with `since_id` cursor (in case the agent missed the push).

If `pause=true`, resume with `pause({paused:false})`.

## Usage

### Claude Code

```json
// .mcp.json
{
  "mcpServers": {
    "hx-multianim": {
      "command": "npx",
      "args": ["-y", "@bh213/hx-multianim-mcp"]
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HX_DEV_PORT` | `9001` | DevBridge port |
| `HX_DEV_HOST` | `localhost` | DevBridge host |

## License

BSD-3-Clause
