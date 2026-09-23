# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest `main`) | ✅ |
| < 0.1.0 | ❌ (pre-release, upgrade) |

## Report a vulnerability

**Do not open a public issue for a suspected vulnerability.**
Email `leaves615@gmail.com` with:

- plugin version and DSH version,
- what you did, what you expected, what happened,
- host log excerpt (`llm-ctl:` lines) with secrets redacted.

I will acknowledge within 72 hours, fix on `main`, and credit you in the
release notes unless you prefer otherwise.

## What this plugin does with secrets

- **It never asks for your keys.** Provider credentials live in DSH's own
  settings store; the plugin reads them server-side through `ctx.llm` and
  never handles them directly.
- **The browser channel carries no secrets.** `POST /api/llm-ctl/discover`
  accepts only `{ provider, baseURL?, api? }` and returns HTTP 400 when the
  body contains `apiKey`. Upstream discovery reuses the stored credential
  on the host.
- **Logs are secret-free by construction.** Host log lines (`llm-ctl:` prefix)
  record provider ids, failure codes, delays, and counts — never request
  bodies, headers, or credentials.

## Scope notes for auditors

- All browser traffic stays under `/api/llm-ctl/*` on the local `webServer`;
  every POST body is bounded (4 KiB) and type-checked before use.
- The plugin writes **only** its own settings section (`llm-ctl`, user layer).
  It never mutates another plugin's namespace (`llm-pi-ai`, adapter sections).
- The model-menu filter is DOM-based (`display:none` on menu rows, selectors
  confined to `src/menu-filter.ts`); it cannot read page content outside the
  model picker and performs no network I/O of its own.
