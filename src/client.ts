import {
  APIError,
  AuthenticationError,
  MaintenanceError,
  QuotaExceededError,
  RateLimitError,
  SnipgetError,
  errorFromResponse,
} from "./errors";
import type { CallOptions, SnipgetMeta, SnipgetOptions, SnipgetResponse } from "./types";

const DEFAULT_BASE_URL = "https://api.snipget.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * `Retry-After` values above this (in seconds) are not honored as a sleep —
 * e.g. maintenance windows advertise 300s, which is longer than any sane
 * in-process wait. The retry falls back to plain exponential backoff.
 */
const MAX_HONORED_RETRY_AFTER_S = 60;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

/**
 * Thin HTTP client for the Snipget API (https://api.snipget.ai).
 *
 * Zero runtime dependencies — uses the global `fetch` (Node >= 18, browsers,
 * and modern edge runtimes). All business logic lives server-side; this
 * client only handles auth, the response envelope, errors, and retries.
 */
export class Snipget {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly #apiKey: string;

  constructor(options: SnipgetOptions = {}) {
    const apiKey = options.apiKey ?? envApiKey();
    if (!apiKey) {
      throw new AuthenticationError(
        "No API key provided. Pass `apiKey` to the Snipget constructor or set the " +
          "SNIPGET_API_KEY environment variable. Get a key at https://snipget.ai.",
        { errorCode: "MISSING_API_KEY" },
      );
    }
    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Call any Snipget utility endpoint and unwrap its response envelope.
   *
   * The endpoint catalog is the OpenAPI spec (https://api.snipget.ai/openapi.json);
   * `path` is any path from it, e.g. `"/healthcare/npi/validate"`. Defaults to
   * `POST` when `payload` is given and `GET` otherwise — utility endpoints are
   * predominantly POST (128 of the 133 paths in the spec).
   *
   * @param path - Endpoint path, with or without a leading slash.
   * @param payload - JSON request body, per the endpoint's OpenAPI schema.
   * @param opts - Per-call options (e.g. an explicit `method`).
   * @returns The unwrapped envelope: `result`, `confidence`, `meta`, and `raw`.
   * @throws {SnipgetError} A typed subclass mapped from the error envelope, or
   *   a base `SnipgetError` (`TIMEOUT` / `NETWORK_ERROR`) for transport failures.
   */
  async call<T = unknown>(
    path: string,
    payload?: object,
    opts: CallOptions = {},
  ): Promise<SnipgetResponse<T>> {
    const method = (opts.method ?? (payload === undefined ? "GET" : "POST")).toUpperCase();
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#request(url, method, payload);
      } catch (cause) {
        // Transport-level failure (DNS, connection reset, timeout). Snipget
        // utility calls are pure and idempotent — they compute over the
        // payload and write nothing — so retrying a POST is safe.
        if (attempt < this.maxRetries) {
          await sleep(retryDelayMs(attempt, undefined));
          continue;
        }
        throw transportError(cause, this.timeoutMs);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (response.ok) {
        return unwrapEnvelope<T>(response.status, body);
      }

      const error = errorFromResponse(response.status, body, response.headers.get("Retry-After"));
      if (attempt < this.maxRetries && isRetryable(error)) {
        await sleep(retryDelayMs(attempt, retryAfterOf(error)));
        continue;
      }
      throw error;
    }
  }

  /** Perform one HTTP attempt with a per-attempt timeout via AbortController. */
  async #request(url: string, method: string, payload: object | undefined): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      };
      let body: string | undefined;
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(payload);
      }
      return await fetch(url, { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read the API key from `SNIPGET_API_KEY`, guarded so runtimes without
 * `process` (browsers, some edge workers) don't crash on access.
 */
function envApiKey(): string | undefined {
  if (typeof process === "undefined" || typeof process.env !== "object") return undefined;
  return process.env.SNIPGET_API_KEY || undefined;
}

function unwrapEnvelope<T>(httpStatus: number, body: unknown): SnipgetResponse<T> {
  if (typeof body === "object" && body !== null) {
    const env = body as Record<string, unknown>;
    if (env.status === "ok") {
      return {
        result: env.result as T,
        confidence: env.confidence as number,
        meta: (typeof env.meta === "object" && env.meta !== null ? env.meta : {}) as SnipgetMeta,
        raw: body,
      };
    }
    if (env.status === "error") {
      // A 2xx with an error envelope shouldn't happen; map it honestly anyway.
      throw errorFromResponse(httpStatus, body, null);
    }
  }
  throw new APIError("Snipget API returned an unexpected response body.", { httpStatus });
}

/**
 * Retry policy:
 *   - `RATE_LIMITED` 429 — yes: a per-second throttle lifts within seconds.
 *   - `QUOTA_EXCEEDED` 429 — never: monthly capacity; retrying cannot succeed.
 *   - 5xx (including maintenance) — yes: transient by definition. Note that
 *     maintenance windows usually outlast the in-process retry budget, so
 *     callers should still expect to catch `MaintenanceError`.
 *   - Other 4xx — never: the request itself is wrong.
 */
function isRetryable(error: SnipgetError): boolean {
  if (error instanceof QuotaExceededError) return false;
  if (error instanceof RateLimitError) return true;
  return error.httpStatus !== undefined && error.httpStatus >= 500;
}

function retryAfterOf(error: SnipgetError): number | undefined {
  if (error instanceof RateLimitError || error instanceof MaintenanceError) {
    return error.retryAfter;
  }
  return undefined;
}

/**
 * Honor a sane `Retry-After` exactly; otherwise exponential backoff with
 * +/-25% jitter so synchronized clients don't stampede the API.
 */
function retryDelayMs(attempt: number, retryAfterSeconds: number | undefined): number {
  if (
    retryAfterSeconds !== undefined &&
    retryAfterSeconds > 0 &&
    retryAfterSeconds <= MAX_HONORED_RETRY_AFTER_S
  ) {
    return retryAfterSeconds * 1000;
  }
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return base * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportError(cause: unknown, timeoutMs: number): SnipgetError {
  const name = typeof cause === "object" && cause !== null ? (cause as { name?: unknown }).name : undefined;
  if (name === "AbortError" || name === "TimeoutError") {
    return new SnipgetError(`Snipget API request timed out after ${timeoutMs}ms.`, {
      errorCode: "TIMEOUT",
      cause,
    });
  }
  return new SnipgetError("Network error while calling the Snipget API.", {
    errorCode: "NETWORK_ERROR",
    cause,
  });
}
