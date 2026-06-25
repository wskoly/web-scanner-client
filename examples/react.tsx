import { useMemo, useState } from "react";
import { ScannerClient } from "web-scanner-client";
import { useDevices, useScanner } from "web-scanner-client/react";

export function ScanPanel() {
  const client = useMemo(() => new ScannerClient(), []);
  const { devices, refresh } = useDevices(client);
  const {
    scan,
    status,
    pageCount,
    maxPages,
    awaitingPage,
    result,
    error,
    continueScan,
    finishScan,
  } = useScanner(client);

  const [selected, setSelected] = useState("");

  const start = () => {
    const device = devices.find((d) => d.id === selected);
    if (!device) return;
    void scan({
      device_id: device.id,
      backend: device.backend,
      dpi: 200,
      source: "flatbed",
      output_format: "pdf",
      max_pages: 2, // exercise the page-swap flow
      preset: "bw_document",
    });
  };

  return (
    <div>
      <button onClick={refresh}>Refresh devices</button>
      <select value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Select scanner…</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            [{d.backend}] {d.name}
          </option>
        ))}
      </select>
      <button onClick={start} disabled={!selected}>
        Scan
      </button>

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

      {result && (
        <a href={URL.createObjectURL(result)} download="scan.pdf">
          Download scan.pdf
        </a>
      )}
    </div>
  );
}
