import { describe, expect, it } from "vitest";
import { ScannerClient } from "../src/index.js";
import { FakeWebSocket, FakeWebSocketCtor, makeFetch } from "./helpers.js";

const resultBlob = new Blob(["%PDF-1.4 fake"], { type: "application/pdf" });

function makeClient(extraRoutes = {}) {
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
  });
  return { client, fetchImpl };
}

describe("ScanJob lifecycle", () => {
  it("emits progress and resolves completed() with the result blob on done", async () => {
    const { client } = makeClient();
    const job = await client.scan({
      device_id: "d1",
      backend: "escl",
      output_format: "pdf",
    });

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

  it("fails if the socket closes before a terminal status", async () => {
    const { client } = makeClient();
    const job = await client.scan({ device_id: "d1", backend: "escl", output_format: "pdf" });

    FakeWebSocket.last!.push({ status: "scanning", page_count: 0, max_pages: 1 });
    FakeWebSocket.last!.emitClose();

    await expect(job.completed()).rejects.toThrow(/before job finished/);
  });
});
