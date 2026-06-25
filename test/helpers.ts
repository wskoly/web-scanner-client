import type { HttpLike, WebSocketCtor, WebSocketLike } from "../src/index.js";

/** A scripted fake WebSocket the test drives by calling push()/emitClose(). */
export class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | null = null;
  url: string;
  private messageCbs: ((ev: { data: unknown }) => void)[] = [];
  private errorCbs: ((ev: unknown) => void)[] = [];
  private closeCbs: ((ev: unknown) => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
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

  /** Push a JSON progress frame as the server would. */
  push(frame: {
    status: string;
    page_count: number;
    max_pages: number;
    error?: string | null;
  }): void {
    const data = JSON.stringify({ error: null, ...frame });
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
}

/**
 * Mock fetch routing by "METHOD path". Records calls for assertions.
 */
export function makeFetch(routes: Record<string, RouteResponse>): HttpLike & {
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];

  const impl = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ detail: "not mocked" }),
        blob: async () => new Blob(),
        text: async () => "not mocked",
      };
    }
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.json ?? {},
      blob: async () => route.blob ?? new Blob(),
      text: async () => JSON.stringify(route.json ?? {}),
    };
  }) as HttpLike & { calls: { url: string; method: string }[] };

  impl.calls = calls;
  return impl;
}
