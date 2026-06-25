import { ScannerError } from "./errors.js";
import type { JobStatus, OutputFormat, ScanJobEvent } from "./types.js";

/** Minimal injectable surface of fetch/WebSocket we depend on. */
export interface HttpLike {
  (input: string, init?: { method?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    blob(): Promise<Blob>;
    text(): Promise<string>;
  }>;
}

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

interface JobEventMap {
  progress: EventListener;
  awaiting_page: EventListener;
  done: DoneListener;
  error: ErrorListener;
}

export interface ScanJobInit {
  id: string;
  baseUrl: string;
  outputFormat: OutputFormat;
  fetchImpl: HttpLike;
  WebSocketImpl: WebSocketCtor;
}

/**
 * Live handle over one scan job. Wraps the progress WebSocket, exposes the
 * multi-page flatbed continue/finish handshake, and auto-fetches the binary
 * result into a Blob on completion.
 */
export class ScanJob {
  readonly id: string;
  status: JobStatus = "pending";
  pageCount = 0;
  maxPages = 1;

  private readonly baseUrl: string;
  private readonly outputFormat: OutputFormat;
  private readonly fetchImpl: HttpLike;
  private ws: WebSocketLike | null = null;
  private closed = false;

  private readonly listeners: {
    progress: Set<EventListener>;
    awaiting_page: Set<EventListener>;
    done: Set<DoneListener>;
    error: Set<ErrorListener>;
  } = {
    progress: new Set(),
    awaiting_page: new Set(),
    done: new Set(),
    error: new Set(),
  };

  private completion: Promise<Blob>;
  private resolveCompletion!: (blob: Blob) => void;
  private rejectCompletion!: (err: Error) => void;

  constructor(init: ScanJobInit) {
    this.id = init.id;
    this.baseUrl = init.baseUrl;
    this.outputFormat = init.outputFormat;
    this.fetchImpl = init.fetchImpl;

    this.completion = new Promise<Blob>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // Don't leave the promise unhandled if no one awaits completed().
    this.completion.catch(() => {});

    this.openSocket(init.WebSocketImpl);
  }

  on<K extends keyof JobEventMap>(event: K, cb: JobEventMap[K]): () => void {
    (this.listeners[event] as Set<JobEventMap[K]>).add(cb);
    return () => {
      (this.listeners[event] as Set<JobEventMap[K]>).delete(cb);
    };
  }

  /** POST /scan/{id}/continue - capture the next flatbed page. */
  async continue(): Promise<void> {
    await this.post(`/scan/${this.id}/continue`);
  }

  /** POST /scan/{id}/finish - stop early, assemble pages captured so far. */
  async finish(): Promise<void> {
    await this.post(`/scan/${this.id}/finish`);
  }

  /** Resolves with the result Blob on `done`, rejects on `error`. */
  completed(): Promise<Blob> {
    return this.completion;
  }

  /** URL for GET result - handy for <a download> or <img src>. */
  resultUrl(): string {
    return `${this.baseUrl}/scan/${this.id}/result`;
  }

  /** Tear down the WebSocket. Safe to call multiple times. */
  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private openSocket(WebSocketImpl: WebSocketCtor): void {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws/jobs/${this.id}`;
    const ws = new WebSocketImpl(wsUrl);
    this.ws = ws;

    ws.addEventListener("message", (ev) => this.handleFrame(ev.data));
    ws.addEventListener("error", () => {
      if (!this.closed && this.status !== "done" && this.status !== "error") {
        this.fail(new Error("WebSocket connection error"));
      }
    });
    ws.addEventListener("close", () => {
      // A close before a terminal status means we lost progress mid-scan.
      if (!this.closed && this.status !== "done" && this.status !== "error") {
        this.fail(new Error("WebSocket closed before job finished"));
      }
    });
  }

  private handleFrame(data: unknown): void {
    let parsed: {
      status: JobStatus;
      page_count: number;
      max_pages: number;
      error: string | null;
    };
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : (data as never);
    } catch {
      return;
    }

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
      this.emit("awaiting_page", event);
    } else if (parsed.status === "done") {
      void this.fetchResult();
    } else if (parsed.status === "error") {
      this.fail(new Error(parsed.error || "Scan failed"));
    }
  }

  private async fetchResult(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.resultUrl());
      if (!res.ok) {
        throw new ScannerError(res.status, await safeJson(res), "Failed to fetch result");
      }
      const blob = await res.blob();
      this.close();
      for (const cb of this.listeners.done) cb(blob, { format: this.outputFormat });
      this.resolveCompletion(blob);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async post(path: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST" });
    if (!res.ok) {
      throw new ScannerError(res.status, await safeJson(res));
    }
  }

  private emit(event: "progress" | "awaiting_page", payload: ScanJobEvent): void {
    for (const cb of this.listeners[event]) cb(payload);
  }

  private fail(err: Error): void {
    if (this.status !== "error") this.status = "error";
    this.close();
    for (const cb of this.listeners.error) cb(err);
    this.rejectCompletion(err);
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
