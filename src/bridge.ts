/**
 * How a tool call reaches a game's DevBridge. A game on HashLink runs an HTTP server
 * (`HttpTransport`, one POST per call); a game in a browser page dials into this process's
 * WebSocket relay (`WsGameTransport` in relay.ts). Both answer the same methods with the same
 * `{ok, result}` / `{ok: false, error, code}` bodies.
 */

export interface DevBridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/**
 * Error codes:
 * - "not_connected"     — no game to talk to (nothing connected, nothing found)
 * - "ambiguous_target"  — several games are connected and no `target` said which
 * - "unknown_target"    — `target` names no known game
 * - "connection_failed" — the game is not running / cannot be reached / its socket closed
 * - "timeout"           — the game did not answer in time (paused at a breakpoint, a long frame)
 * - "bad_reply"         — the game answered with something that is not a DevBridge reply
 * - "unauthorized"      — the game requires a token (HX_DEV_TOKEN) this server did not send
 * - "not_found"         — screen, element, programmable, or resource not found
 * - "invalid_params"    — missing or invalid parameters
 * - "invalid_state"     — precondition not met (e.g. game not paused)
 * - "not_supported"     — the op does not exist on this target (e.g. `quit` in a browser page)
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

/** A call that gets no answer within this is abandoned (as Screenwright's own client does). */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** One way of sending DevBridge calls to one game. */
export interface BridgeTransport {
  readonly kind: "http" | "ws";
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** Drops keys whose value is undefined, so optional tool params are not sent as nulls. */
export function definedOnly(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** The DevBridge's own HTTP server, on HashLink: one POST per call. */
export class HttpTransport implements BridgeTransport {
  readonly kind = "http" as const;
  readonly host: string;
  readonly port: number;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(host: string, port: number, options: { token?: string; timeoutMs?: number } = {}) {
    this.host = host;
    this.port = port;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs: number = this.timeoutMs): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["X-HX-Dev-Token"] = this.token;

    let response: Response;
    let text: string;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: definedOnly(params) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new DevBridgeError(
          "timeout",
          `DevBridge on ${this.host}:${this.port} did not answer ${method} within ${timeoutMs} ms (stopped at a breakpoint, or stuck in a long frame?)`,
        );
      }
      throw new DevBridgeError(
        "connection_failed",
        `Game is not running (could not connect to DevBridge on ${this.host}:${this.port})`,
      );
    }

    let data: DevBridgeResponse;
    try {
      data = JSON.parse(text) as DevBridgeResponse;
    } catch {
      throw new DevBridgeError(
        "bad_reply",
        `DevBridge on ${this.host}:${this.port} answered ${method} with HTTP ${response.status} and a body that is not JSON: ${text.slice(0, 200)}`,
      );
    }
    if (!response.ok || !data || data.ok !== true) {
      const code = data?.code || (response.status === 401 ? "unauthorized" : "internal");
      throw new DevBridgeError(code, data?.error || `HTTP ${response.status}: ${response.statusText}`);
    }
    return data.result;
  }

  close(): void {}
}
