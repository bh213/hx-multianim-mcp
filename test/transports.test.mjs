// The two ways a call reaches a game, and the SSE reader.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DevBridgeError, HttpTransport } from "../dist/bridge.js";
import { EventBuffer } from "../dist/events.js";
import { CLOSE_UNAUTHORIZED, WsRelay } from "../dist/relay.js";
import { SseParser } from "../dist/sse.js";
import { bridgeError, closedPort, fakeHttpBridge, fakeWsGame, HANG, waitFor } from "./fakes.mjs";

describe("SseParser", () => {
  it("keeps an event whose line the network split in two", () => {
    const parser = new SseParser();
    const data = JSON.stringify({ message: "x".repeat(5000) });
    const wire = `event: trace\ndata: ${data}\n\n`;
    assert.deepEqual(parser.push(wire.slice(0, 2000)), []);
    const events = parser.push(wire.slice(2000));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "trace");
    assert.equal(JSON.parse(events[0].data).message.length, 5000);
  });

  it("splits between CR and LF, joins repeated data lines, skips comments", () => {
    const parser = new SseParser();
    const out = [
      ...parser.push(": keepalive\r\nevent: debugger\r"),
      ...parser.push("\ndata: {\"a\":\r\ndata: 1}\r\n"),
      ...parser.push("\r\n"),
    ];
    assert.deepEqual(out, [{ event: "debugger", data: '{"a":\n1}' }]);
    assert.deepEqual(JSON.parse(out[0].data), { a: 1 });
  });

  it("reads one byte at a time", () => {
    const parser = new SseParser();
    const wire = 'event: reload\ndata: {"status":"failed"}\n\nevent: trace\ndata: {"message":"é"}\n\n';
    const out = [];
    for (const ch of wire) out.push(...parser.push(ch));
    assert.deepEqual(out.map((e) => e.event), ["reload", "trace"]);
    assert.equal(JSON.parse(out[1].data).message, "é");
  });
});

describe("HttpTransport", () => {
  const cleanup = [];
  after(async () => {
    for (const c of cleanup) await c();
  });

  it("makes a call and returns the result, sending the token", async () => {
    const game = await fakeHttpBridge((method, params) => ({ method, params }), { token: "t0k" });
    cleanup.push(() => game.close());
    const t = new HttpTransport("127.0.0.1", game.port, { token: "t0k" });
    assert.deepEqual(await t.call("list_screens", { depth: 2, skip: undefined }), { method: "list_screens", params: { depth: 2 } });
    assert.equal(game.requests[0].headers["x-hx-dev-token"], "t0k");
  });

  it("turns an error reply into its code, and a missing token into unauthorized", async () => {
    const game = await fakeHttpBridge(() => {
      throw bridgeError("not_found", "Screen not found: play");
    }, { token: "t0k" });
    cleanup.push(() => game.close());
    await assert.rejects(new HttpTransport("127.0.0.1", game.port, { token: "t0k" }).call("inspect_element"), {
      code: "not_found",
      message: "Screen not found: play",
    });
    await assert.rejects(new HttpTransport("127.0.0.1", game.port).call("ping"), { code: "unauthorized" });
  });

  it("gives up after its timeout instead of hanging", async () => {
    const game = await fakeHttpBridge(() => HANG);
    cleanup.push(() => game.close());
    const started = Date.now();
    await assert.rejects(new HttpTransport("127.0.0.1", game.port, { timeoutMs: 300 }).call("step"), (e) => {
      assert.ok(e instanceof DevBridgeError);
      assert.equal(e.code, "timeout");
      assert.match(e.message, /did not answer step within 300 ms/);
      return true;
    });
    assert.ok(Date.now() - started < 2000);
  });

  it("says connection_failed when nothing listens", async () => {
    const port = await closedPort();
    await assert.rejects(new HttpTransport("127.0.0.1", port).call("ping"), { code: "connection_failed" });
  });
});

describe("WsRelay", () => {
  const relays = [];
  async function startRelay(options = {}) {
    const relay = new WsRelay({ port: 0, host: "127.0.0.1", timeoutMs: 2000, ...options });
    await relay.start();
    relays.push(relay);
    return relay;
  }
  after(async () => {
    for (const r of relays) await r.close();
  });

  it("makes an instance from a hello and calls it", async () => {
    const relay = await startRelay();
    const game = fakeWsGame(relay.url, { handler: (method, params) => ({ echoed: method, params }) });
    const welcome = await game.ready;
    assert.equal(welcome.instance, "web-1");
    const [instance] = relay.list();
    assert.equal(instance.hello.title, "Fake game");
    assert.equal(instance.hello.token, undefined);
    assert.deepEqual(await instance.transport.call("scene_graph", { depth: 1 }), { echoed: "scene_graph", params: { depth: 1 } });
    await game.close();
    await waitFor(() => relay.list().length === 0);
  });

  it("maps error results, and times out an unanswered call", async () => {
    const relay = await startRelay({ timeoutMs: 250 });
    const game = fakeWsGame(relay.url, {
      handler: (method) => {
        if (method === "quit") throw bridgeError("not_supported", "quit is not supported in a browser page");
        return HANG;
      },
    });
    await game.ready;
    const t = relay.list()[0].transport;
    await assert.rejects(t.call("quit"), { code: "not_supported" });
    await assert.rejects(t.call("ping"), { code: "timeout" });
    await game.close();
  });

  it("refuses a hello without the token, and accepts one with it", async () => {
    const relay = await startRelay({ token: "s3cret" });
    const refused = fakeWsGame(relay.url, { token: "wrong", handler: () => ({}) });
    const closed = await refused.closed;
    assert.equal(closed.code, CLOSE_UNAUTHORIZED);
    assert.equal(relay.list().length, 0);
    const accepted = fakeWsGame(relay.url, { token: "s3cret", handler: () => "pong" });
    await accepted.ready;
    assert.equal(await relay.list()[0].transport.call("ping"), "pong");
    await accepted.close();
  });

  it("keeps the id when the same page comes back, and fails calls pending on the old socket", async () => {
    const relay = await startRelay();
    const first = fakeWsGame(relay.url, { session: "same-page", handler: () => HANG });
    await first.ready;
    const pending = relay.list()[0].transport.call("ping").then(() => null, (e) => e);
    const second = fakeWsGame(relay.url, { session: "same-page", handler: () => "again" });
    const welcome = await second.ready;
    assert.equal(welcome.instance, "web-1");
    assert.equal((await pending)?.code, "connection_failed");
    assert.equal(relay.list().length, 1);
    assert.equal(await relay.get("web-1").transport.call("ping"), "again");
    await second.close();
  });

  it("passes events on, and says how many a gap in seq lost", async () => {
    const relay = await startRelay();
    const events = new EventBuffer();
    relay.on("event", (id, kind, data) => events.push(id, kind, data));
    const game = fakeWsGame(relay.url, { handler: () => ({}) });
    await game.ready;
    game.event("trace", { message: "one" });
    game.event("game_event", { name: "scored" }, 2);
    await waitFor(() => events.lastId >= 3);
    assert.deepEqual(
      events.query().events.map((e) => [e.kind, e.data]),
      [
        ["trace", { message: "one" }],
        ["dropped", { missed: 2 }],
        ["game_event", { name: "scored" }],
      ],
    );
    await game.close();
  });

  it("takes the next port when its port is busy", async () => {
    const first = await startRelay();
    const second = await startRelay({ port: first.port });
    assert.equal(second.port, first.port + 1);
  });
});
