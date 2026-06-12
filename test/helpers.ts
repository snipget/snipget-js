import { vi, type Mock } from "vitest";

/**
 * Minimal deterministic stand-in for a fetch Response. Only the surface the
 * client touches (`ok`, `status`, `headers.get`, `json`) — a real `Response`
 * consumes its body through the stream machinery, which interacts badly with
 * fake timers.
 */
export function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: () =>
      body === NON_JSON ? Promise.reject(new SyntaxError("Unexpected token")) : Promise.resolve(body),
  } as unknown as Response;
}

/** Sentinel body: makes `fakeResponse(...).json()` reject like a non-JSON body. */
export const NON_JSON = Symbol("non-json-body");

/** Stub global fetch with a queue of responses (or errors to reject with). */
export function stubFetch(...outcomes: Array<Response | Error>): Mock {
  const mock = vi.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) mock.mockRejectedValueOnce(outcome);
    else mock.mockResolvedValueOnce(outcome);
  }
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** A realistic success envelope for POST /healthcare/npi/validate. */
export function npiValidateEnvelope() {
  return {
    status: "ok",
    confidence: 1.0,
    result: { npi: 1234567893, is_valid: true, checksum_valid: true, input_was_clean: true },
    meta: {
      version: "0.1.0",
      elapsed_ms: 2,
      cost_units: 1,
      request_id: "req_01HXAMPLE",
      rate_limit_remaining: 24,
      rate_limit_reset: 1765497600,
    },
  };
}

/** A standard error envelope, with optional top-level extras. */
export function errorEnvelope(
  errorCode: string,
  message: string,
  extras: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return {
    status: "error",
    error_code: errorCode,
    message,
    meta: { version: "0.1.0", cost_units: 0, request_id: "req_ERR123", ...meta },
    ...extras,
  };
}
