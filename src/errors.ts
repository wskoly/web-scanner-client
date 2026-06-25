/**
 * Thrown for any non-2xx response from the agent. Carries the HTTP status and
 * the parsed `detail` (FastAPI puts validation/conflict messages there - e.g.
 * the 422 "Specify either 'preset' or 'filters', not both" or the 409
 * "Job not awaiting a page").
 */
export class ScannerError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown, message?: string) {
    super(message ?? ScannerError.describe(status, detail));
    this.name = "ScannerError";
    this.status = status;
    this.detail = detail;
  }

  private static describe(status: number, detail: unknown): string {
    if (typeof detail === "string") return `${status}: ${detail}`;
    if (detail && typeof detail === "object") {
      try {
        return `${status}: ${JSON.stringify(detail)}`;
      } catch {
        /* fall through */
      }
    }
    return `Request failed with status ${status}`;
  }
}
