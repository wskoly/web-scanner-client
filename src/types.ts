// Wire types mirror the FastAPI agent in web_scanner_sdk/server.py and
// scan_options.py. Kept as string-literal unions (not TS enums) so callers can
// pass plain strings and the values match the Python enums exactly.

export type ColorMode = "color" | "grayscale" | "black_and_white";
export type ScanSource = "flatbed" | "adf" | "adf_duplex";
export type OutputFormat = "png" | "jpeg" | "pdf";

export type JobStatus =
  | "pending"
  | "scanning"
  | "awaiting_page"
  | "processing"
  | "done"
  | "error";

export interface Device {
  /** Backend-specific device id, passed back verbatim to scan(). */
  id: string;
  name: string;
  /** "wia" | "twain" | "sane" | "escl" */
  backend: string;
}

/** A single filter param's UI schema, as advertised by GET /filters. */
export interface FilterParamDef {
  type: "choice" | "number";
  default: string | number;
  choices?: string[];
  min?: number;
  max?: number;
}

export interface FilterDef {
  name: string;
  params: Record<string, FilterParamDef>;
}

/** One filter to run, server-side, on every scanned page. */
export interface FilterSpec {
  name: string;
  params?: Record<string, unknown>;
}

export interface Preset {
  description: string;
  filters: FilterSpec[];
}

export interface ScanRequest {
  device_id: string;
  backend: string;
  dpi?: number;
  color_mode?: ColorMode;
  source?: ScanSource;
  output_format?: OutputFormat;
  max_pages?: number;
  /**
   * How long (seconds) the server waits for the next flatbed page swap before
   * auto-finishing with pages captured so far. Default 600 (10 min). 0 = wait
   * indefinitely. Only relevant for source "flatbed" with max_pages > 1.
   */
  page_swap_timeout?: number;
  /** Manual filter chain. Mutually exclusive with `preset`. */
  filters?: FilterSpec[];
  /** Named preset (see listPresets()). Mutually exclusive with `filters`. */
  preset?: string;
}

/** Normalized form of each WebSocket progress frame. */
export interface ScanJobEvent {
  status: JobStatus;
  pageCount: number;
  maxPages: number;
  error: string | null;
}

export const CONTENT_TYPE_BY_FORMAT: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
