import type { FetchInit, HttpLike, WebSocketCtor, WebSocketLike } from "../src/index.js";

/** A scripted fake WebSocket the test drives by calling push()/emitClose(). */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket | null {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] ?? null;
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  url: string;
  closed = false;
  private messageCbs: ((ev: { data: unknown }) => void)[] = [];
  private errorCbs: ((ev: unknown) => void)[] = [];
  private closeCbs: ((ev: unknown) => void)[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: unknown) => void): void;
  addEventListener(type: string, cb: (ev: never) => void): void {
    if (type === "message") this.messageCbs.push(cb as never);
    else if (type === "error") this.errorCbs.push(cb as never);
    else if (type === "close") this.closeCbs.push(cb as never);
  }

  close(): void {
    this.closed = true;
  }

  push(frame: {
    status: string;
    page_count: number;
    max_pages: number;
    error?: string | null;
  }): void {
    const data = JSON.stringify({ error: null, ...frame });
    for (const cb of this.messageCbs) cb({ data });
  }

  /** Push raw (possibly malformed) frame data. */
  pushRaw(data: unknown): void {
    for (const cb of this.messageCbs) cb({ data });
  }

  emitError(): void {
    for (const cb of this.errorCbs) cb({});
  }

  emitClose(): void {
    for (const cb of this.closeCbs) cb({});
  }
}

export const FakeWebSocketCtor = FakeWebSocket as unknown as WebSocketCtor;

interface RouteResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
  blob?: Blob;
  /** Reject the fetch (simulate network error / timeout). */
  throw?: Error;
}

/** A route value: one response, or a sequence consumed in order (last repeats). */
type Route = RouteResponse | RouteResponse[];

function toResponse(route: RouteResponse) {
  if (route.throw) return Promise.reject(route.throw);
  return Promise.resolve({
    ok: route.ok ?? true,
    status: route.status ?? 200,
    json: async () => route.json ?? {},
    blob: async () => route.blob ?? new Blob(),
    text: async () => JSON.stringify(route.json ?? {}),
  });
}

/**
 * Mock fetch routing by "METHOD path". Records calls. A route may be an array
 * of responses consumed in sequence (for retry tests).
 */
export function makeFetch(routes: Record<string, Route>): HttpLike & {
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const cursors: Record<string, number> = {};

  const impl = (async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = routes[`${method} ${path}`] ? `${method} ${path}` : path;
    const route = routes[key];
    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ detail: "not mocked" }),
        blob: async () => new Blob(),
        text: async () => "not mocked",
      };
    }
    if (Array.isArray(route)) {
      const i = Math.min(cursors[key] ?? 0, route.length - 1);
      cursors[key] = (cursors[key] ?? 0) + 1;
      return toResponse(route[i]);
    }
    return toResponse(route);
  }) as HttpLike & { calls: { url: string; method: string }[] };

  impl.calls = calls;
  return impl;
}
