// Wire types mirror the FastAPI agent in web_scanner_sdk/server.py and
// scan_options.py. Kept as string-literal unions (not TS enums) so callers can
// pass plain strings and the values match the Python enums exactly.

export type ColorMode = "color" | "grayscale" | "black_and_white";
export type ScanSource = "flatbed" | "adf" | "adf_duplex";
export type OutputFormat = "png" | "jpeg" | "pdf";

/**
 * Output compression preset - trades file size against fidelity. Independent
 * of the filter `preset` (which changes how the page looks). B&W pages are
 * always stored lossless (CCITT G4) regardless of this setting.
 *
 * Approx. size of one color A4 page at 200 DPI:
 * - "lossless": PNG, pixel-exact (~6 MB) - archival / OCR training
 * - "high":     JPEG 90 (~0.8 MB) - photos, fine print
 * - "balanced": JPEG 80 (~0.5 MB) - everyday documents (agent default)
 * - "small":    JPEG 65 (~0.35 MB) - email / upload limits
 */
export type QualityPreset = "lossless" | "high" | "balanced" | "small";

/** All quality presets, smallest-loss first - handy for building a picker
 * without a round-trip (see listQualityPresets() for the agent's descriptions). */
export const QUALITY_PRESETS: readonly QualityPreset[] = ["lossless", "high", "balanced", "small"];

/** Agent-wide settings (GET/PUT /settings, agent >= 1.3.0). Also editable
 * from the tray menu. */
export interface AgentSettings {
  /**
   * When a scanner is reachable through both TWAIN and WIA, list only its
   * TWAIN source (full duplex/resolution support). Default true.
   */
  prefer_twain: boolean;
}

/** One entry of GET /quality-presets. */
export interface QualityPresetDef {
  description: string;
  /** JPEG quality used for color/gray pages; null = lossless PNG. */
  jpeg_quality: number | null;
  /** Whether color scans with no real color are stored as grayscale. */
  detect_grayscale: boolean;
}

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
  /** Output compression preset. Default (agent-side) "balanced". */
  quality?: QualityPreset;
  /**
   * Drop near-empty pages (e.g. blank backs of a duplex scan) before the
   * result is assembled. Default false. The job's pageCount reports kept pages.
   */
  skip_blank_pages?: boolean;
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
