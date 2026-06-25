import { describe, expect, it } from "vitest";
import { ScannerClient, ScannerError } from "../src/index.js";
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
});
