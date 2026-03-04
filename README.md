# hx-multianim-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects Claude (or any MCP client) to a running [hx-multianim](https://github.com/bh213/hx-multianim) application via its DevBridge.

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
