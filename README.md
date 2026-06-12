# snipget

Official JavaScript/TypeScript client for the [Snipget API](https://snipget.ai) — data normalization, parsing, validation, and classification utilities for AI agents and developers.

## What is Snipget?

Snipget is a hosted utility API built for AI agents and the developers who build them. It serves 130+ programmatic endpoints for the unglamorous data work that agents do constantly: validating identifiers (NPI, DEA, IBAN, VIN, Luhn), parsing and cleaning names, standardizing addresses and phone numbers, normalizing timezones and currencies, classifying nulls and emails, slugifying text, and much more — with particular depth in healthcare (NPI validation and lookup, taxonomy codes, credential parsing, DEA numbers). Every endpoint is deterministic, fast, and returns a consistent response envelope with a confidence score.

Snipget is OpenAPI-first: the [interactive docs](https://api.snipget.ai/docs) and [OpenAPI spec](https://api.snipget.ai/openapi.json) are the authoritative catalog of every endpoint, payload, and example. An MCP server is also available, so agents can discover and call Snipget utilities as tools. This package is a thin HTTP wrapper around the hosted API — zero runtime dependencies, zero client-side business logic. The API is the product; the SDK just makes calling it pleasant.

## Install

```sh
npm install snipget
```

Requires Node.js >= 18 (uses the global `fetch`). Also works in modern edge runtimes (Cloudflare Workers, Vercel Edge, Deno) — anywhere `fetch` and `AbortController` exist.

## Quickstart

You'll need an API key from [snipget.ai](https://snipget.ai).

```js
// ESM / TypeScript
import { Snipget } from "snipget";

const client = new Snipget({ apiKey: process.env.SNIPGET_API_KEY });

const res = await client.call("/healthcare/npi/validate", { npi: "1234567893" });

console.log(res.result);
// { npi: 1234567893, is_valid: true, checksum_valid: true, input_was_clean: true }
console.log(res.confidence);        // 1.0
console.log(res.meta.cost_units);   // 1
console.log(res.meta.request_id);   // "req_..."
```

```js
// CommonJS
const { Snipget } = require("snipget");

const client = new Snipget(); // reads SNIPGET_API_KEY from the environment

client.call("/common/phone/validate", { value: "(212) 555-0142", country_hint: "US" })
  .then((res) => console.log(res.result));
```

`client.call(path, payload?, opts?)` is the single entry point for **every** utility endpoint — there are no per-endpoint methods. The [OpenAPI spec](https://api.snipget.ai/openapi.json) is the per-endpoint contract: find the path and request schema there, then pass them straight through. A few more examples:

```js
// Batch endpoints live alongside every single-record endpoint
await client.call("/healthcare/npi/validate/batch", {
  items: ["1234567893", "1234567894"],
});

// Tiny utilities are first-class too
await client.call("/tiny/slug/slugify", { text: "Hello, World!" });

// The handful of GET endpoints need no payload
await client.call("/pricing/tiers");
```

Defaults: `POST` when a payload is given, `GET` otherwise (utility endpoints are predominantly POST). Override with `opts.method` if you ever need to.

## Authentication

Get an API key at [snipget.ai](https://snipget.ai). The client sends it as `Authorization: Bearer <key>` (the API also accepts `X-API-Key`). Provide it either way:

```js
new Snipget({ apiKey: "sk_..." });      // explicit
new Snipget();                          // falls back to SNIPGET_API_KEY env var
```

Construction throws immediately if no key is found, so misconfiguration fails fast.

## Error handling

Every error thrown by the client is a typed subclass of `SnipgetError`, each carrying `errorCode`, `message`, `requestId`, and `httpStatus`:

| Class | When | Extra fields |
| --- | --- | --- |
| `AuthenticationError` | 401/403 — missing/invalid key, IP not allowed | |
| `InvalidRequestError` | 400/422 — bad input or failed validation | `details` (field-level errors on 422) |
| `RateLimitError` | 429 `RATE_LIMITED` — per-second throttle | `retryAfter` (seconds) |
| `QuotaExceededError` | 429 `QUOTA_EXCEEDED` — monthly quota/allowance exhausted | `creditRemainingUsd` (when reported) |
| `MaintenanceError` | 503 `MAINTENANCE_MODE` — maintenance window | `retryAfter` (seconds, typically 300) |
| `APIError` | other 5xx / unexpected responses | |
| `SnipgetError` (base) | also thrown directly for transport failures (`errorCode` `"TIMEOUT"` or `"NETWORK_ERROR"`) | |

```js
import {
  Snipget,
  SnipgetError,
  RateLimitError,
  QuotaExceededError,
  InvalidRequestError,
} from "snipget";

try {
  const res = await client.call("/healthcare/npi/validate", { npi: "not-an-npi" });
} catch (err) {
  if (err instanceof QuotaExceededError) {
    // Monthly capacity is gone — retrying won't help. Upgrade or top up.
    console.error("Out of quota.", err.creditRemainingUsd);
  } else if (err instanceof RateLimitError) {
    // Already retried automatically; you're sending faster than your tier allows.
    console.error(`Throttled — retry in ${err.retryAfter}s`);
  } else if (err instanceof InvalidRequestError) {
    console.error("Bad request:", err.message, err.details);
  } else if (err instanceof SnipgetError) {
    console.error(`Snipget error ${err.errorCode} (request ${err.requestId})`);
  } else {
    throw err;
  }
}
```

## Retries and timeouts

The client automatically retries **network errors**, **429 `RATE_LIMITED`** (honoring `Retry-After`), and **5xx** responses, with exponential backoff and jitter. It never retries `QUOTA_EXCEEDED` or other 4xx errors — those cannot succeed by retrying. Snipget utility calls are pure and idempotent (they compute over the payload and write nothing), so retrying POSTs is safe.

```js
const client = new Snipget({
  apiKey: "sk_...",
  baseUrl: "https://api.snipget.ai", // default
  timeoutMs: 30_000,                 // per-attempt timeout (AbortController)
  maxRetries: 2,                     // retries after the first attempt; 0 disables
});
```

A `MaintenanceError` advertises `Retry-After: 300`; maintenance windows usually outlast the in-process retry budget, so catch it and reschedule rather than spin.

## The response envelope

Every Snipget endpoint returns the same JSON envelope. `client.call()` unwraps it for you:

| Field on `SnipgetResponse` | From the wire | Meaning |
| --- | --- | --- |
| `result` | `result` | The utility's payload (type it with the generic: `call<T>`) |
| `confidence` | `confidence` | Score in `[0, 1]`; always `1.0` at the top level of batch responses |
| `meta` | `meta` | Metadata, wire field names preserved (see below) |
| `raw` | — | The full untouched envelope, if you ever need it |

`meta` keeps the API's snake_case names verbatim:

| `meta` field | Meaning |
| --- | --- |
| `version` | API version |
| `elapsed_ms` | Server-side processing time |
| `cost_units` | Billable cost of the call (batch = 1 unit per item) |
| `request_id` | Unique `req_...` id — quote it in support requests |
| `rate_limit_remaining` / `rate_limit_reset` | Per-second throttle headroom / reset timestamp |
| `quota_remaining` / `quota_reset` | Monthly included-calls headroom / reset timestamp |
| `credit_remaining_usd` | Prepaid overage-allowance balance, once you're burning it |

Error responses use a sibling envelope (`status: "error"`, `error_code`, `message`, `meta`) which the client maps to the typed errors above — you never parse it by hand.

## TypeScript

`call()` is generic over the `result` type. The shapes are documented per-endpoint in the [OpenAPI spec](https://api.snipget.ai/openapi.json):

```ts
import { Snipget, type SnipgetResponse } from "snipget";

interface NpiValidation {
  npi: number | null;
  is_valid: boolean;
  checksum_valid: boolean;
  input_was_clean: boolean;
}

const client = new Snipget();
const res: SnipgetResponse<NpiValidation> = await client.call<NpiValidation>(
  "/healthcare/npi/validate",
  { npi: "1234567893" },
);

res.result.is_valid; // typed boolean
```

## Links

- Website: [snipget.ai](https://snipget.ai)
- Interactive API docs: [api.snipget.ai/docs](https://api.snipget.ai/docs)
- OpenAPI spec: [api.snipget.ai/openapi.json](https://api.snipget.ai/openapi.json)
- Python client: [`snipget-client` on PyPI](https://pypi.org/project/snipget-client/)

## License

MIT © Snipget Inc.
