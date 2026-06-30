import { useMemo, useState } from "react";
import { ScannerClient } from "web-scanner-client";
import { useDevices, useScanner } from "web-scanner-client/react";

export function ScanPanel() {
  const client = useMemo(() => new ScannerClient(), []);
  const { devices, loading: devicesLoading, error: devicesError, refresh } = useDevices(client);
  const {
    scan,
    status,
    pageCount,
    maxPages,
    awaitingPage,
    result,
    error,
    warnings,
    continueScan,
    finishScan,
    reset,
  } = useScanner(client);

  const [selected, setSelected] = useState("");

  const scanning = status !== "idle" && status !== "done" && status !== "error";

  const resultUrl = useMemo(
    () => (result ? URL.createObjectURL(result) : null),
    [result],
  );

  const start = () => {
    const device = devices.find((d) => d.id === selected);
    if (!device) return;
    void scan({
      device_id: device.id,
      backend: device.backend,
      dpi: 200,
      source: "flatbed",
      output_format: "pdf",
      max_pages: 2, // exercise the page-swap flow; use max_pages: 1 with png/jpeg
      preset: "bw_document",
    });
  };

  return (
    <div>
      <button onClick={refresh} disabled={devicesLoading}>
        {devicesLoading ? "Loading…" : "Refresh devices"}
      </button>
      {devicesError && <p style={{ color: "red" }}>Devices: {devicesError.message}</p>}

      <select value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Select scanner…</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            [{d.backend}] {d.name}
          </option>
        ))}
      </select>

      <button onClick={start} disabled={!selected || scanning}>
        {scanning ? "Scanning…" : "Scan"}
      </button>

      {status !== "idle" && (
        <button onClick={reset} style={{ marginLeft: 8 }}>
          Reset
        </button>
      )}

      <p>
        status: {status} ({pageCount}/{maxPages})
      </p>

      {awaitingPage && (
        <div>
          <p>Swap the document on the glass, then continue.</p>
          <button onClick={() => void continueScan()}>Continue</button>
          <button onClick={() => void finishScan()}>Finish now</button>
        </div>
      )}

      {error && <p style={{ color: "red" }}>Error: {error.message}</p>}

      {warnings.length > 0 && (
        <ul style={{ color: "#a16207", fontSize: "0.85em" }}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      {resultUrl && (
        <a href={resultUrl} download="scan.pdf">
          Download scan.pdf
        </a>
      )}
    </div>
  );
}
