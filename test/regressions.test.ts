import { beforeEach, describe, expect, it } from "vitest";
import { effectScope } from "vue";
import { ScannerClient, type HttpLike } from "../src/index.js";
import { useScanner } from "../src/vue/index.js";
import { FakeWebSocket, FakeWebSocketCtor, makeFetch } from "./helpers.js";

const resultBlob = new Blob(["%PDF-1.4 fake"], { type: "application/pdf" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => FakeWebSocket.reset());

describe("result download", () => {
  it("downloads the result once even when the agent closes the socket mid-download", async () => {
    const inner = makeFetch({
      "POST /scan": { json: { job_id: "job1" } },
      "GET /scan/job1/result": { blob: resultBlob },
    });
    let resultFetches = 0;
    const fetchImpl: HttpLike = async (url, init) => {
      if (url.endsWith("/result")) {
        resultFetches += 1;
        await sleep(30); // slow download: longer than the reconnect delay
      }
      return inner(url, init);
    };
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
      reconnectDelayMs: 0,
      maxReconnects: 5,
      stallTimeoutMs: 0,
    });
    const job = await client.scan({ device_id: "d1", backend: "twain" });
    const socketsBefore = FakeWebSocket.instances.length;

    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });
    FakeWebSocket.last!.emitClose(); // agent closes right after the terminal frame

    await job.completed();
    await sleep(20);
    expect(resultFetches).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(socketsBefore); // no reconnect
  });
});

describe("settings", () => {
  it("reads and updates agent settings", async () => {
    const bodies: unknown[] = [];
    const inner = makeFetch({
      "GET /settings": { json: { prefer_twain: true } },
      "PUT /settings": { json: { prefer_twain: false } },
    });
    const fetchImpl: HttpLike = (url, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return inner(url, init);
    };
    const client = new ScannerClient({ baseUrl: "http://agent", fetch: fetchImpl, WebSocket: FakeWebSocketCtor });

    expect(await client.getSettings()).toEqual({ prefer_twain: true });
    expect(await client.updateSettings({ prefer_twain: false })).toEqual({ prefer_twain: false });
    expect(bodies).toEqual([{ prefer_twain: false }]);
  });
});

describe("vue useScanner races", () => {
  function slowScanClient() {
    let n = 0;
    const inner = makeFetch({});
    const fetchImpl: HttpLike = async (url, init) => {
      if (url.endsWith("/scan")) {
        n += 1;
        const id = `job${n}`;
        await sleep(n === 1 ? 40 : 5); // first scan() resolves last
        return { ok: true, status: 200, json: async () => ({ job_id: id }), blob: async () => resultBlob, text: async () => "" };
      }
      return inner(url, init);
    };
    return new ScannerClient({ baseUrl: "http://agent", fetch: fetchImpl, WebSocket: FakeWebSocketCtor, stallTimeoutMs: 0 });
  }

  it("a stale scan() resolving after a newer one is closed and ignored", async () => {
    const scope = effectScope();
    const scanner = scope.run(() => useScanner(slowScanClient()))!;

    const first = scanner.scan({ device_id: "d1", backend: "twain" });
    const second = scanner.scan({ device_id: "d1", backend: "twain" });
    await Promise.all([first, second]);

    const sockets = FakeWebSocket.instances;
    expect(sockets).toHaveLength(2);
    const stale = sockets.find((s) => s.url.endsWith("/job1"))!;
    const current = sockets.find((s) => s.url.endsWith("/job2"))!;
    expect(stale.closed).toBe(true);
    expect(current.closed).toBe(false);

    stale.push({ status: "scanning", page_count: 3, max_pages: 9 });
    expect(scanner.pageCount.value).toBe(0); // stale job cannot touch state
    scope.stop();
  });

  it("a scan() resolving after the scope is disposed does not leak its socket", async () => {
    const scope = effectScope();
    const scanner = scope.run(() => useScanner(slowScanClient()))!;
    const pending = scanner.scan({ device_id: "d1", backend: "twain" });
    scope.stop();
    await pending;
    expect(FakeWebSocket.instances.every((s) => s.closed)).toBe(true);
  });

  it("status becomes error when the result download fails after done", async () => {
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: makeFetch({
        "POST /scan": { json: { job_id: "job1" } },
        "GET /scan/job1/result": { ok: false, status: 404, json: { detail: "Job not found" } },
      }),
      WebSocket: FakeWebSocketCtor,
      stallTimeoutMs: 0,
      retries: 0,
    });
    const scope = effectScope();
    const scanner = scope.run(() => useScanner(client))!;
    await scanner.scan({ device_id: "d1", backend: "twain" });
    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });
    await sleep(20);
    expect(scanner.error.value).not.toBeNull();
    expect(scanner.status.value).toBe("error");
    scope.stop();
  });
});
