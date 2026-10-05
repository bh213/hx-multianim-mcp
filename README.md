# hx-multianim-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects Claude (or any MCP client) to a running [hx-multianim](https://github.com/bh213/hx-multianim) application via its DevBridge.

It reaches a game on HashLink over the DevBridge's HTTP server, and a game in a browser page over a WebSocket relay the page dials into (`--listen`). Same tools, same answers.

> **Which game.** With exactly one game connected, every tool goes to it; `connect` is not needed. With none, the first call looks for a HashLink game on the default port (the port in `HX_DEV_READY_FILE`, else `HX_DEV_PORT`, else 9001). With several, pass `target` (an id from `list_instances`, e.g. `"http:9001"` or `"web-1"`, or a bare port) or choose one with `connect`. A HashLink game prints its port on startup: `[DevBridge] Listening on port N`.

## Tools

### Connection & health
| Tool          | Description                                                                   |
|---------------|-------------------------------------------------------------------------------|
| `connect`     | Choose the game calls go to: `{port, host?}` for a HashLink game (pinged first; nothing changes if it fails) or `{instance}` for a known one |
| `list_instances` | Browser games on the relay (app, title, URL, session), HashLink games connected, and DevBridges answering on the ten default ports |
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
| `reload`         | Hot-reload `.manim`/`.anim` files (specific file or all changed) |
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
| `events`            | Everything the connected games pushed (traces, errors, reloads, screen changes, breakpoints, game events), from a buffer this server keeps (last 1000), with a cursor (`since_id`) and `kinds` filter |

### Game ops
| Tool              | Description                                                                  |
|-------------------|------------------------------------------------------------------------------|
| `list_game_ops`   | The queries, commands and events the game registered, and the library's own queries (`builtIn`) |
| `game_op`         | Call one of them by name                                                      |
| `get_game_events` | Poll the events the game emitted (cursor-based)                              |

### Game data
Tables, picks and trees: what the game loaded from `.manim` data blocks, and the tables its own code registers with `DataRegistry.registerTable` (hx-multianim's `bh.multianim.data`).

| Tool         | Description                                                                                  |
|--------------|----------------------------------------------------------------------------------------------|
| `list_data`  | Every table, pick and tree: its kind, rows, and where it is (`.manim` file, block and line, or the code that builds it) |
| `get_data`   | One in full: a table's columns and rows (a tree's edges too), a pick's exact odds            |
| `roll_pick`  | Draw from a pick with the game's own picker and a seed: the rows the game draws from that seed |

A game built on an hx-multianim without data tables answers these with `not_supported`.

Every tool that talks to a game takes an optional `target`.

## Breakpoints from game code

Call `DevBridge.debugger(data, pause)` anywhere in your game code to capture a data snapshot (with auto-captured file/line/method):

```haxe
screenManager.devBridge.debugger({hp: unit.hp, target: unit.target?.name});     // pauses by default
screenManager.devBridge.debugger({fps: hxd.Timer.fps()}, false);                 // push-only, no pause
```

Hits are delivered three ways:
- **`events`** — kind `debugger`, with every other event, from this server's buffer (the reliable one: clients do not always put log notifications in the model's context).
- **Poll** — `get_debugger_hits` tool with `since_id` cursor.
- **Push** — warning-level MCP log notifications.

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

### A game in a browser: relay mode

A page cannot listen on a port, so the roles swap: this server listens and the game dials in.

```json
{
  "mcpServers": {
    "hx-multianim": {
      "command": "node",
      "args": ["../hx-multianim-mcp/dist/index.js", "--listen"]
    }
  }
}
```

`--listen` (or `--listen=9011`, or `HX_DEV_WS_PORT`) listens on `ws://127.0.0.1:9010`, trying the next nine ports when busy. Open the game built with `-D MULTIANIM_DEV` with `?devbridge=ws://127.0.0.1:9010` (add `&token=...` when a token is set). It appears in `list_instances` as `web-1` (the id stays while the page keeps its session, so a page that dials back after a restart is the same game). HashLink games work alongside it. In a browser game `reload` needs the file's text (`content`, or `source_path` for this server to read) and `quit` answers `not_supported`; its tab must be visible (a hidden tab stops its frames).

Wire protocol (one JSON object per message): the game sends `{"kind":"hello","protocol":1,"session",...}`, this server answers `{"kind":"welcome","instance":"web-1"}`, then sends `{"kind":"call","id","method","params"}` and gets `{"kind":"result","id","ok",...}`; the game pushes `{"kind":"event","seq","event","data"}`. See hx-multianim's `docs/devbridge.md`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HX_DEV_PORT` | `9001` | HashLink DevBridge port tried when nothing is connected |
| `HX_DEV_HOST` | `localhost` | HashLink DevBridge host |
| `HX_DEV_READY_FILE` | — | A game writes `{port}` here once listening; read in preference to `HX_DEV_PORT` |
| `HX_DEV_TOKEN` | — | Sent to every game (`X-HX-Dev-Token`), and required in every browser game's `hello` (refused with close code 4401 otherwise). Set the same token for the game |
| `HX_DEV_TIMEOUT_MS` | `10000` | A call with no answer by then fails with code `timeout` |
| `HX_DEV_WS_PORT` | — | Relay mode on this port (same as `--listen`) |
| `HX_DEV_WS_HOST` | `127.0.0.1` | Relay bind address |

### Error codes

Tool errors come back as `{error, code}` with `isError`: `not_connected`, `ambiguous_target`, `unknown_target`, `connection_failed`, `timeout`, `bad_reply`, `unauthorized`, and the DevBridge's own (`not_found`, `invalid_params`, `invalid_state`, `not_supported`, `unknown_method`, `internal`).

## Security

What this server is: a bridge from an MCP client to a game the developer is running, built with `-D MULTIANIM_DEV`. It does what the game's DevBridge does and nothing else.

- **Transport.** The MCP side is stdio only: no HTTP or WebSocket endpoint for clients. The game side is the DevBridge of a HashLink game (`localhost` unless `HX_DEV_HOST` names another host) or, in relay mode, a WebSocket server bound to `127.0.0.1` (`HX_DEV_WS_HOST`) that a game page dials into. Nothing is sent anywhere else.
- **Authentication.** Set `HX_DEV_TOKEN` in both the game and this server: it is sent with every call to a HashLink game and required in every browser game's `hello`. Without it, anything that can reach the DevBridge port can call it, which is the DevBridge's own default (`HX_DEV_BIND` on the game side chooses its bind address).
- **No code execution.** No tool runs a shell command or evaluates code. `eval_manim` parses and builds a `.manim` snippet with the game's own parser to report its errors; nothing it builds is shown, kept or run. `game_op` calls a handler the game registered in its own code, and does whatever that handler does.
- **Files.** This server reads two kinds of file: `HX_DEV_READY_FILE`, for the port a game wrote there, and `reload`'s `source_path`, only ever a `.manim` or `.anim` file, sent to the game as the new text of a resource. It writes no files.
- **What the game gives back** is the game's own state: scene graph, parameters, traces, errors, screenshots, the data tables it registered, and the events its code emits with `DevBridge.emitEvent`. All of it comes from the developer's own build, not from players or the network. Treat it as you would the game's logs.
- **Annotations.** Every tool declares [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations): the readers (`scene_graph`, `screenshot`, `eval_manim`, `list_*`, `get_data`, ...) are `readOnlyHint`; the setters and input tools (`set_parameter`, `reload`, `send_event`, `pause`, ...) write but are not destructive; `get_traces`, `get_errors`, `get_debugger_hits` and `get_game_events` can clear the buffer they read; `quit` and `game_op` (a command is whatever the game made it) are `destructiveHint`. Nothing is `openWorldHint`.

## Development

```bash
npm run build
npm test                    # node:test against fake games: HTTP + SSE and browser games over the relay
node scripts/smoke.mjs      # end to end: runs dist/ over stdio in relay mode and drives whatever
                            # games it finds (open a browser game with ?devbridge=ws://127.0.0.1:9010)
```

## License

BSD-3-Clause
