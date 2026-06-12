import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APIError,
  InvalidRequestError,
  QuotaExceededError,
  Snipget,
} from "../src/index";
import { errorEnvelope, fakeResponse, npiValidateEnvelope, stubFetch } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const PATH = "/healthcare/npi/validate";
const PAYLOAD = { npi: "1234567893" };

describe("retry policy", () => {
  it("retries 429 RATE_LIMITED and honors Retry-After exactly", async () => {
    const mock = stubFetch(
      fakeResponse(429, errorEnvelope("RATE_LIMITED", "Too many requests."), {
        "Retry-After": "1",
      }),
      fakeResponse(200, npiValidateEnvelope()),
    );
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 2 });

    const promise = client.call(PATH, PAYLOAD);
    await vi.advanceTimersByTimeAsync(0); // flush the first attempt
    expect(mock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999); // 1ms short of Retry-After
    expect(mock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // exactly 1000ms — retry fires
    expect(mock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toMatchObject({ confidence: 1.0 });
  });

  it("never retries 429 QUOTA_EXCEEDED — monthly quota cannot recover in-process", async () => {
    const mock = stubFetch(
      fakeResponse(
        429,
        errorEnvelope("QUOTA_EXCEEDED", "Included calls used up.", {
          limit_type: "included_exhausted",
        }),
      ),
    );
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 2 });

    const promise = client.call(PATH, PAYLOAD);
    const assertion = expect(promise).rejects.toBeInstanceOf(QuotaExceededError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("never retries a plain 4xx", async () => {
    const mock = stubFetch(fakeResponse(400, errorEnvelope("INVALID_INPUT", "Bad input.")));
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 2 });

    const promise = client.call(PATH, PAYLOAD);
    const assertion = expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with backoff up to maxRetries, then throws APIError", async () => {
    const mock = stubFetch(
      fakeResponse(500, errorEnvelope("INTERNAL_ERROR", "Boom.")),
      fakeResponse(500, errorEnvelope("INTERNAL_ERROR", "Boom.")),
      fakeResponse(500, errorEnvelope("INTERNAL_ERROR", "Boom.")),
    );
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 2 });

    const promise = client.call(PATH, PAYLOAD);
    const assertion = expect(promise).rejects.toBeInstanceOf(APIError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it("retries network errors and succeeds when the connection recovers", async () => {
    const mock = stubFetch(
      new TypeError("fetch failed"),
      fakeResponse(200, npiValidateEnvelope()),
    );
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 2 });

    const promise = client.call(PATH, PAYLOAD);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      result: { is_valid: true },
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("maxRetries: 0 disables retries entirely", async () => {
    const mock = stubFetch(
      fakeResponse(429, errorEnvelope("RATE_LIMITED", "Too many requests."), {
        "Retry-After": "1",
      }),
    );
    const client = new Snipget({ apiKey: "sk_test", maxRetries: 0 });

    const promise = client.call(PATH, PAYLOAD);
    const assertion = expect(promise).rejects.toMatchObject({ errorCode: "RATE_LIMITED" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
