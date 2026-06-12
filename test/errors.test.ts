import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APIError,
  AuthenticationError,
  InvalidRequestError,
  MaintenanceError,
  QuotaExceededError,
  RateLimitError,
  Snipget,
  SnipgetError,
} from "../src/index";
import { errorEnvelope, fakeResponse, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** maxRetries: 0 everywhere — these tests assert mapping, not retry policy. */
function client(): Snipget {
  return new Snipget({ apiKey: "sk_test", maxRetries: 0 });
}

async function callAndCatch(status: number, body: unknown, headers?: Record<string, string>) {
  stubFetch(fakeResponse(status, body, headers));
  return client()
    .call("/healthcare/npi/validate", { npi: "1234567893" })
    .catch((e: unknown) => e as SnipgetError);
}

describe("error mapping", () => {
  it("maps 401 MISSING_API_KEY to AuthenticationError with envelope fields", async () => {
    const err = await callAndCatch(401, errorEnvelope("MISSING_API_KEY", "API key required."));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toMatchObject({
      errorCode: "MISSING_API_KEY",
      message: "API key required.",
      httpStatus: 401,
      requestId: "req_ERR123",
    });
  });

  it("maps 401 INVALID_API_KEY to AuthenticationError", async () => {
    const err = await callAndCatch(401, errorEnvelope("INVALID_API_KEY", "Unknown API key."));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).errorCode).toBe("INVALID_API_KEY");
  });

  it("maps 403 IP_NOT_ALLOWED to AuthenticationError", async () => {
    const err = await callAndCatch(403, errorEnvelope("IP_NOT_ALLOWED", "IP not in allowlist."));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).httpStatus).toBe(403);
  });

  it("maps 400 INVALID_INPUT to InvalidRequestError", async () => {
    const err = await callAndCatch(400, errorEnvelope("INVALID_INPUT", "Bad input."));
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect((err as InvalidRequestError).errorCode).toBe("INVALID_INPUT");
  });

  it("maps 422 INVALID_REQUEST to InvalidRequestError carrying details", async () => {
    const details = [{ loc: ["body", "npi"], msg: "Field required", type: "missing" }];
    const err = await callAndCatch(
      422,
      errorEnvelope("INVALID_REQUEST", "Request validation failed.", { details }),
    );
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect((err as InvalidRequestError).details).toEqual(details);
  });

  it("maps 429 RATE_LIMITED to RateLimitError with retryAfter from the header", async () => {
    const err = await callAndCatch(
      429,
      errorEnvelope("RATE_LIMITED", "Too many requests.", {
        retry_after_seconds: 0.42,
        limit_type: "sustained_rps",
        limit_value: 25,
        current_tier: "starter",
      }),
      { "Retry-After": "1" },
    );
    expect(err).toBeInstanceOf(RateLimitError);
    // Header wins over the body's retry_after_seconds.
    expect((err as RateLimitError).retryAfter).toBe(1);
    expect((err as RateLimitError).httpStatus).toBe(429);
  });

  it("falls back to the body's retry_after_seconds when the header is absent", async () => {
    const err = await callAndCatch(
      429,
      errorEnvelope("RATE_LIMITED", "Too many requests.", { retry_after_seconds: 0.42 }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(0.42);
  });

  it("maps 429 QUOTA_EXCEEDED to QuotaExceededError with creditRemainingUsd from meta", async () => {
    const err = await callAndCatch(
      429,
      errorEnvelope(
        "QUOTA_EXCEEDED",
        "Your overage allowance is used up.",
        { limit_type: "overage_balance_exhausted", limit_value: 25000, current_tier: "starter" },
        { credit_remaining_usd: 0.0, quota_remaining: 0 },
      ),
    );
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect((err as QuotaExceededError).creditRemainingUsd).toBe(0.0);
    expect((err as QuotaExceededError).errorCode).toBe("QUOTA_EXCEEDED");
  });

  it("leaves creditRemainingUsd undefined when meta does not report it", async () => {
    const err = await callAndCatch(
      429,
      errorEnvelope("QUOTA_EXCEEDED", "Monthly call quota exceeded.", {
        limit_type: "monthly_quota",
      }),
    );
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).creditRemainingUsd).toBeUndefined();
  });

  it("maps 503 MAINTENANCE_MODE to MaintenanceError with retryAfter", async () => {
    const err = await callAndCatch(
      503,
      errorEnvelope("MAINTENANCE_MODE", "Down for maintenance.", { retry_after_seconds: 300 }),
      { "Retry-After": "300" },
    );
    expect(err).toBeInstanceOf(MaintenanceError);
    expect((err as MaintenanceError).retryAfter).toBe(300);
    expect((err as MaintenanceError).httpStatus).toBe(503);
  });

  it("maps a 503 that is NOT maintenance (e.g. UPSTREAM_UNAVAILABLE) to APIError", async () => {
    const err = await callAndCatch(
      503,
      errorEnvelope("UPSTREAM_UNAVAILABLE", "Currency rate feed unreachable."),
    );
    expect(err).toBeInstanceOf(APIError);
    expect(err).not.toBeInstanceOf(MaintenanceError);
  });

  it("maps 500 INTERNAL_ERROR to APIError", async () => {
    const err = await callAndCatch(500, errorEnvelope("INTERNAL_ERROR", "An internal error occurred."));
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).errorCode).toBe("INTERNAL_ERROR");
  });

  it("every mapped error is an instanceof SnipgetError and Error", async () => {
    const err = await callAndCatch(404, errorEnvelope("NOT_FOUND", "No such resource."));
    expect(err).toBeInstanceOf(SnipgetError);
    expect(err).toBeInstanceOf(Error);
    expect((err as SnipgetError).name).toBe("APIError");
  });
});
