# hx-multianim-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects Claude (or any MCP client) to a running [hx-multianim](https://github.com/bh213/hx-multianim) application via its DevBridge.

> **Call `connect` first.** All other tools return a `not_connected` error until `connect` succeeds. The DevBridge port is printed to game stdout as `[DevBridge] Listening on port N` (default 9001).

## Tools

### Connection & health
| Tool          | Description                                                                   |
|---------------|-------------------------------------------------------------------------------|
| `connect`     | Connect to a game instance on a specific port/host. **Must be called first.** |
| `ping`        | Lightweight health check — uptime and port                                    |
| `performance` | FPS, draw calls, triangle count, object count, scene dimensions               |

### Scene inspection
| Tool                        | Description                                                            |
|-----------------------------|------------------------------------------------------------------------|
| `list_screens`              | Registered screens with active/failed status                           |
| `list_builders`             | Loaded `.manim` builders and their parameter definitions               |
| `scene_graph`               | Recursive scene tree dump (`depth`)                                    |
| `inspect_element`           | Position, size, visibility, text of a named element                    |
| `inspect_programmable`      | Deep inspection of a live programmable (params, slots, refs, elements) |
| `find_element_at`           | Hit-test scene coords, front-to-back list of objects                   |
| `get_screen_state`          | Screen manager state: mode, transitions, pause, counts                 |
| `get_tween_state`           | All active tweens with target, duration, progress                      |
| `list_interactives`         | Interactive hit-test regions with IDs and bounds                       |
| `list_slots`                | Swappable container slots of a programmable                            |
| `list_active_programmables` | Live incremental-mode programmables with current state                 |
| `list_resources`            | Loaded sprites, fonts, `.manim`, `.anim` files                         |
| `list_fonts`                | Registered font names                                                  |
| `list_atlases`              | Loaded sprite atlases and tile/sprite names                            |
| `coordinate_transform`      | Convert between scene and element-local coordinates                    |
| `check_overlaps`            | Detect overlapping interactives/visuals to find layout bugs            |

### Screenshots
| Tool | Description |
|------|-------------|
| `screenshot` | Capture current frame as PNG (optional `width`/`height` scale-down) |

### State manipulation
| Tool             | Description                                                   |
|------------------|---------------------------------------------------------------|
| `set_parameter`  | Modify a programmable parameter at runtime (incremental mode) |
| `get_parameters` | Current parameter values and definitions for a programmable   |
| `set_visibility` | Toggle element visibility                                     |
| `reload`         | Hot-reload `.manim` files (specific file or all changed)      |
| `eval_manim`     | Parse and validate `.manim` snippets                          |

### Game control
| Tool            | Description                               |
|-----------------|-------------------------------------------|
| `pause`         | Pause/resume the game loop                |
| `step`          | Advance N frames while paused (max 100)   |
| `wait_for_idle` | Check if no tweens/transitions are active |
| `quit`          | Cleanly shut down the game                |

### Input injection
| Tool           | Description                                                            |
|----------------|------------------------------------------------------------------------|
| `send_event`   | Inject a single mouse/keyboard/wheel event                             |
| `send_events`  | Sequence of events with frame steps (drag, scrub, multi-step gestures) |
| `click_button` | Click an interactive by ID, bypassing hit testing                      |

### Diagnostics
| Tool                | Description                                                            |
|---------------------|------------------------------------------------------------------------|
| `get_traces`        | Recent `trace()` output (ring buffer)                                  |
| `get_errors`        | Accumulated runtime errors/exceptions                                  |
| `get_debugger_hits` | Poll `DevBridge.debugger(data, pause?)` breakpoint hits (cursor-based) |

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
