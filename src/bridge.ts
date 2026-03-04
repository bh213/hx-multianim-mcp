/**
 * HTTP client for communicating with the Haxe DevBridge running inside the game.
 * Each tool call becomes a single HTTP POST to the DevBridge.
 */

export interface DevBridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class DevBridge {
  private baseUrl: string;

  constructor(host: string = "localhost", port: number = 9001) {
    this.baseUrl = `http://${host}:${port}`;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as DevBridgeResponse;
    if (!data.ok) {
      throw new Error(data.error || "Unknown error from DevBridge");
    }
    return data.result;
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.call("performance");
      return true;
    } catch {
      return false;
    }
  }
}
