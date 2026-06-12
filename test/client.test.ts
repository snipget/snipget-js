import { afterEach, describe, expect, it, vi } from "vitest";

import { APIError, AuthenticationError, Snipget, SnipgetError } from "../src/index";
import { NON_JSON, fakeResponse, npiValidateEnvelope, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("envelope unwrapping", () => {
  it("unwraps result, confidence, meta, and raw from the success envelope", async () => {
    const envelope = npiValidateEnvelope();
    stubFetch(fakeResponse(200, envelope));
    const client = new Snipget({ apiKey: "sk_test" });

    const res = await client.call<{ is_valid: boolean }>("/healthcare/npi/validate", {
      npi: "1234567893",
    });

    expect(res.result).toEqual(envelope.result);
    expect(res.result.is_valid).toBe(true);
    expect(res.confidence).toBe(1.0);
    expect(res.raw).toEqual(envelope);
    // meta keeps the wire snake_case field names verbatim.
    expect(res.meta.cost_units).toBe(1);
    expect(res.meta.request_id).toBe("req_01HXAMPLE");
    expect(res.meta.elapsed_ms).toBe(2);
    expect(res.meta.rate_limit_remaining).toBe(24);
  });

  it("throws APIError on a 2xx body that is not a Snipget envelope", async () => {
    stubFetch(fakeResponse(200, { hello: "world" }));
    const client = new Snipget({ apiKey: "sk_test" });

    await expect(client.call("/healthcare/npi/validate", { npi: "x" })).rejects.toBeInstanceOf(
      APIError,
    );
  });
});

describe("request construction", () => {
  it("sends Authorization: Bearer <apiKey>", async () => {
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test_123" });

    await client.call("/healthcare/npi/validate", { npi: "1234567893" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk_test_123");
  });

  it("sends X-API-Key instead when authHeader is 'x-api-key'", async () => {
    // Parity with the Python SDK's auth_header option — for environments
    // whose proxies strip or reserve the Authorization header.
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test_123", authHeader: "x-api-key" });

    await client.call("/healthcare/npi/validate", { npi: "1234567893" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("sk_test_123");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("defaults to POST with a JSON body when a payload is given", async () => {
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test" });

    await client.call("/healthcare/npi/validate", { npi: "1234567893" });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.snipget.ai/healthcare/npi/validate");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ npi: "1234567893" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("defaults to GET when no payload is given", async () => {
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test" });

    await client.call("/health");

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.snipget.ai/health");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("respects an explicit method override", async () => {
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test" });

    await client.call("/pricing/tiers", undefined, { method: "get" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
  });

  it("normalizes baseUrl trailing slashes and missing leading slash on path", async () => {
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));
    const client = new Snipget({ apiKey: "sk_test", baseUrl: "https://example.test/" });

    await client.call("tiny/slug/slugify", { text: "Hello World" });

    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/tiny/slug/slugify");
  });
});

describe("API key resolution", () => {
  it("falls back to the SNIPGET_API_KEY environment variable", async () => {
    vi.stubEnv("SNIPGET_API_KEY", "sk_from_env");
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));

    const client = new Snipget();
    await client.call("/healthcare/npi/validate", { npi: "1234567893" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk_from_env");
  });

  it("prefers an explicit apiKey over the environment variable", async () => {
    vi.stubEnv("SNIPGET_API_KEY", "sk_from_env");
    const mock = stubFetch(fakeResponse(200, npiValidateEnvelope()));

    const client = new Snipget({ apiKey: "sk_explicit" });
    await client.call("/healthcare/npi/validate", { npi: "1234567893" });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk_explicit");
  });

  it("throws AuthenticationError at construction when no key is available", () => {
    vi.stubEnv("SNIPGET_API_KEY", "");

    expect(() => new Snipget()).toThrowError(AuthenticationError);
    try {
      new Snipget();
    } catch (err) {
      expect((err as AuthenticationError).errorCode).toBe("MISSING_API_KEY");
    }
  });
});

describe("timeout", () => {
  it("aborts via AbortController after timeoutMs and throws a TIMEOUT error", async () => {
    vi.useFakeTimers();
    const mock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
          });
        }),
    );
    vi.stubGlobal("fetch", mock);
    const client = new Snipget({ apiKey: "sk_test", timeoutMs: 5_000, maxRetries: 0 });

    const promise = client.call("/healthcare/npi/validate", { npi: "1234567893" });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "SnipgetError",
      errorCode: "TIMEOUT",
    });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe("transport errors", () => {
  it("wraps a final network failure in SnipgetError with NETWORK_ERROR", async () => {
    stubFetch(new TypeError("fetch failed"));
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 0 });

    const err = await client.call("/healthcare/npi/validate", { npi: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(SnipgetError);
    expect(err.errorCode).toBe("NETWORK_ERROR");
    expect(err.httpStatus).toBeUndefined();
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it("throws APIError when an error response has a non-JSON body", async () => {
    stubFetch(fakeResponse(502, NON_JSON));
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 0 });

    const err = await client.call("/healthcare/npi/validate", { npi: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.httpStatus).toBe(502);
    expect(err.errorCode).toBe("HTTP_502");
  });
});
