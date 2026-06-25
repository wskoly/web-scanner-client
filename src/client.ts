import { ScannerError } from "./errors.js";
import { request, type HttpLike, type RequestOptions } from "./http.js";
import {
  ScanJob,
  type ScanJobResilienceOptions,
  type WebSocketCtor,
} from "./job.js";
import type { Device, FilterDef, Preset, ScanRequest } from "./types.js";

export interface ScannerClientOptions {
  /** Agent base URL. Defaults to the agent's loopback bind. */
  baseUrl?: string;
  /** Override fetch (defaults to global fetch). Useful in Node/tests. */
  fetch?: HttpLike;
  /** Override WebSocket ctor (defaults to global WebSocket). */
  WebSocket?: WebSocketCtor;
  /** Per-request timeout in ms (0 disables). Default 30000. */
  timeoutMs?: number;
  /** Transient-failure retries for idempotent calls (GET, scan result, scan
   * start). Default 2. continue()/finish() are never retried. */
  retries?: number;
  /** Base retry backoff in ms (doubles per attempt, capped 5s). Default 500. */
  retryDelayMs?: number;
  /** Max WebSocket reconnect attempts. Default 5. */
  maxReconnects?: number;
  /** Base reconnect backoff in ms. Default 500. */
  reconnectDelayMs?: number;
  /** Stall watchdog in ms; forces reconnect if no frame arrives (paused
   * during awaiting_page). 0 disables. Default 300000 (5 min). */
  stallTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:51823";

/**
 * Client for the web-scanner-sdk local agent. Framework-agnostic: the React
 * and Vue adapters are thin wrappers over this. All network calls share a
 * timeout + transient-retry layer; scan jobs add WS auto-reconnect.
 */
export class ScannerClient {
  readonly baseUrl: string;
  private readonly fetchImpl: HttpLike;
  private readonly WebSocketImpl: WebSocketCtor;
  private readonly httpOptions: RequestOptions;
  private readonly resilience: ScanJobResilienceOptions;

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

    this.httpOptions = {
      timeoutMs: options.timeoutMs ?? 30000,
      retries: options.retries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 500,
    };
    this.resilience = {
      maxReconnects: options.maxReconnects ?? 5,
      reconnectDelayMs: options.reconnectDelayMs ?? 500,
      stallTimeoutMs: options.stallTimeoutMs ?? 300000,
    };
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
   * subscribe to (progress/awaiting_page/done/error/warning) or await via
   * completed().
   */
  async scan(request_: ScanRequest): Promise<ScanJob> {
    const res = await request(
      this.fetchImpl,
      `${this.baseUrl}/scan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request_),
      },
      // retries:0 - POST /scan is NOT idempotent. A retry after the device
      // already accepted the job (e.g. response lost to a timeout) would start
      // a second physical scan. Keep the timeout; drop the retry.
      { ...this.httpOptions, retries: 0 },
    );
    if (!res.ok) {
      throw new ScannerError(res.status, await safeDetail(res));
    }
    const { job_id } = (await res.json()) as { job_id: string };

    return new ScanJob({
      id: job_id,
      baseUrl: this.baseUrl,
      outputFormat: request_.output_format ?? "pdf",
      fetchImpl: this.fetchImpl,
      WebSocketImpl: this.WebSocketImpl,
      httpOptions: this.httpOptions,
      resilience: this.resilience,
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await request(this.fetchImpl, `${this.baseUrl}${path}`, {}, this.httpOptions);
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
