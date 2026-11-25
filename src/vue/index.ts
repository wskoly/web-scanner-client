import { onScopeDispose, ref, type Ref } from "vue";
import type { ScannerClient } from "../client.js";
import type { ScanJob } from "../job.js";
import type { Device, JobStatus, ScanRequest } from "../types.js";

export interface UseScannerReturn {
  devices: Ref<Device[]>;
  status: Ref<JobStatus | "idle">;
  pageCount: Ref<number>;
  maxPages: Ref<number>;
  awaitingPage: Ref<boolean>;
  result: Ref<Blob | null>;
  error: Ref<Error | null>;
  warnings: Ref<string[]>;
  loadDevices: () => Promise<void>;
  scan: (request: ScanRequest) => Promise<void>;
  continueScan: () => Promise<void>;
  finishScan: () => Promise<void>;
  abortScan: () => Promise<void>;
  reset: () => void;
}

/**
 * Vue composable mirroring the React useScanner shape. Tears down the
 * progress WebSocket when the owning scope is disposed.
 */
export function useScanner(client: ScannerClient): UseScannerReturn {
  const devices = ref<Device[]>([]);
  const status = ref<JobStatus | "idle">("idle");
  const pageCount = ref(0);
  const maxPages = ref(1);
  const awaitingPage = ref(false);
  const result = ref<Blob | null>(null);
  const error = ref<Error | null>(null);
  const warnings = ref<string[]>([]);

  let job: ScanJob | null = null;
  // See the React hook: guards against a stale scan() resolving after a newer
  // scan()/reset() or after the scope was disposed.
  let generation = 0;

  const teardown = () => {
    generation += 1;
    job?.close();
    job = null;
  };

  const loadDevices = async () => {
    devices.value = await client.listDevices();
  };

  const scan = async (request: ScanRequest) => {
    teardown();
    status.value = "pending";
    pageCount.value = 0;
    maxPages.value = request.max_pages ?? 1;
    awaitingPage.value = false;
    result.value = null;
    error.value = null;
    warnings.value = [];

    const myGeneration = generation;
    try {
      const created = await client.scan(request);
      if (myGeneration !== generation) {
        created.close();
        return;
      }
      job = created;
      job.on("progress", (ev) => {
        status.value = ev.status;
        pageCount.value = ev.pageCount;
        maxPages.value = ev.maxPages;
        awaitingPage.value = ev.status === "awaiting_page";
      });
      job.on("done", (blob) => {
        result.value = blob;
        awaitingPage.value = false;
      });
      job.on("error", (err) => {
        error.value = err;
        status.value = "error";
        awaitingPage.value = false;
      });
      job.on("warning", (msg) => {
        warnings.value = [...warnings.value, msg];
      });
    } catch (err) {
      if (myGeneration !== generation) return;
      error.value = err instanceof Error ? err : new Error(String(err));
      status.value = "error";
    }
  };

  const continueScan = async () => {
    await job?.continue();
  };

  const finishScan = async () => {
    await job?.finish();
  };

  const abortScan = async () => {
    await job?.abort();
  };

  const reset = () => {
    teardown();
    status.value = "idle";
    pageCount.value = 0;
    maxPages.value = 1;
    awaitingPage.value = false;
    result.value = null;
    error.value = null;
    warnings.value = [];
  };

  onScopeDispose(teardown);

  return {
    devices,
    status,
    pageCount,
    maxPages,
    awaitingPage,
    result,
    error,
    warnings,
    loadDevices,
    scan,
    continueScan,
    finishScan,
    abortScan,
    reset,
  };
}
