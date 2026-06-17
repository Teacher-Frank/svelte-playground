# Directives Playbook

This file is the authoritative policy source for this workspace. Read it at the start of each session.

**Purposes:**
1. **Guide reasoning** — shapes decisions, prevents known mistakes, provides correct patterns without rediscovering them.
2. **Port across sessions, models, and versions** — principles and lessons persist so any future model inherits accumulated experience.
3. **Enable self-verification** — continuously feeds the model a built-in feedback loop, so it tests changes against this file before presenting work as complete.
4. **Settle trade-off conflicts** — explicitly resolves competing best practices into a single authoritative position, so the model doesn't guess which side to take.

Priority directives are numbered in descending order — P1 is highest and most critical.

---

# Workspace-Independent (General Principles)

These rules apply to any project. They guide reasoning, prevent mistakes, and port across tools and teams.

## P1: Single Source of Truth
- `POLICIES.md` is the only authoritative policy file. Do not create duplicates or mirror rules.
- As a general rule, do not store the same knowledge in more than one location.
- On substantive updates, cross-check new rules against existing ones for overlap or contradiction.

## P2: Quality and Refactoring
- Keep code clean, concise, and resilient. Handle errors, edge cases, and unexpected input.
- Extract shared or utility code to dedicated modules — don't let architectural complexity block safe extractions. Prefer `*-utils.ts` files over leaving duplication.
- 2-space indentation for all source files.
- When refactoring oversized files: see _Refactor Approach_ below.
- Document _why_ a decision was made, not only _what_ it does.

## P2a: Test-First Refactoring
- Generate a unit test showing current behavior before changing it. Verify the refactor preserves it.
- If no suitable test target exists (private details), expose the minimum surface to make it testable first.

## P3: Validation Gate
- Before any commit, merge, or PR: all required validation MUST pass. If validation fails, the change MUST NOT ship without an approved exception.
- Validation success: command exits `0`, no unresolved errors, output is clean.

## P4a: Fail Fast
- Prefer early, detectable failures. A compile-time type error beats a runtime `undefined`.
- When a prerequisite is missing, fail with a clear, actionable message — never default to `undefined` or degraded behavior.
- Wired typed APIs beat workaround casts that only fail at runtime. Use canary tests to guarantee surfaces remain exposed.

## P4b: Error Messages
- Wrong/rejected values: always include the actual value in the error message so the caller can identify it.
- Missing/empty errors don't need a value.
- Sensitive values (passwords, tokens, secrets) must never appear in error messages.

## P5: Exceptions Policy
- **Runtime:** prefer specific, local exception handling. Add one general fallback handler at the server entry point as a safety net — never a replacement for specific handling. It must log enough context and return a controlled error response.
- **Process:** keep exceptions minimal, explicit, and temporary. Each entry needs scope, reason, and removal condition. Review monthly.

## P6: Default Decision Policy
- Preserve existing APIs and consumer behavior unless instructed otherwise.
- Prefer small, focused changes over broad refactors.
- Readability and maintainability first; optimize only where measurements justify it.
- Keep UI behavior predictable and explicit over implicit automation.

## P7: Change Acceptance Checklist
A change is done only when:
- Scope fully implemented as requested.
- Updated behavior covered by tests (or existing tests still prove behavior).
- All required validation passes.
- No new diagnostics introduced.
- User-facing behavior changes documented.
- Policy-impacting decisions captured in `POLICIES.md` when durable.

## P8: Review Severity Rubric
- **High:** likely data loss, security risk, broken core flow, or guaranteed runtime failure.
- **Medium:** functional bug, regression risk, or maintainability issue likely to cause near-term defects.
- **Low:** clarity, consistency, minor UX polish, or non-blocking technical debt.

Output format: findings ordered by severity with file refs → open questions → brief change summary.

## P9: Bug Resolve Policy
- Before coding, capture: scope, reproduction steps (environment, observed vs. expected), severity.
- **Sequence:** contain → reproduce with a test (verify it fails) → fix root cause at the correct boundary → same test passes → validate.
- **Closure:** reproducer no longer fails, test shows fail-before/pass-after, no new diagnostics, user-facing changes documented.
- **Hotfix:** minimal containment may ship first, but a follow-up root-cause fix plus regression test must be scheduled and tracked immediately.

## P10: Repository Guardrails
- Never introduce duplicate policy sources.
- Avoid destructive repository operations unless explicitly requested.

## P11: Maintenance
- At the end of meaningful sessions, append or refine directives here when a new durable pattern is confirmed.
- During monthly review, validate each exception — remove or refresh justification.

---

## Refactor Approach
- **Test constraints before building solutions.** Before trying multiple approaches to work within an untested external constraint, write a single minimal repro to confirm whether it's possible.
- Example: before iterating through 3–4 failed approaches to share `vi.hoisted` values across test modules, one quick repro would have confirmed cross-module imports cannot work.
- Framework behavior constraints (mock hoisting, transform ordering) are architectural, not implementation details — discover them at the start of a task.

## PowerShell Text Processing
- **Pattern:** `Get-Content` + index ranges + `Out-File -Encoding UTF8`. Select and export existing lines rather than constructing new arrays.
- Contiguous: `@('header') + $lines[123..479] | Out-File -Encoding UTF8 output.ts`
- Non-contiguous: `($lines[480..821] + $lines[998..1065] + $lines[1166..1209]) | Out-File -Encoding UTF8 output.ts`
- Double-quoted strings: single quotes `'` are literal — no escaping needed.
- Avoid `\x27` in single-quoted strings — it writes literal `\x27` bytes, not `'`.

## Splitting Vitest Test Files with Shared Hoisted Mocks
- Vitest `vi.hoisted` values cannot be exported or imported across modules — the mock factory runs before any imports evaluate.
- **Working pattern:** compile-time include directive. Create `shared-mock-setup.ts` (no imports/exports, bare comments only — no JSDoc/backticks) containing `vi.hoisted` + `vi.mock`. Create a Vite plugin (`include-directive.ts`, `enforce: 'pre'`) that replaces `/// #include ./shared-mock-setup.ts` with the file contents.
- Each split test file uses `/// #include ./shared-mock-setup.ts` as line 1.
- **ESLint:** add `shared-mock-setup.ts` to ignores; add `"no-undef": "off"` for test files using the directive (ESLint runs before Vite transforms).

## Lessons Learned
- Type safety is most effective at library boundaries; consumer-side casts create brittle debt.
- Most regressions come from environment/setup drift, not core logic.
- Reliable Proxmox actions depend on accurate node propagation end-to-end.
- Terminal interoperability benefits from explicit sequence normalization and trace logging.
- Consistent pre-merge validation prevents avoidable late-stage churn.

---

# Workspace-Dependent (This Project)

These rules are specific to this repository's stack, tooling, and domain.

## Workspace Operations
- **Multi-machine:** Fri–Tue primary station, Wed–Thu Surface Pro in Rotterdam.
- Always `git pull` before starting. Re-read `AGENTS.md` and `POLICIES.md`.

## Architecture: pve-client + playground
- **Fix API-surface gaps in `pve-client` first**; avoid consumer-side cast workarounds.
- Avoid `as unknown as Record<...>` and similar double-cast patterns.
- Export and consume named typed APIs (`NodeScopedAPI`, `QemuScopedAPI`, `LxcScopedAPI`).
- If raw endpoint access is needed, use `client.request()` directly with typed path/args. Report so a decision can be made whether a named API is needed.
- Server-side terminal/WebSocket responsibility lives in `pve-client`; playground wiring stays thin.
- ESM TS in `pve-client`: use explicit `.js` extensions for relative imports.

## Proxmox Behavior
- Use real node identity for all actions — never submit fallback values like `unknown`.
- Node-scoped workload lists use typed node APIs.
- Guest action routing:
  - VM → `nodeApi.qemu.vmid(id)`
  - CT → `nodeApi.lxc.id(id)`

## UI Interaction
All modal-based actions (deploy, rename, configure): optimistic, single-shot submit.
- On submit: close modal immediately, show "action started" status, disable duplicate triggers.
- On failure: clear optimistic message, show server error.

## Environment and Tooling
- **Never run `npm run dev` directly.** Start the dev server via `acctest-env.ps1` from `svelte-playground/playground/` — it sets environment variables, builds `pve-client`, and starts the dev server.
- Build `pve-client` before running playground if `dist` is missing.
- Windows test runs: redirect `TEMP`/`TMP` to `.vitest/tmp` if needed to avoid `mkdtemp` failures.
- Playground env vars documented in `svelte-playground/playground/PxMx-Admin-For-Datalab-Guide.md`.

## Runbook
Run commands from `svelte-playground/playground` for app changes, from `pve-client` for library changes.

**Playground** (dev server already running):
- Type/Svelte diagnostics: `npm run check`
- Lint: `npm run lint`
- Tests: `npm run test:unit -- --run`
- Full quality gate: `npm run quality:gate`

**pve-client:**
- Build: `npm run build`
- Type/lint/tests: run package-local `check`, `lint`, `test` scripts

---

## Appendix: Development Stack

### pve-client (Proxmox TypeScript API Client — library)
- **Language:** TypeScript 5.x, ESM (`"type": "module"`, `.js` extensions for relative imports)
- **Build:** `tsc` + Vite with `vite-plugin-dts` — outputs dual ESM + CJS bundles (`dist/index.es.js`, `dist/index.cjs.js`) and `.d.ts` types
- **Target:** Node ≥18 (`target: "node18"` — server-side library)
- **Testing:** Vitest, coverage via `@vitest/coverage-v8`
- **Linting/Types:** ESLint + `@typescript-eslint`, `tsc --noEmit`
- **Docs:** TypeDoc
- **Release:** Semantic-release (NPM + JSR)
- **Runtime deps:** `ws` (WebSocket), `terminal.js` (terminal protocol), `wcwidth`, `@novnc/novnc`
- **Consumed by:** `playground` via local `file:../../pve-client` dependency (must be built with `npm run build` before the playground can use it)

### svelte-playground/playground (SvelteKit Admin App — application)
- **Framework:** SvelteKit 2.x + Svelte 5 (runes mode)
- **Build:** Vite with `@sveltejs/vite-plugin-svelte`
- **Adapter:** `@sveltejs/adapter-node` — production runs as a custom Node HTTP server that also handles WebSocket upgrades
- **Runtime:** `node --experimental-strip-types server/index.ts` (native TS execution, no compile step)
- **Testing:** Vitest (unit + browser via Playwright + `vitest-browser-svelte`)
- **Linting/Types:** ESLint + `eslint-plugin-svelte`, `svelte-check`
- **Component Stories:** Storybook 10 (SvelteKit addon, CSF, a11y addon)
- **Docs:** TypeDoc
- **Terminal UI:** `@xterm/xterm` + `@xterm/addon-fit` (browser terminal emulator)
- **VNC UI:** `@novnc/novnc`
- **Tooltips:** `tippy.js`
- **TLS in dev:** `vite-plugin-mkcert`

### Workflow
- **Dev server:** Always start via `acctest-env.ps1` from `svelte-playground/playground/` — this script sets environment variables, builds `pve-client`, then runs `npm run dev`.
- **pve-client first:** Mostly shared behavior (terminal/WebSocket protocol, API types) lives in `pve-client`. Harden it there, then keep playground wiring thin.
