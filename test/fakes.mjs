// Fake games for the tests: a HashLink DevBridge (HTTP + /sse) and a browser game that dials
// the relay (Node's built-in WebSocket client), each a few lines.

import http from "node:http";

/**
 * An HTTP DevBridge. `handler(method, params)` returns the result, or throws {code, message};
 * returning the symbol HANG leaves the request unanswered.
 */
export const HANG = Symbol("hang");

export async function fakeHttpBridge(handler, { token } = {}) {
  const sseClients = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    if (token && req.headers["x-hx-dev-token"] !== token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized", code: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      sseClients.push(res);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { method, params } = JSON.parse(body);
      requests.push({ method, params, headers: req.headers });
      try {
        const result = await handler(method, params);
        if (result === HANG) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        res.writeHead(e.status ?? 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message, code: e.code ?? "internal" }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    requests,
    get sseCount() {
      return sseClients.length;
    },
    /** Writes raw text to every /sse client (lets a test split an event anywhere). */
    sseWrite(text) {
      for (const c of sseClients) c.write(text);
    },
    sse(event, data) {
      this.sseWrite(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    async close() {
      for (const c of sseClients) c.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * A browser game dialling the relay: sends hello, answers calls with `handler(method, params)`
 * (return the result, throw {code, message}, or return HANG to never answer).
 */
export function fakeWsGame(url, { session = "s" + Math.random().toString(36).slice(2), token, handler, title = "Fake game" } = {}) {
  const ws = new WebSocket(url);
  let seq = 0;
  const game = {
    ws,
    session,
    welcome: null,
    closed: new Promise((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }))),
    ready: null,
    event(name, data, skip = 0) {
      seq += 1 + skip;
      ws.send(JSON.stringify({ kind: "event", seq, event: name, data }));
    },
    close() {
      ws.close();
      return game.closed;
    },
  };
  game.ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      const hello = { kind: "hello", protocol: 1, app: "FakeApp", title, url: "http://fake/", session };
      if (token !== undefined) hello.token = token;
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener("error", (e) => reject(new Error("ws error " + e.message)));
    ws.addEventListener("close", (e) => resolve({ closed: true, code: e.code }));
    ws.addEventListener("message", async (msg) => {
      const frame = JSON.parse(String(msg.data));
      if (frame.kind === "welcome") {
        game.welcome = frame;
        resolve(frame);
        return;
      }
      if (frame.kind !== "call") return;
      try {
        const result = await handler(frame.method, frame.params);
        if (result === HANG) return;
        ws.send(JSON.stringify({ kind: "result", id: frame.id, ok: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({ kind: "result", id: frame.id, ok: false, error: e.message, code: e.code ?? "internal" }));
      }
    });
  });
  return game;
}

export function bridgeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export async function waitFor(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A port nothing listens on. */
export async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
