import { describe, expect, it, vi } from "vitest";
import { ScannerClient, ScannerError, type HttpLike } from "../src/index.js";
import { FakeWebSocketCtor, makeFetch } from "./helpers.js";

describe("ScannerClient", () => {
  it("lists devices, filters, presets", async () => {
    const fetchImpl = makeFetch({
      "GET /devices": { json: [{ id: "d1", name: "HP", backend: "escl" }] },
      "GET /filters": { json: [{ name: "grayscale", params: {} }] },
      "GET /presets": { json: { bw_document: { description: "x", filters: [] } } },
    });
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
    });

    expect(await client.listDevices()).toHaveLength(1);
    expect((await client.listFilters())[0].name).toBe("grayscale");
    expect(await client.listPresets()).toHaveProperty("bw_document");
  });

  it("throws ScannerError with detail on non-2xx", async () => {
    const fetchImpl = makeFetch({
      "POST /scan": {
        ok: false,
        status: 422,
        json: { detail: "Specify either 'preset' or 'filters', not both" },
      },
    });
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
    });

    await expect(
      client.scan({ device_id: "d1", backend: "escl", preset: "x", filters: [{ name: "grayscale" }] }),
    ).rejects.toMatchObject({
      name: "ScannerError",
      status: 422,
      detail: "Specify either 'preset' or 'filters', not both",
    });
  });

  it("strips a trailing slash from baseUrl", () => {
    const client = new ScannerClient({
      baseUrl: "http://agent/",
      fetch: makeFetch({}),
      WebSocket: FakeWebSocketCtor,
    });
    expect(client.baseUrl).toBe("http://agent");
  });

  it("ScannerError formats a readable message", () => {
    const err = new ScannerError(409, "Job not awaiting a page");
    expect(err.message).toContain("409");
    expect(err.message).toContain("awaiting");
  });

  it("retries a transient 503 then succeeds", async () => {
    const fetchImpl = makeFetch({
      "GET /devices": [
        { ok: false, status: 503, json: { detail: "busy" } },
        { json: [{ id: "d1", name: "HP", backend: "escl" }] },
      ],
    });
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
      retries: 2,
      retryDelayMs: 0,
      timeoutMs: 0,
    });

    expect(await client.listDevices()).toHaveLength(1);
    expect(fetchImpl.calls.filter((c) => c.url.endsWith("/devices"))).toHaveLength(2);
  });

  it("does NOT retry the scan POST (would double-scan)", async () => {
    const fetchImpl = makeFetch({
      "POST /scan": [
        { ok: false, status: 503, json: { detail: "busy" } },
        { json: { job_id: "job1" } },
      ],
    });
    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
      retries: 5,
      retryDelayMs: 0,
    });

    await expect(client.scan({ device_id: "d1", backend: "escl" })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchImpl.calls.filter((c) => c.url.endsWith("/scan"))).toHaveLength(1);
  });

  describe("scan() pre-validation", () => {
    it("throws ScannerError(422) before HTTP call when png + max_pages > 1", async () => {
      const fetchImpl = makeFetch({});
      const client = new ScannerClient({
        baseUrl: "http://agent",
        fetch: fetchImpl,
        WebSocket: FakeWebSocketCtor,
      });

      await expect(
        client.scan({ device_id: "d1", backend: "escl", output_format: "png", max_pages: 2 }),
      ).rejects.toMatchObject({ name: "ScannerError", status: 422 });

      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("throws ScannerError(422) before HTTP call when jpeg + max_pages > 1", async () => {
      const fetchImpl = makeFetch({});
      const client = new ScannerClient({
        baseUrl: "http://agent",
        fetch: fetchImpl,
        WebSocket: FakeWebSocketCtor,
      });

      await expect(
        client.scan({ device_id: "d1", backend: "escl", output_format: "jpeg", max_pages: 3 }),
      ).rejects.toMatchObject({ name: "ScannerError", status: 422 });

      expect(fetchImpl.calls).toHaveLength(0);
    });

    it("allows png with max_pages=1 and makes the HTTP call", async () => {
      const fetchImpl = makeFetch({
        "POST /scan": { json: { job_id: "job1" } },
      });
      const client = new ScannerClient({
        baseUrl: "http://agent",
        fetch: fetchImpl,
        WebSocket: FakeWebSocketCtor,
      });

      await expect(
        client.scan({ device_id: "d1", backend: "escl", output_format: "png", max_pages: 1 }),
      ).resolves.toBeDefined();

      expect(fetchImpl.calls.filter((c) => c.url.endsWith("/scan"))).toHaveLength(1);
    });

    it("allows pdf with max_pages > 1 (no pre-validation error)", async () => {
      const fetchImpl = makeFetch({
        "POST /scan": { json: { job_id: "job1" } },
      });
      const client = new ScannerClient({
        baseUrl: "http://agent",
        fetch: fetchImpl,
        WebSocket: FakeWebSocketCtor,
      });

      await expect(
        client.scan({ device_id: "d1", backend: "escl", output_format: "pdf", max_pages: 5 }),
      ).resolves.toBeDefined();
    });
  });

  it("aborts a request after timeoutMs", async () => {
    vi.useFakeTimers();
    // Honors the abort signal: rejects when the timeout fires.
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as HttpLike;

    const client = new ScannerClient({
      baseUrl: "http://agent",
      fetch: fetchImpl,
      WebSocket: FakeWebSocketCtor,
      timeoutMs: 1000,
      retries: 0,
    });

    // Attach the rejection handler BEFORE advancing timers, else the reject
    // fires mid-advance with no handler and vitest flags a false unhandled.
    const assertion = expect(client.listDevices()).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
