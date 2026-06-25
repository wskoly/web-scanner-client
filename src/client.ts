import { ScannerError } from "./errors.js";
import { ScanJob, type HttpLike, type WebSocketCtor } from "./job.js";
import type { Device, FilterDef, Preset, ScanRequest } from "./types.js";

export interface ScannerClientOptions {
  /** Agent base URL. Defaults to the agent's loopback bind. */
  baseUrl?: string;
  /** Override fetch (defaults to global fetch). Useful in Node/tests. */
  fetch?: HttpLike;
  /** Override WebSocket ctor (defaults to global WebSocket). */
  WebSocket?: WebSocketCtor;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:51823";

/**
 * Client for the web-scanner-sdk local agent. Framework-agnostic: the React
 * and Vue adapters are thin wrappers over this.
 */
export class ScannerClient {
  readonly baseUrl: string;
  private readonly fetchImpl: HttpLike;
  private readonly WebSocketImpl: WebSocketCtor;

  constructor(options: ScannerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    const fetchImpl = options.fetch ?? (globalThis.fetch as HttpLike | undefined);
    if (!fetchImpl) {
      throw new Error("No fetch implementation available; pass options.fetch");
    }
    this.fetchImpl = fetchImpl;

    const WebSocketImpl =
      options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (!WebSocketImpl) {
      throw new Error("No WebSocket implementation available; pass options.WebSocket");
    }
    this.WebSocketImpl = WebSocketImpl;
  }

  /** GET /devices - enumerate scanners across all backends. */
  listDevices(): Promise<Device[]> {
    return this.getJson<Device[]>("/devices");
  }

  /** GET /filters - raw filter registry + param schema for building UI. */
  listFilters(): Promise<FilterDef[]> {
    return this.getJson<FilterDef[]>("/filters");
  }

  /** GET /presets - named filter chains keyed by preset name. */
  listPresets(): Promise<Record<string, Preset>> {
    return this.getJson<Record<string, Preset>>("/presets");
  }

  /**
   * POST /scan, then open the progress WebSocket. Returns a live ScanJob you
   * subscribe to (progress/awaiting_page/done/error) or await via completed().
   */
  async scan(request: ScanRequest): Promise<ScanJob> {
    const res = await this.fetchImpl(`${this.baseUrl}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    } as never);
    if (!res.ok) {
      throw new ScannerError(res.status, await safeDetail(res));
    }
    const { job_id } = (await res.json()) as { job_id: string };

    return new ScanJob({
      id: job_id,
      baseUrl: this.baseUrl,
      outputFormat: request.output_format ?? "pdf",
      fetchImpl: this.fetchImpl,
      WebSocketImpl: this.WebSocketImpl,
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new ScannerError(res.status, await safeDetail(res));
    }
    return (await res.json()) as T;
  }
}

async function safeDetail(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return body?.detail ?? body;
  } catch {
    return null;
  }
}
