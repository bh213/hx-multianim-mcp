/**
 * SSE client for receiving push events from DevBridge.
 * Connects to the /sse endpoint and emits parsed events.
 * Auto-reconnects on disconnect with a 3-second backoff.
 */

import { EventEmitter } from "node:events";
import http from "node:http";

export interface SseEvent {
  event: string;
  data: string;
}

export class SseClient extends EventEmitter {
  private host: string;
  private port: number;
  private request: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private static RECONNECT_MS = 3000;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
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

    this.request = http.get(
      { hostname: this.host, port: this.port, path: "/sse" },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain
          this.scheduleReconnect();
          return;
        }

        let eventType = "";
        let dataBuffer = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          // SSE is line-based; buffer may contain partial lines across chunks
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataBuffer = line.slice(6);
            } else if (line === "") {
              // Blank line = dispatch event
              if (eventType && dataBuffer) {
                this.emit("event", { event: eventType, data: dataBuffer } satisfies SseEvent);
              }
              eventType = "";
              dataBuffer = "";
            }
          }
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
