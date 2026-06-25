import { ScannerError } from "./errors.js";
import { request, type HttpLike, type RequestOptions } from "./http.js";
import type { JobStatus, OutputFormat, ScanJobEvent } from "./types.js";

export interface WebSocketLike {
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: unknown) => void): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

type DoneListener = (blob: Blob, meta: { format: OutputFormat }) => void;
type ErrorListener = (err: Error) => void;
type EventListener = (ev: ScanJobEvent) => void;
type WarningListener = (msg: string) => void;

interface JobEventMap {
  progress: EventListener;
  awaiting_page: EventListener;
  done: DoneListener;
  error: ErrorListener;
  /** Non-fatal hiccups: reconnect attempts, dropped malformed frames. */
  warning: WarningListener;
}

export interface ScanJobResilienceOptions {
  /** Max WebSocket reconnect attempts before giving up. */
  maxReconnects: number;
  /** Base reconnect backoff (doubles per attempt, capped 5s). */
  reconnectDelayMs: number;
  /**
   * If no WS frame arrives for this long (and not awaiting a page), assume a
   * half-open/dead socket and force a reconnect. 0 disables. Paused during
   * `awaiting_page` since that legitimately waits on the user.
   */
  stallTimeoutMs: number;
}

export interface ScanJobInit {
  id: string;
  baseUrl: string;
  outputFormat: OutputFormat;
  fetchImpl: HttpLike;
  WebSocketImpl: WebSocketCtor;
  httpOptions: RequestOptions;
  resilience: ScanJobResilienceOptions;
}

/**
 * Live handle over one scan job. Wraps the progress WebSocket with
 * auto-reconnect + stall detection, exposes the multi-page flatbed
 * continue/finish handshake, and auto-fetches the binary result on completion.
 * Reconnect is safe: the agent re-sends current job status on every WS
 * connect, so a dropped socket resumes (including a job that finished while
 * disconnected).
 */
export class ScanJob {
  readonly id: string;
  status: JobStatus = "pending";
  pageCount = 0;
  maxPages = 1;

  private readonly baseUrl: string;
  private readonly outputFormat: OutputFormat;
  private readonly fetchImpl: HttpLike;
  private readonly WebSocketImpl: WebSocketCtor;
  private readonly httpOptions: RequestOptions;
  private readonly resilience: ScanJobResilienceOptions;

  private ws: WebSocketLike | null = null;
  private settled = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = {
    progress: new Set<EventListener>(),
    awaiting_page: new Set<EventListener>(),
    done: new Set<DoneListener>(),
    error: new Set<ErrorListener>(),
    warning: new Set<WarningListener>(),
  };

  private completion: Promise<Blob>;
  private resolveCompletion!: (blob: Blob) => void;
  private rejectCompletion!: (err: Error) => void;

  constructor(init: ScanJobInit) {
    this.id = init.id;
    this.baseUrl = init.baseUrl;
    this.outputFormat = init.outputFormat;
    this.fetchImpl = init.fetchImpl;
    this.WebSocketImpl = init.WebSocketImpl;
    this.httpOptions = init.httpOptions;
    this.resilience = init.resilience;

    this.completion = new Promise<Blob>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.completion.catch(() => {}); // no unhandled rejection if completed() unused

    this.openSocket();
  }

  on<K extends keyof JobEventMap>(event: K, cb: JobEventMap[K]): () => void {
    (this.listeners[event] as Set<JobEventMap[K]>).add(cb);
    return () => {
      (this.listeners[event] as Set<JobEventMap[K]>).delete(cb);
    };
  }

  /** POST /scan/{id}/continue. Not retried (not idempotent - a retry could
   * scan an extra page). */
  async continue(): Promise<void> {
    await this.post(`/scan/${this.id}/continue`);
  }

  /** POST /scan/{id}/finish. Not retried (state-changing). */
  async finish(): Promise<void> {
    await this.post(`/scan/${this.id}/finish`);
  }

  /** Resolves with the result Blob on `done`, rejects on `error`. */
  completed(): Promise<Blob> {
    return this.completion;
  }

  resultUrl(): string {
    return `${this.baseUrl}/scan/${this.id}/result`;
  }

  /** Tear down the WebSocket and all timers. Safe to call repeatedly. */
  close(): void {
    this.settled = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private openSocket(): void {
    if (this.settled) return;
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws/jobs/${this.id}`;
    let ws: WebSocketLike;
    try {
      ws = new this.WebSocketImpl(wsUrl);
    } catch (err) {
      this.onDisconnect(err instanceof Error ? err.message : "WebSocket construction failed");
      return;
    }
    this.ws = ws;

    ws.addEventListener("message", (ev) => this.handleFrame(ev.data));
    ws.addEventListener("error", () => this.onDisconnect("WebSocket error"));
    ws.addEventListener("close", () => this.onDisconnect("WebSocket closed"));

    this.armStallTimer();
  }

  private onDisconnect(reason: string): void {
    if (this.settled) return;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.clearStallTimer();

    if (this.reconnectAttempts >= this.resilience.maxReconnects) {
      this.fail(
        new Error(
          `${reason}; gave up after ${this.resilience.maxReconnects} reconnect attempt(s)`,
        ),
      );
      return;
    }

    const attempt = this.reconnectAttempts++;
    const wait = Math.min(this.resilience.reconnectDelayMs * 2 ** attempt, 5000);
    this.emitWarning(`${reason}; reconnecting (attempt ${attempt + 1}) in ${wait}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, wait);
  }

  private handleFrame(data: unknown): void {
    if (this.settled) return;

    let parsed: {
      status: JobStatus;
      page_count: number;
      max_pages: number;
      error: string | null;
    };
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : (data as never);
      if (!parsed || typeof parsed.status !== "string") throw new Error("bad shape");
    } catch {
      this.emitWarning("Dropped malformed WebSocket frame");
      return;
    }

    // A valid frame means the connection is healthy again.
    this.reconnectAttempts = 0;
    this.armStallTimer();

    this.status = parsed.status;
    this.pageCount = parsed.page_count;
    this.maxPages = parsed.max_pages;

    const event: ScanJobEvent = {
      status: parsed.status,
      pageCount: parsed.page_count,
      maxPages: parsed.max_pages,
      error: parsed.error ?? null,
    };

    this.emit("progress", event);

    if (parsed.status === "awaiting_page") {
      this.clearStallTimer(); // user-paced; don't treat the wait as a stall
      this.emit("awaiting_page", event);
    } else if (parsed.status === "done") {
      void this.fetchResult();
    } else if (parsed.status === "error") {
      this.fail(new Error(parsed.error || "Scan failed"));
    }
  }

  private async fetchResult(): Promise<void> {
    if (this.settled) return;
    try {
      const res = await request(this.fetchImpl, this.resultUrl(), {}, this.httpOptions);
      if (!res.ok) {
        throw new ScannerError(res.status, await safeJson(res), "Failed to fetch result");
      }
      const blob = await res.blob();
      if (this.settled) return;
      this.settled = true;
      this.clearTimers();
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      for (const cb of this.listeners.done) safeInvoke(cb, blob, { format: this.outputFormat });
      this.resolveCompletion(blob);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async post(path: string): Promise<void> {
    // retries:0 - these mutate job state and aren't safe to replay.
    const res = await request(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      { method: "POST" },
      { ...this.httpOptions, retries: 0 },
    );
    if (!res.ok) {
      throw new ScannerError(res.status, await safeJson(res));
    }
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    if (this.settled || this.resilience.stallTimeoutMs <= 0) return;
    if (this.status === "awaiting_page") return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.onDisconnect("No progress within stall timeout");
    }, this.resilience.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearStallTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(event: "progress" | "awaiting_page", payload: ScanJobEvent): void {
    for (const cb of this.listeners[event]) safeInvoke(cb, payload);
  }

  private emitWarning(msg: string): void {
    for (const cb of this.listeners.warning) safeInvoke(cb, msg);
  }

  private fail(err: Error): void {
    if (this.settled) return; // terminal happens exactly once
    this.settled = true;
    this.status = "error";
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const cb of this.listeners.error) safeInvoke(cb, err);
    this.rejectCompletion(err);
  }
}

// A throwing user callback must not break WS dispatch or skip other listeners.
function safeInvoke<A extends unknown[]>(cb: (...args: A) => void, ...args: A): void {
  try {
    cb(...args);
  } catch {
    /* swallow listener errors - they're the consumer's problem, not ours */
  }
}

async function safeJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return body?.detail ?? body;
  } catch {
    return null;
  }
}
