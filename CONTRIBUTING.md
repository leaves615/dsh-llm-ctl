# Contributing to @leaves615/dsh-llm-ctl

Thanks for stopping by. This is a DSH (DeepSeek Harness) plugin, so a few
things work differently from a plain npm library — read this first and you
will save yourself a round-trip.

## Prerequisites

- Node.js >= 22 (CI runs 22.x and 24.x).
- A working DSH checkout for the `smoke-boot` step: `scripts/smoke-boot.sh`
  defaults to `~/.dsh/profiles/web` as the source profile. Without it,
  `npm run verify` stops after `npm test` — that is expected, say so in
  your PR.
- `npm install` before anything else.

## Commands

| Command | What it does | When to run it |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`, fastest signal | First, always |
| `npm run build` | host `tsc` + browser bundle via `scripts/build-client.mjs` | After touching `src/` |
| `npm test` | `node --test test/*.test.ts` (runs TS directly, no build needed) | After touching `src/` or `test/` |
| `npm run verify` | typecheck + build + test + real-loader `smoke-boot.sh` | Before opening a PR, must be green |

## Where things live

`AGENTS.md` (repo root) is the source of truth for the module map and the
hard rules. The short version:

- `src/index.ts` — host entry: `llm/stream` gate + `agent/request-error` recovery.
- `src/queue.ts` / `delay.ts` / `reactive.ts` — gate, Retry-After/backoff, waitable codes.
- `src/visibility*.ts` / `settings-ui.ts` — settings section `llm-ctl`, visibility rules, settings views.
- `src/menu-filter.ts` / `menu-visibility.ts` — **the only DOM-hack zone**; keep every menu selector here.
- `src/client-plugin.ts` — browser half (polls `/api/llm-ctl/*`, no `ctx.remote` — third-party Typert namespaces are unreachable from the browser).
- `src/routes.ts` / `discover*.ts` — plain-HTTP channel on the optional `webServer` service.
- `PRD.md` — behavior contract (FIFO, single `maxWaitMs`, `reactiveRetry` modes). Change behavior → update PRD in the same PR.
- `notes/dsh-extension-points.md` — seam catalog with sources. New host waterfall or slot seat → check here first (official vs DOM-hack).

## Ground rules (enforced in review)

1. **Only ever write settings section `llm-ctl`.** Reading foreign sections is fine; writing `llm-pi-ai`, adapter sections, or anything outside `llm-ctl` is out of scope — permanently (decision 2026-09-22, see `notes/reasoning-effort-gap.md`).
2. **`llm/stream` payloads are read-only.** Refuse admission with a `finish/error` chunk; never mutate options.
3. **Waterfall order matters:** `llm/stream` gates first; `agent/request-error` records cooldown, awaits `next()`, then spends its own budget only when downstream yields nothing.
4. **HTTP paths stay under `/api/llm-ctl/`.** State polls at 1s, catalog at 30s TTL.
5. **Secrets never cross the browser channel.** `/api/llm-ctl/discover` rejects `apiKey` in the body; discovery reuses the stored credential server-side.
6. **Keep the client bundle pure:** relative imports inline, `react`/`cordis`/slots packages external; `scripts/build-client.mjs` asserts the `apply` shape.
7. **Tests run TS source directly** (Node type stripping), so the host half avoids decorator syntax — Typert `Remote` wiring is programmatic in `src/controller.ts`.

## Opening a PR

- `npm run verify` green (or state which leg is missing and why).
- Behavior change → PRD updated in the same PR.
- New menu selector → lives in `menu-filter.ts`, with a `menu-visibility.test.ts` / `client-plugin.test.ts` case pinning it.
- Keep the diff focused; one concern per PR.

## Reporting bugs

Open an issue with: DSH version (`@deepseek-ai/dsh-llm` version), plugin version,
profile (`web`? headless?), and the host log lines starting with `llm-ctl:`.
For hangs, include the `/api/llm-ctl/state` snapshot. **Never paste API keys,
tokens, or full `settings.yaml` contents** — redact secrets first (see
`SECURITY.md`).
