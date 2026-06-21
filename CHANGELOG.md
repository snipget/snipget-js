# Changelog

All notable changes to the `snipget` client are documented here. This project
adheres to [Semantic Versioning](https://semver.org).

## 0.1.2

- Docs: add this changelog (now shipped in the package).
- Add `chemistry` and `biotech` keywords for npm discoverability — the catalog
  already covers those verticals.

## 0.1.1

- Add `UpstreamError` (503 `UPSTREAM_UNAVAILABLE`) and `UpstreamRateLimitedError`
  (503 `UPSTREAM_RATE_LIMITED`) to the typed error taxonomy. Both subclass
  `APIError`, so existing `instanceof APIError` handlers keep working;
  `UpstreamRateLimitedError` carries `retryAfter`, which the client honors on
  automatic retry.
- Docs: the README now covers the chemistry and biotech verticals alongside
  healthcare.

## 0.1.0

- Initial release: a thin, zero-dependency HTTP client for the Snipget API with
  a single generic `call()` entry point, a typed error taxonomy, automatic
  retries with exponential backoff and jitter, and dual ESM/CJS builds.
