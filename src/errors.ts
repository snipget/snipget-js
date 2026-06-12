/**
 * Typed error taxonomy for the Snipget API.
 *
 * Every error thrown by this client is a {@link SnipgetError} (or subclass),
 * so `err instanceof SnipgetError` is always a safe catch-all. Each error
 * carries the envelope's `error_code`, the HTTP status, and the
 * `meta.request_id` for support.
 */

/** Common constructor options shared by all Snipget errors. */
export interface SnipgetErrorOptions {
  /** Machine-readable code from the error envelope (e.g. `"INVALID_INPUT"`). */
  errorCode?: string;
  /** `meta.request_id` from the error envelope — quote it in support requests. */
  requestId?: string;
  /** HTTP status of the response, if one was received. */
  httpStatus?: number;
  /** Underlying cause (e.g. the network error thrown by `fetch`). */
  cause?: unknown;
}

/**
 * Base class for all errors thrown by the Snipget client.
 *
 * Also thrown directly for transport-level failures that never produced an
 * HTTP response: `errorCode` is `"TIMEOUT"` or `"NETWORK_ERROR"` and
 * `httpStatus` is `undefined` in that case.
 */
export class SnipgetError extends Error {
  readonly errorCode?: string;
  readonly requestId?: string;
  readonly httpStatus?: number;

  constructor(message: string, options: SnipgetErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
    this.httpStatus = options.httpStatus;
  }
}

/**
 * 401/403 — missing API key, invalid API key, or key not allowed from the
 * caller's IP (`MISSING_API_KEY`, `INVALID_API_KEY`, `IP_NOT_ALLOWED`).
 */
export class AuthenticationError extends SnipgetError {}

/**
 * 400/422 — the request was rejected (`INVALID_INPUT`, `INVALID_REQUEST`).
 * For 422 validation failures, `details` lists the field-level errors.
 */
export class InvalidRequestError extends SnipgetError {
  /** Field-level validation errors (`details` in the error body), when present. */
  readonly details?: unknown[];

  constructor(message: string, options: SnipgetErrorOptions & { details?: unknown[] } = {}) {
    super(message, options);
    this.details = options.details;
  }
}

/**
 * 429 `RATE_LIMITED` — per-second throughput throttle. Retryable within
 * seconds; the client retries it automatically, honoring `Retry-After`.
 */
export class RateLimitError extends SnipgetError {
  /** Seconds to wait before retrying (`Retry-After` header, falling back to the body's `retry_after_seconds`). */
  readonly retryAfter?: number;

  constructor(message: string, options: SnipgetErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/**
 * 429 `QUOTA_EXCEEDED` — monthly included calls or prepaid overage allowance
 * exhausted. NOT retryable: it does not lift until the next UTC month, a tier
 * upgrade, or an allowance purchase. The client never retries it.
 */
export class QuotaExceededError extends SnipgetError {
  /** Remaining prepaid-allowance balance in USD (`meta.credit_remaining_usd`), when reported. */
  readonly creditRemainingUsd?: number;

  constructor(message: string, options: SnipgetErrorOptions & { creditRemainingUsd?: number } = {}) {
    super(message, options);
    this.creditRemainingUsd = options.creditRemainingUsd;
  }
}

/**
 * 503 `MAINTENANCE_MODE` — the API is in an admin-toggled maintenance window.
 * `retryAfter` is typically 300 seconds.
 */
export class MaintenanceError extends SnipgetError {
  /** Seconds until the API suggests retrying (`Retry-After` header). */
  readonly retryAfter?: number;

  constructor(message: string, options: SnipgetErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** Any other 5xx or unexpected response (e.g. `INTERNAL_ERROR`, non-JSON bodies). */
export class APIError extends SnipgetError {}

/**
 * Map an HTTP error response to the matching {@link SnipgetError} subclass.
 *
 * @internal Exported for the client; not part of the public package surface.
 */
export function errorFromResponse(
  httpStatus: number,
  body: unknown,
  retryAfterHeader: string | null,
): SnipgetError {
  const env = asRecord(body);
  const meta = asRecord(env.meta);
  const errorCode = typeof env.error_code === "string" ? env.error_code : `HTTP_${httpStatus}`;
  const message =
    typeof env.message === "string" && env.message.length > 0
      ? env.message
      : `Snipget API request failed with HTTP ${httpStatus}.`;
  const base: SnipgetErrorOptions = {
    errorCode,
    requestId: typeof meta.request_id === "string" ? meta.request_id : undefined,
    httpStatus,
  };

  if (httpStatus === 401 || httpStatus === 403) {
    return new AuthenticationError(message, base);
  }
  if (httpStatus === 400 || httpStatus === 422) {
    return new InvalidRequestError(message, {
      ...base,
      details: Array.isArray(env.details) ? env.details : undefined,
    });
  }
  if (httpStatus === 429) {
    if (errorCode === "QUOTA_EXCEEDED") {
      return new QuotaExceededError(message, {
        ...base,
        creditRemainingUsd:
          typeof meta.credit_remaining_usd === "number" ? meta.credit_remaining_usd : undefined,
      });
    }
    return new RateLimitError(message, {
      ...base,
      retryAfter: parseRetryAfter(retryAfterHeader, env.retry_after_seconds),
    });
  }
  if (httpStatus === 503 && errorCode === "MAINTENANCE_MODE") {
    return new MaintenanceError(message, {
      ...base,
      retryAfter: parseRetryAfter(retryAfterHeader, env.retry_after_seconds),
    });
  }
  return new APIError(message, base);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Resolve the retry delay in seconds: prefer the `Retry-After` HTTP header
 * (always integer seconds per RFC 7231), fall back to the envelope's
 * top-level `retry_after_seconds` field.
 */
function parseRetryAfter(header: string | null, bodyValue: unknown): number | undefined {
  if (header !== null) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (typeof bodyValue === "number" && Number.isFinite(bodyValue) && bodyValue >= 0) {
    return bodyValue;
  }
  return undefined;
}
