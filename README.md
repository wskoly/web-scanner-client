# web-scanner-client

Framework-agnostic TypeScript client for the [web-scanner-sdk](mailto:contact@wskoly.xyz) local agent. Scan documents from any browser over a trusted HTTPS connection : no plugins, no driver code, no `fetch`/`WebSocket` boilerplate.

Ships a **core** client plus optional **React** hooks and a **Vue** composable. React/Vue are optional peer deps; unused ones are tree-shaken away.

## Prerequisites

The [web-scanner-sdk](mailto:contact@wskoly.xyz) desktop agent must be installed and running on the user's machine. The installer:
- Registers a local trusted CA via [mkcert](https://github.com/FiloSottile/mkcert) (accepted by all major browsers, no warning)
- Starts the agent at `https://127.0.0.1:51823` on login

No browser configuration required.

## Install

```bash
npm install web-scanner-client
```

## Quick start

```ts
import { ScannerClient } from "web-scanner-client";

const client = new ScannerClient(); // connects to https://127.0.0.1:51823

// 1. List connected scanners
const devices = await client.listDevices();

// 2. Start a scan
const job = await client.scan({
  device_id: devices[0].id,
  backend: devices[0].backend,
  dpi: 300,
  source: "flatbed",
  output_format: "pdf",
  preset: "bw_document",   // or pass `filters: [...]` for custom processing
});

// 3. Track progress (live via wss://)
job.on("progress", (e) => console.log(e.status, e.pageCount, "/", e.maxPages));

// 4. Get the result
const blob = await job.completed();
const url = URL.createObjectURL(blob);
```

## Multi-page (page-swap flow)

For `source: "flatbed"` with `max_pages > 1`, the agent pauses after each page and emits `awaiting_page`. Prompt the user to place the next page, then call `continue()` : or `finish()` to stop early and keep what's been scanned:

```ts
const job = await client.scan({
  device_id, backend,
  source: "flatbed",
  max_pages: 3,
  output_format: "pdf",   // required for max_pages > 1; png/jpeg only support single-page output
});

job.on("awaiting_page", (e) => {
  showPrompt(`Page ${e.pageCount} of ${e.maxPages} done. Place next page, then click Continue.`);
});

// from your UI buttons:
await job.continue(); // scan next page
await job.finish();   // stop and assemble pages captured so far
```

## React

```tsx
import { ScannerClient } from "web-scanner-client";
import { useDevices, useScanner } from "web-scanner-client/react";

const client = new ScannerClient();

function ScanPanel() {
  const { devices, loading: devicesLoading, error: devicesError, refresh } = useDevices(client);
  const { scan, status, awaitingPage, continueScan, finishScan, result, error, warnings, reset } =
    useScanner(client);
  // drive your UI from these; WebSocket is cleaned up on unmount
}
```

See [`examples/react.tsx`](./examples/react.tsx).

### `useDevices(client)`

Auto-fetches on mount. Re-fetch any time by calling `refresh()`.

| field | type | description |
| --- | --- | --- |
| `devices` | `Device[]` | current device list |
| `loading` | `boolean` | `true` while fetching |
| `error` | `Error \| null` | `null` on success |
| `refresh` | `() => void` | re-fetch devices |

### `useScanner(client)`

WebSocket is torn down on unmount automatically.

| field | type | description |
| --- | --- | --- |
| `scan` | `(req: ScanRequest) => Promise<void>` | start a scan |
| `status` | `JobStatus \| "idle"` | current job state |
| `pageCount` | `number` | pages scanned so far |
| `maxPages` | `number` | as requested |
| `awaitingPage` | `boolean` | `true` when `status === "awaiting_page"` |
| `result` | `Blob \| null` | result blob when done |
| `error` | `Error \| null` | set on failure |
| `warnings` | `string[]` | reconnect/warning log, latest last |
| `continueScan` | `() => Promise<void>` | scan the next page |
| `finishScan` | `() => Promise<void>` | stop early, assemble captured pages |
| `abortScan` | `() => Promise<void>` | abort — immediate if `awaiting_page`, deferred otherwise |
| `reset` | `() => void` | clear state to idle, close job |

## Vue

```ts
import { ScannerClient } from "web-scanner-client";
import { useScanner } from "web-scanner-client/vue";

const client = new ScannerClient();
const { devices, status, awaitingPage, scan, continueScan, finishScan, abortScan, result, error, warnings, loadDevices, reset } =
  useScanner(client);
```

See [`examples/vue.vue`](./examples/vue.vue).

### `useScanner(client)` (Vue)

Single composable combines device list and scan state. All state values are `Ref<T>`. Call `loadDevices()` explicitly to populate `devices` (no auto-fetch on mount). WebSocket is torn down via `onScopeDispose`.

| field | type | description |
| --- | --- | --- |
| `devices` | `Ref<Device[]>` | device list; call `loadDevices()` to populate |
| `status` | `Ref<JobStatus \| "idle">` | current job state |
| `pageCount` | `Ref<number>` | pages scanned so far |
| `maxPages` | `Ref<number>` | as requested |
| `awaitingPage` | `Ref<boolean>` | `true` when awaiting a page swap |
| `result` | `Ref<Blob \| null>` | result blob when done |
| `error` | `Ref<Error \| null>` | set on failure |
| `warnings` | `Ref<string[]>` | reconnect/warning log, latest last |
| `loadDevices` | `() => Promise<void>` | fetch and populate `devices` |
| `scan` | `(req: ScanRequest) => Promise<void>` | start a scan |
| `continueScan` | `() => Promise<void>` | scan the next page |
| `finishScan` | `() => Promise<void>` | stop early, assemble captured pages |
| `abortScan` | `() => Promise<void>` | abort — immediate if `awaiting_page`, deferred otherwise |
| `reset` | `() => void` | clear state to idle, close job |

## API

### `new ScannerClient(options?)`

| option | default | notes |
| --- | --- | --- |
| `baseUrl` | `https://127.0.0.1:51823` | Agent address. Change to `http://` only in dev without the installer. |
| `fetch` | `globalThis.fetch` | Inject for Node/testing. |
| `WebSocket` | `globalThis.WebSocket` | Inject for Node/testing. Progress uses `wss://` automatically when `baseUrl` is `https://`. |
| `timeoutMs` | `30000` | Per-request timeout. `0` disables. |
| `retries` | `2` | Auto-retry on transient failures (network errors, 429/502/503/504) for GET and scan start. `continue()`/`finish()` are never retried. |
| `retryDelayMs` | `500` | Base backoff; doubles per attempt, capped at 5s. |
| `maxReconnects` | `5` | WebSocket reconnect attempts before failing. |
| `reconnectDelayMs` | `500` | Base reconnect backoff; doubles per attempt, capped at 5s. |
| `stallTimeoutMs` | `300000` | Force reconnect if no `wss://` frame arrives for this long. Paused during `awaiting_page`. `0` disables. |

The progress WebSocket auto-reconnects with backoff on drop or stall. The agent re-sends the current job state on every reconnect, so nothing is missed. Subscribe to `job.on("warning", …)` to observe reconnect events.

### Methods

| method | returns |
| --- | --- |
| `listDevices()` | `Promise<Device[]>` |
| `listFilters()` | `Promise<FilterDef[]>` |
| `listPresets()` | `Promise<Record<string, Preset>>` |
| `scan(request)` | `Promise<ScanJob>` |

### Response types

**`Device`**

| field | type | notes |
| --- | --- | --- |
| `id` | `string` | pass back verbatim to `scan()` |
| `name` | `string` | human display name |
| `backend` | `string` | `"wia"` / `"twain"` / `"sane"` / `"escl"` |

**`FilterDef`**

| field | type |
| --- | --- |
| `name` | `string` |
| `params` | `Record<string, FilterParamDef>` |

`FilterParamDef`:
```ts
{
  type: "choice" | "number";
  default: string | number;
  choices?: string[];   // present when type === "choice"
  min?: number;         // present when type === "number"
  max?: number;
}
```

**`Preset`** (one value in the `Record<string, Preset>` returned by `listPresets()`)

| field | type |
| --- | --- |
| `description` | `string` |
| `filters` | `Array<{ name: string; params?: Record<string, unknown> }>` |

### `ScanRequest`

| field | default | values |
| --- | --- | --- |
| `device_id` | : | from `listDevices()` |
| `backend` | : | from `listDevices()` |
| `dpi` | `300` | `75` / `150` / `200` / `300` / `600` |
| `color_mode` | `"color"` | `"color"` / `"grayscale"` / `"black_and_white"` |
| `source` | `"flatbed"` | `"flatbed"` / `"adf"` / `"adf_duplex"` |
| `output_format` | `"pdf"` | `"pdf"` / `"png"` / `"jpeg"` — **PNG and JPEG only support `max_pages: 1`** |
| `max_pages` | `1` | positive integer (≥ 1) — **must be `1` when `output_format` is `"png"` or `"jpeg"`** |
| `page_swap_timeout` | `600` | seconds to wait for flatbed page swap before auto-finishing with captured pages; `0` = wait indefinitely; only relevant for `source: "flatbed"` with `max_pages > 1` |
| `preset` | : | string from `listPresets()` — mutually exclusive with `filters` |
| `filters` | : | `[{ name, params? }]` — mutually exclusive with `preset` |

> **Note**: Passing `output_format: "png"` or `"jpeg"` with `max_pages > 1` throws a `ScannerError(422)` immediately in the client — no HTTP request is made. The SDK server enforces the same rule and returns HTTP 422 if the constraint is bypassed. Use `output_format: "pdf"` for all multi-page scans.

### `ScanJob`

#### Properties

| member | type | notes |
| --- | --- | --- |
| `id` | `string` | job UUID |
| `status` | `JobStatus` | current state |
| `pageCount` | `number` | pages scanned so far |
| `maxPages` | `number` | as requested |

`JobStatus` values: `"pending" | "scanning" | "awaiting_page" | "processing" | "done" | "error"`

#### Methods

| method | returns | notes |
| --- | --- | --- |
| `on(event, cb)` | `() => void` | subscribe; returned fn unsubscribes |
| `continue()` | `Promise<void>` | scan next page — only valid while `awaiting_page` |
| `finish()` | `Promise<void>` | stop early, assemble captured pages — only valid while `awaiting_page` |
| `abort()` | `Promise<void>` | signal abort — immediate if `awaiting_page`, deferred to next page boundary otherwise |
| `completed()` | `Promise<Blob>` | resolves on `done`, rejects on `error` |
| `resultUrl()` | `string` | direct server URL (`/scan/{id}/result`) — use for `<a href>` or `<img src>` while the agent is running |
| `close()` | `void` | tear down the WebSocket; safe to call repeatedly |

#### Events

| event | callback signature | description |
| --- | --- | --- |
| `"progress"` | `(ev: ScanJobEvent) => void` | every status change |
| `"awaiting_page"` | `(ev: ScanJobEvent) => void` | agent waiting for next flatbed page |
| `"done"` | `(blob: Blob, meta: { format: OutputFormat }) => void` | scan finished; `meta.format` matches your `output_format` |
| `"error"` | `(err: Error) => void` | terminal failure |
| `"warning"` | `(msg: string) => void` | non-fatal: reconnect attempts, dropped frames |

`ScanJobEvent` (payload for `"progress"` and `"awaiting_page"`):
```ts
{
  status: JobStatus;
  pageCount: number;
  maxPages: number;
  error: string | null;   // non-null only when status === "error"
}
```

### `ScannerError`

Thrown for any non-2xx response from the agent, and for client-side validation failures.

| field | type | description |
| --- | --- | --- |
| `status` | `number` | HTTP status code |
| `detail` | `unknown` | FastAPI error detail (string, array, or `null`) |
| `message` | `string` | human-readable: `"{status}: {detail}"` |

Two throw sites:
- **Client-side** (`status: 422`): validation before any HTTP request (e.g. `png` + `max_pages > 1`, `preset` + `filters` both set)
- **Server-side**: any non-2xx response from the agent

## Dev without the installer

If you run the agent directly (no installer, no mkcert), it falls back to plain HTTP:

```ts
const client = new ScannerClient({ baseUrl: "http://127.0.0.1:51823" });
```

Serve your frontend over `http://localhost` in this mode : browsers block `http://` calls from `https://` pages (mixed content). Install the desktop package for production use to get trusted HTTPS automatically.

## License

MIT
