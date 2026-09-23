# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.1.0] — 2026-09-23

First public release: rate-limit admission queue + model visibility for DSH
web profiles. Tested against `@deepseek-ai/dsh-llm 0.1.2-rc.1`.

### Added

- Per-provider admission queue on `llm/stream` (global prepend): FIFO,
  per-provider concurrency, single `maxWaitMs` budget, `QUEUE_FULL` /
  `QUEUE_TIMEOUT` refusals, per-request cancel, queue pill + dialog in
  `conversation.composer.dock`.
- Reactive provider cooldown on terminal failures (`RATE_LIMIT / SERVER /
  TIMEOUT / TRANSPORT / EMPTY_RESPONSE`): honors `providerRetryAfterMs`,
  falls back to local exponential backoff; `AUTH / QUOTA` and friends pass
  through untouched.
- Standalone recovery on `agent/request-error`: records cooldown, yields to
  `dsh-llm-retry` when it handles the error, otherwise spends a bounded own
  budget (`reactiveRetry: auto`, cap 3).
- Model visibility: provider/model two-level switches persisted to the
  `llm-ctl` settings section, `hiddenPatterns` presets, settings-page cards
  + footer, model-menu DOM filter with own search box (`p:` prefix), empty
  state with one-click restore, default-model fallback.
- Upstream model discovery (`POST /api/llm-ctl/discover`): adapter discovery
  first (stored credential, server-side), public Zen feed fallback for
  zen-family providers. **Secrets never cross the browser channel** — an
  `apiKey` in the request body is rejected with HTTP 400.
- Coexistence with `dsh-model-search-plugin`: DOM probing per menu open;
  hide-only mode when its search box owns the menu.

### Known limitations (upstream seams needed)

- Hidden models still leave the host (`session.modelCatalog` has no waterfall
  seam); filtering happens browser-side.
- No custom session log events (`Session.append()` cannot mark third-party
  event types `ignorable`); observability is host logs + in-memory ring
  exposed over `llmCtl` Remote / `/api/llm-ctl/state`.
