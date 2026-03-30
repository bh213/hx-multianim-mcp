/**
 * HTTP client for communicating with the Haxe DevBridge running inside the game.
 * Each tool call becomes a single HTTP POST to the DevBridge.
 */

export interface DevBridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/**
 * Error codes returned by DevBridge:
 * - "connection_failed" — game is not running / cannot connect
 * - "not_found"         — screen, element, programmable, or resource not found
 * - "invalid_params"    — missing or invalid parameters
 * - "invalid_state"     — precondition not met (e.g. game not paused)
 * - "unknown_method"    — unknown DevBridge method
 * - "internal"          — unexpected server error
 */
export class DevBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DevBridgeError";
    this.code = code;
  }
}

export class DevBridge {
  private baseUrl: string;
  private port: number;
  private host: string;
  private _connected: boolean = false;

  constructor(host: string = "localhost", port: number = 9001) {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
  }

  get connected(): boolean { return this._connected; }

  /** Update the connection target. Returns the new base URL. */
  reconnect(host: string, port: number): string {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
    this._connected = true;
    return this.baseUrl;
  }

  getHost(): string { return this.host; }
  getPort(): number { return this.port; }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
    } catch {
      throw new DevBridgeError(
        "connection_failed",
        `Game is not running (could not connect to DevBridge on port ${this.port})`,
      );
    }

    const data = (await response.json()) as DevBridgeResponse;
    if (!response.ok || !data.ok) {
      throw new DevBridgeError(
        data.code || "internal",
        data.error || `HTTP ${response.status}: ${response.statusText}`,
      );
    }
    return data.result;
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.call("ping");
      return true;
    } catch {
      return false;
    }
  }
}
