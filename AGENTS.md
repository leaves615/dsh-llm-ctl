# dsh-llm-ctl — agent guide

DSH plugin: per-provider admission queue + cooldown on `llm/stream`, bounded recovery on `agent/request-error`, model visibility switches in `settings.models` seats, DOM filtering of the model menu.

## Commands

- `npm run typecheck` — fastest signal, run first.
- `npm run build` — `tsc` host + `esbuild` client bundle (`scripts/build-client.mjs`).
- `npm test` — `node --test test/*.test.ts` (jsdom for DOM modules).
- `npm run verify` — typecheck + build + test + `./scripts/smoke-boot.sh`. Ship only when green.

## Map

- `src/index.ts` — host entry: `llm/stream` gate, `agent/request-error` recovery, route mounting. Start here for queue/retry work.
- `src/queue.ts` + `src/delay.ts` + `src/reactive.ts` — gate, Retry-After/backoff, waitable-code set.
- `src/visibility*.ts` + `src/settings-ui.ts` — settings section `llm-ctl` adapter, visibility rules, provider-card/footer views, and the `settings.plugin.item` card (`PluginConfigCard`) owning the global queue budget in 设置 → 插件 → 插件配置.
- `src/menu-filter.ts` + `src/menu-visibility.ts` — model-menu DOM filter (only DOM-hack zone; keep selectors here).
- `src/queue-dock.ts` — `conversation.composer.dock` seat views (pure; same tokens as `settings-ui.ts`).
- `src/client-plugin.ts` — browser half: dock queue seat, menu sync, slot seats, HTTP polling.
- `src/routes.ts` + `src/discover*.ts` — `webServer` plain-HTTP channel, upstream discovery.
- `cordis.patch.yml` — host insert row (`id: llm-ctl`); browser half travels via `package.json#dsh.client` + `exports["./client"]`.
- `PRD.md` — behavior contract; `README.md` — seams table + config sample; `notes/dsh-extension-points.md` — seam catalog with sources.

Read the pointer target when the branch matches:

- queue/retry semantics change → `PRD.md` (FIFO, single `maxWaitMs`, `reactiveRetry` modes).
- settings/menu/discovery UI change → `README.md` behavior notes + `notes/dsh-extension-points.md` §3/§5.
- new host waterfall or slot seat → `notes/dsh-extension-points.md` §2–§4 (official vs DOM-hack).

## Rules

- Waterfall order: `llm/stream` gates first; `agent/request-error` records cooldown, awaits `next()`, then spends its own budget only when downstream yields nothing.
- Touch `llm/stream` payloads read-only; short-circuit with a `finish/error` chunk, never mutate options.
- Write settings via `mutate` + `expectedRevision` on section `llm-ctl`; retry on `SETTINGS_CONFLICT`.
- **Only ever write section `llm-ctl`.** Never mutate another plugin's namespace (`llm-pi-ai`, adapter sections, …) — no `describe()` snapshot of a foreign section may be written back, and no cross-ns `expectedRevision`. Read foreign sections is fine; writing them is out of scope permanently (decision 2026-09-22, see `notes/reasoning-effort-gap.md`).
- Treat `webServer` and `llm` as optional: `inject` with fallback, `ctx.get` inside try/catch, headless stays loadable.
- Register `settings.models.provider-card` once per `settingsNs`; resolve the row provider from owner props at render, not from the registration closure.
- Keep client bundle pure: relative imports inline, `react`/`cordis`/slots packages external; assert `apply` shape in `scripts/build-client.mjs`.
- Keep menu selectors, `MutationObserver` dedup, and `stopPropagation` inside `menu-filter.ts` / `client-plugin.ts` menu sync; hide-only when `dsh-model-search-plugin` owns the search box.
- Prefix HTTP paths with `/api/llm-ctl/`; poll state at 1s, catalog at 30s TTL.
