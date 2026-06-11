# Agent Instructions

## Workspace Overview

Monorepo with two packages:

| Package | Path | Purpose |
|---------|------|---------|
| `pve-client` | `pve-client/` | TypeScript client for Proxmox VE REST API (675 endpoints). Published to npm as `pve-client` and JSR as `@sourceregistry/proxmox` |
| `svelte-playground` | `svelte-playground/playground/` | SvelteKit Proxmox admin dashboard app. Depends on `pve-client` via `file:../../pve-client` |

**Run commands from** `svelte-playground/playground/` for playground changes, `pve-client/` for library changes.

## Architecture

- `pve-client` provides the `Client` class with typed API surface and helpers (Terminal, Display, TimerPulledEventEmitter)
- `svelte-playground` is a SvelteKit app using `@sveltejs/adapter-node` for custom HTTP server + WebSocket support
- WebSocket proxies in `playground/server/` bridge browser ↔ Proxmox terminal/VNC
- Main UI components are `PxMx*` prefixed Svelte files in `playground/src/`

## Validation Gate

Before any commit or PR, all affected packages must pass:

```bash
# pve-client
npm run check
npm run lint
npm run test:unit

# svelte-playground
npm run check
npm run lint
npm run test:unit -- --run
```

Or use `npm run quality:gate` for the full pipeline. See [POLICIES.md](../svelte-playground/POLICIES.md) Priority 3.

## Environment Setup

- `pve-client` must be built (`npm run build`) before running the playground if `pve-client/dist` is missing
- Playground runs on **port 8000 with HTTPS** (mkcert enabled by default)
- Tests use a wrapper script (`scripts/run-vitest.ts`) that redirects `TEMP`/`TMP` to `.vitest/tmp` on Windows
- All environment variables are documented in [PxMx-Admin-For-Datalab-Guide.md](../svelte-playground/playground/PxMx-Admin-For-Datalab-Guide.md#appendix-a-environment-variables)

## Conventions

- Svelte 5 runes mode: `$state()`, `$derived()`, `$effect()`, no `export let`
- Modal actions use optimistic submit (close immediately, show "started", disable while in-flight)
- Fix API gaps in `pve-client` rather than adding consumer-side casts
- All Proxmox-related components prefixed `PxMx`
- Tests: browser components use `.svelte.spec.ts` with Playwright selectors, server tests use `.spec.ts` in Node

## Key Documentation

- [POLICIES.md](../svelte-playground/POLICIES.md) — Authoritative workspace policies and directives
- [Admin Guide](../svelte-playground/playground/PxMx-Admin-For-Datalab-Guide.md) — Proxmox configuration and environment variables
- [LXC VNC Guide](../svelte-playground/playground/LXC-VNC-Configuration-Guide.md) — LXC VNC wiring
