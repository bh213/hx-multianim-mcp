/**
 * SSE client for the pushed events of a HashLink game's DevBridge (`GET /sse`).
 * Auto-reconnects on disconnect with a 3-second backoff.
 */

import { EventEmitter } from "node:events";
import http from "node:http";

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental `text/event-stream` parser. Keeps the unfinished line between chunks (the network
 * may split an event anywhere), joins repeated `data:` lines with newlines, accepts LF and CRLF,
 * and skips comments. An event is dispatched at the blank line that ends it.
 */
export class SseParser {
  private remainder = "";
  private eventType = "";
  private dataLines: string[] = [];

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    const text = this.remainder + chunk;
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      let line = text.slice(start, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = nl + 1;
      this.line(line, out);
    }
    this.remainder = text.slice(start);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        out.push({ event: this.eventType || "message", data: this.dataLines.join("\n") });
      }
      this.eventType = "";
      this.dataLines = [];
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventType = value;
    else if (field === "data") this.dataLines.push(value);
  }
}

export class SseClient extends EventEmitter {
  private host: string;
  private port: number;
  private token: string | undefined;
  private request: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private static RECONNECT_MS = 3000;

  constructor(host: string, port: number, token?: string) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
  }

  /** Reconnect to a new host/port. Stops current connection and restarts. */
  reconnect(host: string, port: number): void {
    this.stop();
    this.host = host;
    this.port = port;
    this.start();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const headers: Record<string, string> = {};
    if (this.token) headers["X-HX-Dev-Token"] = this.token;
    this.request = http.get(
      { hostname: this.host, port: this.port, path: "/sse", headers },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain
          this.scheduleReconnect();
          return;
        }

        const parser = new SseParser();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          for (const evt of parser.push(chunk)) this.emit("event", evt);
        });

        res.on("end", () => this.scheduleReconnect());
        res.on("error", () => this.scheduleReconnect());
      },
    );

    this.request.on("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.request = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, SseClient.RECONNECT_MS);
  }
}
