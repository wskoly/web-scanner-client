# web-scanner-client

Framework-agnostic TypeScript client for the [web-scanner-sdk](../web-scanner-sdk) local agent. Talk to any document scanner (Windows WIA/TWAIN, Linux SANE, network eSCL/AirScan) from the browser — devices, presets, filters, live progress, multi-page flatbed page-swap prompts, and the result file as a `Blob` — without hand-writing `fetch`/`WebSocket` glue.

Ships a **core** client plus optional **React** hooks and a **Vue** composable. React/Vue are optional peer deps; if you don't use them, they're tree-shaken away.

## Install

```bash
npm install web-scanner-client
```

The agent must be running locally (defaults to `http://127.0.0.1:51823`). It only listens on loopback — scanning is local-only by design.

## Quick start (core)

```ts
import { ScannerClient } from "web-scanner-client";

const client = new ScannerClient(); // baseUrl defaults to http://127.0.0.1:51823

const devices = await client.listDevices();
const device = devices[0];

const job = await client.scan({
  device_id: device.id,
  backend: device.backend,
  dpi: 300,
  source: "flatbed",
  output_format: "pdf",
  preset: "bw_document",   // or pass `filters: [...]` for manual control
});

job.on("progress", (e) => console.log(e.status, e.pageCount, "/", e.maxPages));
job.on("error", (err) => console.error(err));

const blob = await job.completed();   // resolves on done, rejects on error
const url = URL.createObjectURL(blob);
```

## Multi-page flatbed (page-swap flow)

Flatbed scanners can't autofeed, so for `source: "flatbed"` with `max_pages > 1` the agent **pauses** after each page and emits `awaiting_page`. Prompt the user to swap the document, then call `continue()` (or `finish()` to stop early and keep the pages captured so far):

```ts
const job = await client.scan({
  device_id, backend, source: "flatbed", max_pages: 3, output_format: "pdf",
});

job.on("awaiting_page", (e) => {
  showPrompt(`Captured page ${e.pageCount} of ${e.maxPages}. Swap the page, then click Continue.`);
});

// from your UI buttons:
await job.continue(); // capture next page
await job.finish();   // stop now, assemble what we have
```

## React

```tsx
import { ScannerClient } from "web-scanner-client";
import { useDevices, useScanner } from "web-scanner-client/react";

const client = new ScannerClient();

function Panel() {
  const { devices } = useDevices(client);
  const { scan, status, awaitingPage, continueScan, finishScan, result, error } =
    useScanner(client);
  // ...drive your UI from these; WS is cleaned up on unmount.
}
```

See [`examples/react.tsx`](./examples/react.tsx).

## Vue

```ts
import { ScannerClient } from "web-scanner-client";
import { useScanner } from "web-scanner-client/vue";

const client = new ScannerClient();
const { devices, status, awaitingPage, scan, continueScan, finishScan, result, error, loadDevices } =
  useScanner(client);
```

See [`examples/vue.vue`](./examples/vue.vue).

## API

### `new ScannerClient(options?)`

| option | default | notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:51823` | Agent address. |
| `fetch` | `globalThis.fetch` | Inject for Node/testing. |
| `WebSocket` | `globalThis.WebSocket` | Inject for Node/testing. |
| `timeoutMs` | `30000` | Per-request timeout (AbortController). `0` disables. |
| `retries` | `2` | Transient-failure retries (429/502/503/504 + network errors) for idempotent calls — GET, scan start, result fetch. **`continue()`/`finish()` are never retried** (not idempotent). |
| `retryDelayMs` | `500` | Base retry backoff; doubles per attempt, capped 5s. |
| `maxReconnects` | `5` | WebSocket auto-reconnect attempts before failing. |
| `reconnectDelayMs` | `500` | Base reconnect backoff; doubles per attempt, capped 5s. |
| `stallTimeoutMs` | `300000` | If no WS frame arrives for this long (a dead/half-open socket), force a reconnect. Paused during `awaiting_page`. Raise it if you scan very large pages at high DPI that can take minutes with no intermediate frame; `0` disables. |

**Fault tolerance.** The progress WebSocket auto-reconnects with backoff on drop or stall; the agent re-sends current job status on every connect, so a scan resumes (even if it finished while you were disconnected). HTTP calls time out and retry transient failures (including printer "busy" 503s). Subscribe to `job.on("warning", …)` to observe reconnect attempts and dropped malformed frames.

| method | returns |
| --- | --- |
| `listDevices()` | `Promise<Device[]>` |
| `listFilters()` | `Promise<FilterDef[]>` — raw filter registry + param schema |
| `listPresets()` | `Promise<Record<string, Preset>>` |
| `scan(request)` | `Promise<ScanJob>` |

### `ScanRequest`

`device_id`, `backend` (required), plus optional `dpi` (300), `color_mode` (`color`\|`grayscale`\|`black_and_white`), `source` (`flatbed`\|`adf`\|`adf_duplex`), `output_format` (`pdf`\|`png`\|`jpeg`), `max_pages` (1), and **either** `preset` (string) **or** `filters` (array) — not both (the agent rejects both with a `422`).

### `ScanJob`

| member | description |
| --- | --- |
| `id`, `status`, `pageCount`, `maxPages` | live state |
| `on("progress" \| "awaiting_page" \| "done" \| "error" \| "warning", cb)` | subscribe; returns an unsubscribe fn |
| `continue()` / `finish()` | flatbed page-swap controls (valid only while `awaiting_page`) |
| `completed()` | `Promise<Blob>` — resolves on done, rejects on error |
| `resultUrl()` | URL for `<a download>` / `<img src>` |
| `close()` | tear down the WebSocket |

Non-2xx responses throw `ScannerError` with `.status` and `.detail` (the agent's message).

## Caveat: HTTPS mixed content

Browsers block `http://127.0.0.1:51823` calls from a page served over **`https://`** (mixed content). During development serve your app over `http://localhost`. For production, front the agent with local TLS (or run the frontend over http on the same machine). The agent never accepts remote connections.

## License

MIT
