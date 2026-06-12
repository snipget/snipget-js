/**
 * Public types for the Snipget client.
 *
 * Field names on {@link SnipgetMeta} are the wire names (snake_case) exactly
 * as the API returns them — the client types them but never renames them.
 */

/** Options for constructing a {@link import("./client").Snipget} client. */
export interface SnipgetOptions {
  /**
   * Your Snipget API key. Falls back to the `SNIPGET_API_KEY` environment
   * variable when omitted. Get a key at https://snipget.ai.
   */
  apiKey?: string;
  /** API origin. Default: `https://api.snipget.ai`. */
  baseUrl?: string;
  /** Per-attempt request timeout in milliseconds. Default: `30000`. */
  timeoutMs?: number;
  /**
   * Maximum automatic retries after the first attempt, for network errors,
   * `RATE_LIMITED` 429s, and 5xx responses. Default: `2`. Set `0` to disable.
   */
  maxRetries?: number;
  /**
   * Which header carries the API key: `"authorization"` (default —
   * `Authorization: Bearer <key>`) or `"x-api-key"` for environments whose
   * proxies strip or reserve the Authorization header. Same option as the
   * Python SDK's `auth_header`.
   */
  authHeader?: "authorization" | "x-api-key";
}

/** Per-call options for {@link import("./client").Snipget.call}. */
export interface CallOptions {
  /**
   * HTTP method override. Default: `POST` when a payload is given, `GET`
   * otherwise (utility endpoints are predominantly POST).
   */
  method?: string;
}

/**
 * `meta` object attached to every successful response envelope.
 *
 * Wire field names (snake_case) are preserved verbatim. The API may add
 * fields over time (`additionalProperties: true` in the OpenAPI spec), so
 * unknown keys are allowed.
 */
export interface SnipgetMeta {
  /** API version that produced the response. */
  version?: string;
  /** Server-side processing time in milliseconds. */
  elapsed_ms?: number;
  /** Billable cost of the call (batch calls cost one unit per item). */
  cost_units?: number;
  /** Unique request id (`req_...`) — quote it in support requests. */
  request_id?: string | null;
  /** Reasoning trace, present only when the request set `include_trace`. */
  trace?: string[] | null;
  /** Calls remaining in the current per-second rate window. */
  rate_limit_remaining?: number | null;
  /** Unix timestamp when the rate window resets. */
  rate_limit_reset?: number | null;
  /** Included monthly calls remaining; `null`/absent on unlimited tiers. */
  quota_remaining?: number | null;
  /** Unix timestamp of the next monthly quota reset (start of next UTC month). */
  quota_reset?: number | null;
  /**
   * Live prepaid-allowance balance in USD. Populated once the included
   * bucket is exhausted and calls are burning allowance — the in-band
   * "limit is coming up" signal for agents.
   */
  credit_remaining_usd?: number | null;
  [key: string]: unknown;
}

/** Unwrapped successful response from {@link import("./client").Snipget.call}. */
export interface SnipgetResponse<T = unknown> {
  /** The utility's result payload (the envelope's `result` field). */
  result: T;
  /** Confidence score in [0, 1]. Always `1.0` at the top level of batch responses. */
  confidence: number;
  /** Response metadata (cost, request id, rate-limit/quota headroom). */
  meta: SnipgetMeta;
  /** The full, unmodified envelope as parsed from the wire. */
  raw: unknown;
}
