// The server as a client sees it: tools over MCP (in memory), against fake games.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevServer, VERSION } from "../dist/server.js";
import { closedPort, fakeHttpBridge, fakeWsGame, waitFor } from "./fakes.mjs";

let open = [];
afterEach(async () => {
  for (const c of open.reverse()) await c();
  open = [];
});

async function start(options = {}) {
  const dev = await createDevServer({ autoDiscover: false, listen: { port: 0, host: "127.0.0.1" }, timeoutMs: 2000, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await dev.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  open.push(() => dev.close(), () => client.close());
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.find((c) => c.type === "text")?.text;
    return { isError: res.isError === true, body: text ? JSON.parse(text) : null, raw: res };
  };
  return { dev, client, call };
}

function game(url, name, extra = {}) {
  const g = fakeWsGame(url, {
    title: name,
    handler: (method, params) => {
      if (method === "list_screens") return { screens: [{ name, active: true, failed: false }] };
      return { method, params, from: name };
    },
    ...extra,
  });
  open.push(() => g.close());
  return g;
}

describe("tools", () => {
  it("reports the package version and offers target on every game tool", async () => {
    const { client } = await start();
    assert.equal(client.getServerVersion().version, VERSION);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["connect", "list_instances", "events", "ping", "screenshot", "set_parameter", "send_events"]) {
      assert.ok(names.includes(name), name);
    }
    for (const t of tools) {
      if (["connect", "list_instances", "events"].includes(t.name)) continue;
      assert.ok(t.inputSchema.properties?.target, `${t.name} takes target`);
    }
  });

  it("with nothing connected, says so; a failed connect changes nothing", async () => {
    const { dev, call } = await start();
    const before = await call("ping");
    assert.equal(before.isError, true);
    assert.equal(before.body.code, "not_connected");
    assert.match(before.body.error, /devbridge=ws:\/\/127\.0\.0\.1:/);

    const port = await closedPort();
    const failed = await call("connect", { port, host: "127.0.0.1" });
    assert.equal(failed.isError, true);
    assert.equal(failed.body.code, "connection_failed");
    assert.match(failed.body.error, /Nothing changed/);
    assert.equal(dev.registry.current, null);
    assert.equal(dev.registry.list().length, 0);

    const after = await call("ping");
    assert.equal(after.body.code, "not_connected", "still not connected, not 'game is not running'");
  });

  it("with exactly one browser game, tools work without connect", async () => {
    const { dev, call } = await start();
    await game(dev.relay.url, "solo").ready;
    const res = await call("list_screens");
    assert.equal(res.isError, false);
    assert.equal(res.body.screens[0].name, "solo");
  });

  it("with two games, asks for a target, and routes by it", async () => {
    const { dev, call } = await start();
    await game(dev.relay.url, "left").ready;
    await game(dev.relay.url, "right").ready;

    const ambiguous = await call("list_screens");
    assert.equal(ambiguous.body.code, "ambiguous_target");
    assert.match(ambiguous.body.error, /web-1, web-2/);

    assert.equal((await call("list_screens", { target: "web-2" })).body.screens[0].name, "right");
    assert.equal((await call("list_screens", { target: "web-1" })).body.screens[0].name, "left");
    assert.equal((await call("ping", { target: "web-9" })).body.code, "unknown_target");

    const chosen = await call("connect", { instance: "web-2" });
    assert.equal(chosen.isError, false);
    assert.equal((await call("list_screens")).body.screens[0].name, "right");

    const listing = await call("list_instances", { scan: false });
    assert.equal(listing.body.current, "web-2");
    assert.deepEqual(listing.body.instances.map((i) => [i.id, i.kind, i.title]), [
      ["web-1", "browser", "left"],
      ["web-2", "browser", "right"],
    ]);
  });

  it("reaches a HashLink game by connect, and a second one by target, and reads both games' events", async () => {
    const { dev, call } = await start();
    const hl = await fakeHttpBridge((method) => ({ from: "hashlink", method }));
    open.push(() => hl.close());
    const web = game(dev.relay.url, "web");
    await web.ready;

    const connected = await call("connect", { port: hl.port, host: "127.0.0.1" });
    assert.equal(connected.isError, false);
    assert.equal(connected.body.instance, `http:${hl.port}`);
    assert.equal((await call("ping")).body.from, "hashlink");
    assert.equal((await call("ping", { target: "web-1" })).body.from, "web");

    await waitFor(() => hl.sseCount > 0);
    hl.sseWrite('event: reload\ndata: {"status":"fai');
    await new Promise((r) => setTimeout(r, 30));
    hl.sseWrite('led","file":"ui/menu.manim"}\n\n');
    web.event("trace", { message: "hello from the page" });
    await waitFor(() => dev.events.lastId >= 3);

    const all = await call("events");
    const kinds = all.body.events.map((e) => [e.instance, e.kind]);
    assert.deepEqual(kinds.filter(([, k]) => k !== "instance").sort(), [
      [`http:${hl.port}`, "reload"],
      ["web-1", "trace"],
    ]);
    const reload = all.body.events.find((e) => e.kind === "reload");
    assert.deepEqual(reload.data, { status: "failed", file: "ui/menu.manim" });

    const newer = await call("events", { since_id: all.body.lastId });
    assert.deepEqual(newer.body.events, []);
    const onlyTraces = await call("events", { kinds: ["trace"] });
    assert.deepEqual(onlyTraces.body.events.map((e) => e.data.message), ["hello from the page"]);
  });

  it("reload sends the text of source_path as content", async () => {
    const { dev, call } = await start();
    let received;
    await game(dev.relay.url, "web", {
      handler: (method, params) => {
        received = { method, params };
        return { success: true };
      },
    }).ready;
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "mcp-")), "menu.manim");
    writeFileSync(file, "version: 1.0\n");
    const res = await call("reload", { file: "ui/menu.manim", source_path: file });
    assert.equal(res.isError, false);
    assert.deepEqual(received, { method: "reload", params: { file: "ui/menu.manim", content: "version: 1.0\n" } });
  });

  it("finds a HashLink game on the default port when nothing is connected", async () => {
    const hl = await fakeHttpBridge(() => ({ found: true }));
    open.push(() => hl.close());
    const { dev, call } = await start({ autoDiscover: true, httpHost: "127.0.0.1", httpPort: hl.port, listen: null });
    const res = await call("performance");
    assert.equal(res.body.found, true);
    assert.deepEqual(dev.registry.list().map((i) => i.id), [`http:${hl.port}`]);
  });
});
