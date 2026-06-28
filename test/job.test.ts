import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScannerClient, type ScannerClientOptions } from "../src/index.js";
import { FakeWebSocket, FakeWebSocketCtor, makeFetch } from "./helpers.js";

const resultBlob = new Blob(["%PDF-1.4 fake"], { type: "application/pdf" });

beforeEach(() => FakeWebSocket.reset());

function makeClient(overrides: Partial<ScannerClientOptions> = {}, extraRoutes = {}) {
  const fetchImpl = makeFetch({
    "POST /scan": { json: { job_id: "job1" } },
    "GET /scan/job1/result": { blob: resultBlob },
    "POST /scan/job1/continue": { json: { status: "ok" } },
    "POST /scan/job1/finish": { json: { status: "ok" } },
    ...extraRoutes,
  });
  const client = new ScannerClient({
    baseUrl: "http://agent",
    fetch: fetchImpl,
    WebSocket: FakeWebSocketCtor,
    // Deterministic + fast for tests; individual tests override as needed.
    retryDelayMs: 0,
    reconnectDelayMs: 0,
    stallTimeoutMs: 0,
    maxReconnects: 0,
    ...overrides,
  });
  return { client, fetchImpl };
}

describe("ScanJob lifecycle", () => {
  it("upgrades https baseUrl to wss:// for the progress socket", async () => {
    const { client } = makeClient({ baseUrl: "https://agent" });
    await client.scan({ device_id: "d1", backend: "escl" });
    expect(FakeWebSocket.last!.url).toMatch(/^wss:\/\//);
  });

  it("emits progress and resolves completed() with the result blob on done", async () => {
    const { client } = makeClient();
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    const seen: string[] = [];
    job.on("progress", (e) => seen.push(e.status));

    FakeWebSocket.last!.push({ status: "scanning", page_count: 0, max_pages: 1 });
    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });

    const blob = await job.completed();
    expect(seen).toEqual(["scanning", "done"]);
    expect(blob.type).toBe("application/pdf");
    expect(FakeWebSocket.last!.closed).toBe(true);
  });

  it("drives the multi-page flatbed awaiting_page -> continue -> done flow", async () => {
    const { client, fetchImpl } = makeClient();
    const job = await client.scan({
      device_id: "d1",
      backend: "escl",
      source: "flatbed",
      max_pages: 2,
      output_format: "pdf",
    });

    let awaiting = 0;
    job.on("awaiting_page", (e) => {
      awaiting++;
      expect(e.pageCount).toBe(1);
      expect(e.maxPages).toBe(2);
    });

    FakeWebSocket.last!.push({ status: "scanning", page_count: 0, max_pages: 2 });
    FakeWebSocket.last!.push({ status: "awaiting_page", page_count: 1, max_pages: 2 });

    await job.continue();
    expect(fetchImpl.calls.some((c) => c.method === "POST" && c.url.endsWith("/continue"))).toBe(true);

    FakeWebSocket.last!.push({ status: "scanning", page_count: 1, max_pages: 2 });
    FakeWebSocket.last!.push({ status: "done", page_count: 2, max_pages: 2 });

    const blob = await job.completed();
    expect(awaiting).toBe(1);
    expect(blob.type).toBe("application/pdf");
  });

  it("finish() posts /finish", async () => {
    const { client, fetchImpl } = makeClient();
    const job = await client.scan({
      device_id: "d1",
      backend: "escl",
      source: "flatbed",
      max_pages: 5,
      output_format: "pdf",
    });

    FakeWebSocket.last!.push({ status: "awaiting_page", page_count: 1, max_pages: 5 });
    await job.finish();
    expect(fetchImpl.calls.some((c) => c.method === "POST" && c.url.endsWith("/finish"))).toBe(true);

    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 5 });
    await job.completed();
  });

  it("rejects completed() and emits error on an error frame", async () => {
    const { client } = makeClient();
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    let errMsg = "";
    job.on("error", (err) => (errMsg = err.message));

    FakeWebSocket.last!.push({ status: "error", page_count: 0, max_pages: 1, error: "409 Conflict" });

    await expect(job.completed()).rejects.toThrow("409 Conflict");
    expect(errMsg).toBe("409 Conflict");
  });
});

describe("ScanJob fault tolerance", () => {
  it("fails once when error frame is followed by a socket close (no double-fire)", async () => {
    const { client } = makeClient(); // maxReconnects: 0
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    let errorCount = 0;
    job.on("error", () => errorCount++);

    FakeWebSocket.last!.push({ status: "error", page_count: 0, max_pages: 1, error: "boom" });
    FakeWebSocket.last!.emitClose(); // would have re-triggered error pre-fix

    await expect(job.completed()).rejects.toThrow("boom");
    expect(errorCount).toBe(1);
  });

  it("gives up after maxReconnects when the socket keeps dropping", async () => {
    const { client } = makeClient({ maxReconnects: 0 });
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    FakeWebSocket.last!.emitClose();
    await expect(job.completed()).rejects.toThrow(/gave up after 0 reconnect/);
  });

  it("auto-reconnects after a dropped socket and resumes to done", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({ maxReconnects: 3, reconnectDelayMs: 10, timeoutMs: 0 });
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    const warnings: string[] = [];
    job.on("warning", (m) => warnings.push(m));

    FakeWebSocket.last!.push({ status: "scanning", page_count: 0, max_pages: 1 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.last!.emitClose();
    await vi.advanceTimersByTimeAsync(20); // let the reconnect timer fire
    expect(FakeWebSocket.instances).toHaveLength(2); // new socket opened

    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });
    vi.useRealTimers();

    const blob = await job.completed();
    expect(blob.type).toBe("application/pdf");
    expect(warnings.some((w) => w.includes("reconnect"))).toBe(true);
  });

  it("forces a reconnect when no frame arrives within the stall timeout", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      maxReconnects: 2,
      reconnectDelayMs: 10,
      stallTimeoutMs: 1000,
      timeoutMs: 0,
    });
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // stall watchdog fires -> schedules reconnect
    await vi.advanceTimersByTimeAsync(20); // reconnect timer fires -> new socket
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });
    vi.useRealTimers();
    await job.completed();
  });

  it("does not stall-timeout while awaiting a page swap", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({ maxReconnects: 2, stallTimeoutMs: 1000, timeoutMs: 0 });
    const job = await client.scan({
      device_id: "d1",
      backend: "escl",
      source: "flatbed",
      max_pages: 2,
      output_format: "pdf",
    });

    FakeWebSocket.last!.push({ status: "awaiting_page", page_count: 1, max_pages: 2 });
    await vi.advanceTimersByTimeAsync(5000); // way past stall timeout
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect; still waiting on user

    FakeWebSocket.last!.push({ status: "done", page_count: 2, max_pages: 2 });
    vi.useRealTimers();
    await job.completed();
  });

  it("a throwing listener does not break dispatch or other listeners", async () => {
    const { client } = makeClient();
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    const seen: string[] = [];
    job.on("progress", () => {
      throw new Error("user callback blew up");
    });
    job.on("progress", (e) => seen.push(e.status)); // must still fire

    FakeWebSocket.last!.push({ status: "scanning", page_count: 0, max_pages: 1 });
    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });

    const blob = await job.completed();
    expect(seen).toEqual(["scanning", "done"]);
    expect(blob.type).toBe("application/pdf");
  });

  it("warns and drops a malformed frame without failing", async () => {
    const { client } = makeClient();
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    const warnings: string[] = [];
    job.on("warning", (m) => warnings.push(m));

    FakeWebSocket.last!.pushRaw("not json {");
    FakeWebSocket.last!.pushRaw(JSON.stringify({ no_status: true }));
    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });

    const blob = await job.completed();
    expect(blob.type).toBe("application/pdf");
    expect(warnings.filter((w) => w.includes("malformed"))).toHaveLength(2);
  });

  it("retries a transient 503 on the result fetch", async () => {
    const { client, fetchImpl } = makeClient(
      { retries: 2 },
      {
        "GET /scan/job1/result": [
          { ok: false, status: 503, json: { detail: "busy" } },
          { blob: resultBlob },
        ],
      },
    );
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    FakeWebSocket.last!.push({ status: "done", page_count: 1, max_pages: 1 });
    const blob = await job.completed();
    expect(blob.type).toBe("application/pdf");
    expect(fetchImpl.calls.filter((c) => c.url.endsWith("/result"))).toHaveLength(2);
  });

  it("never retries continue() (not idempotent)", async () => {
    const { client, fetchImpl } = makeClient(
      { retries: 5 },
      {
        "POST /scan/job1/continue": [
          { ok: false, status: 503, json: { detail: "busy" } },
          { json: { status: "ok" } },
        ],
      },
    );
    const job = await client.scan({
      device_id: "d1",
      backend: "escl",
      source: "flatbed",
      max_pages: 2,
      output_format: "pdf",
    });

    FakeWebSocket.last!.push({ status: "awaiting_page", page_count: 1, max_pages: 2 });
    await expect(job.continue()).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl.calls.filter((c) => c.url.endsWith("/continue"))).toHaveLength(1);
  });
});
