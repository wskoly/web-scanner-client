import { useCallback, useEffect, useRef, useState } from "react";
import type { ScannerClient } from "../client.js";
import type { ScanJob } from "../job.js";
import type { Device, JobStatus, ScanRequest } from "../types.js";

export interface UseDevicesResult {
  devices: Device[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

/** Loads and refreshes the device list from GET /devices. */
export function useDevices(client: ScannerClient): UseDevicesResult {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .listDevices()
      .then(setDevices)
      .catch((err: Error) => setError(err))
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { devices, loading, error, refresh };
}

export interface UseScannerResult {
  /** Kick off a scan; resolves once the job has been created. */
  scan: (request: ScanRequest) => Promise<void>;
  status: JobStatus | "idle";
  pageCount: number;
  maxPages: number;
  /** True while the agent waits for a flatbed page swap. */
  awaitingPage: boolean;
  /** Result blob once the scan completes. */
  result: Blob | null;
  error: Error | null;
  /** Capture the next flatbed page. */
  continueScan: () => Promise<void>;
  /** Stop early, assemble what's captured. */
  finishScan: () => Promise<void>;
  /** Clear state back to idle (closes any open job). */
  reset: () => void;
}

/**
 * Drives one scan job into React state. Subscribes to the job's events and
 * cleans up the WebSocket on unmount/reset.
 */
export function useScanner(client: ScannerClient): UseScannerResult {
  const [status, setStatus] = useState<JobStatus | "idle">("idle");
  const [pageCount, setPageCount] = useState(0);
  const [maxPages, setMaxPages] = useState(1);
  const [result, setResult] = useState<Blob | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const jobRef = useRef<ScanJob | null>(null);

  const teardown = useCallback(() => {
    jobRef.current?.close();
    jobRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const scan = useCallback(
    async (request: ScanRequest) => {
      teardown();
      setStatus("pending");
      setPageCount(0);
      setMaxPages(request.max_pages ?? 1);
      setResult(null);
      setError(null);

      try {
        const job = await client.scan(request);
        jobRef.current = job;
        job.on("progress", (ev) => {
          setStatus(ev.status);
          setPageCount(ev.pageCount);
          setMaxPages(ev.maxPages);
        });
        job.on("done", (blob) => setResult(blob));
        job.on("error", (err) => setError(err));
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    },
    [client, teardown],
  );

  const continueScan = useCallback(async () => {
    await jobRef.current?.continue();
  }, []);

  const finishScan = useCallback(async () => {
    await jobRef.current?.finish();
  }, []);

  const reset = useCallback(() => {
    teardown();
    setStatus("idle");
    setPageCount(0);
    setMaxPages(1);
    setResult(null);
    setError(null);
  }, [teardown]);

  return {
    scan,
    status,
    pageCount,
    maxPages,
    awaitingPage: status === "awaiting_page",
    result,
    error,
    continueScan,
    finishScan,
    reset,
  };
}
