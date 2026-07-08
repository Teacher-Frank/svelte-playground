# Directives Playbook

This file is the authoritative policy source for this workspace. Read it at the start of each session.

**Purposes:**
1. **Guide reasoning** — shapes decisions, prevents known mistakes, provides correct patterns without rediscovering them.
2. **Port across sessions, models, and versions** — principles and lessons persist so any future model inherits accumulated experience.
3. **Enable self-verification** — continuously feeds the model a built-in feedback loop, so it tests changes against this file before presenting work as complete.
4. **Settle trade-off conflicts** — explicitly resolves competing best practices into a single authoritative position, so the model doesn't guess which side to take.

Priority directives are numbered in descending order — P0 is highest and most critical.

---

# Workspace-Independent (General Principles)

These rules apply to any project. They guide reasoning, prevent mistakes, and port across tools and teams.

## P0: Read This File at Session Start
- **Always** read `POLICIES.md` at the beginning of every new session before taking any other action.
- This step is **never optional**, even when the user's first request is specific, urgent, or appears unrelated to policy.
- Do not begin work on the user's request until this file has been read — the request can wait, the policy cannot.
- This is the highest priority directive — all other rules depend on it.

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
- **Unreachable code:** when detected, remove it immediately. If revisiting is ever needed, the code is recoverable from git history.

## P2b: Consistent Patterns
- When a problem has a confirmed unified solution, apply it everywhere it's needed.
- Never leave ad-hoc or legacy patterns alongside the canonical one — consolidate them.
- Example: if a shared notification system replaces scattered `<p>` elements, refactor all consumers to use it.

## P2a: Test-First Refactoring
- Generate a unit test showing current behavior before changing it. Verify the refactor preserves it.
- If no suitable test target exists (private details), expose the minimum surface to make it testable first.

## P2c: Unknown API Surface Validation
- **Before using an external API parameter, endpoint, or method that hasn't been verified as real:** write a compile-time or runtime test that proves it exists.
- If the parameter appears in generated type definitions (`types.ts`, OpenAPI spec, etc.), add an `expectTypeOf` canary test confirming its presence.
- If types are auto-generated from an external spec, also fetch the official documentation to cross-reference — auto-generated types can be stale or incomplete.
- If the parameter does **not** exist in the spec/types, document the gap and do not use it.
- **Rationale:** fabricated API parameters (e.g., `cicommand`) silently fail at runtime — the server ignores unknown fields. A compile-time canary is the cheapest early warning.

## P2d: Generated Code Must Validate Before Ship
- **When code generates code** (templates, heredocs, YAML, JSON, config files, systemd units, shell scripts, etc.), **validate the generated output locally before deploying it to a target runtime.**
- Don't rely on a remote reboot or deployment cycle to discover syntax errors in generated content.
- **Examples of pre-ship validation:**
  - YAML: `python3 -c "import yaml; yaml.safe_load(open('output.yaml'))"`
  - JSON: `python3 -c "import json; json.load(open('output.json'))"`
  - Shell: `bash -n script.sh`
  - TypeScript: `tsc --noEmit` on generated `.ts` files
  - Config/INI: parse with the target library's parser
- **Bake validation into the generator itself** — add a `--dry-run` or `--validate` flag that generates + checks without deploying.
- **Rationale:** syntax errors in generated code surface only after full deployment or reboot cycles (deploy → reboot → cloud-init runs → fails silently). A 1-second local syntax check saves hours of debugging across machines.

## P2e: Always Show Explicit State
- **Never leave UI surfaces in ambiguous states** — explicitly show loading, empty, error, and success states.
- A blank screen is never acceptable. If data is loading, show a loading indicator. If there's no data, show an empty state message. If data is unavailable, explain why.
- For remote connections (VNC, terminal, API endpoints): if the connection target is unavailable, render an actionable error message with retry guidance — not a blank canvas.
- **Rationale:** users interpreting blank screens as "broken" vs "no data" leads to confusion and support requests. Explicit states eliminate inference.

## P2f: Keyboard Accessibility
- **Interactive UI elements must support keyboard navigation** at minimum input types:
  - `Enter`: activate/confirm actions, open dialogs
  - `Escape`: close dialogs, cancel in-progress actions, clear selection
  - Arrow keys: traverse lists, tables, and tab groups
- Every focusable element should have visible focus rings.
- **Rationale:** keyboard-only users are excluded if interactions are mouse-only. Even basic support (Enter/Escape) covers 80% of patterns.

## P3: Impact Analysis Before Implementation
- **Before enacting any change**, perform two impact analyses:
  1. **Root cause:** What is the actual cause of the problem? Trace the failure to its source — don't treat symptoms.
  2. **Solution impact:** What will this change affect downstream? Identify every consumer, dependent module, test, and UI surface that touches the affected code.
- **Output before coding:** List the affected files, components, and tests. If the list is longer than expected, reconsider scope.
- **Regression check:** For each affected area, ask "could this change break the existing behavior?" and verify with tests or code reading before writing the fix.
- **Rationale:** Regressions are often introduced not by wrong fixes, but by incomplete understanding of what the fix will touch. Analyzing impact before writing code is cheaper than finding regressions after.

## P3b: Validation Gate
- Before any commit, merge, or PR: all required validation MUST pass. If validation fails, the change MUST NOT ship without an approved exception.
- Validation success: command exits `0`, no unresolved errors, output is clean.

## P3c: Bash Script Syntax Check
- **After editing any `.sh` file**, run `bash -n <file>` to verify syntax before presenting the change as complete or asking the user to test it.
- This is non-negotiable — a script with a syntax error (unclosed `if`, missing `fi`, etc.) is guaranteed to fail at runtime.
- **Rationale:** the editor's string-replace tool can silently break control-flow structure (missing `fi`, broken indentation) that only tools like `bash -n` can detect.

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

## P10a: Cross-Session Memory
- **Before using knowledge from persistent memory (`/memories/`)** that originates from a previous conversation session, discuss it with the user first.
- State what the remembered knowledge is, where it came from, and why you think it applies.
- Let the user determine whether it's still valid for the current feature or context.
- **Rationale:** remembered knowledge may be stale, partially incorrect, or conflated with other sessions' hallucinations. The user is the single source of truth for current intent and state.

## P11: Maintenance
- At the end of meaningful sessions, append or refine directives here when a new durable pattern is confirmed.
- During monthly review, validate each exception — remove or refresh justification.

---
# Technology-specific

## Refactor Approach
- **Test constraints before building solutions.** Before trying multiple approaches to work within an untested external constraint, write a single minimal repro to confirm whether it's possible.
- Example: before iterating through 3–4 failed approaches to share `vi.hoisted` values across test modules, one quick repro would have confirmed cross-module imports cannot work.
- Framework behavior constraints (mock hoisting, transform ordering) are architectural, not implementation details — discover them at the start of a task.

## PowerShell Text Processing
- **Pattern:** `Get-Content` + index ranges + `Out-File -Encoding UTF8`. Select and export existing lines rather than constructing new arrays.
- Contiguous: `@('header') + $lines[123..479] | Out-File -Encoding UTF8 output.ts`
- Non-contiguous: `($lines[480..821] + $lines[998..1065] + $lines[1166..1209]) | Out-File -Encoding UTF8 output.ts`

## Shell Scripts: Fail Fast and Loud (Bash + PowerShell)
- **Bash:** every script MUST start with `set -euo pipefail` — exit on error (`-e`), fail on undefined vars (`-u`), propagate pipe failures (`-o pipefail`). This is non-negotiable.
- **PowerShell:** every script MUST start with `$ErrorActionPreference = 'Stop'` (or `-ErrorAction Stop` on individual commands when pipeline-continuing is needed).
- **Guard critical prerequisites at the top** — fail early with a clear message if a required tool, env var, or file is missing.
- **Embedding YAML/JSON in heredocs:** validate the heredoc content at the end of the script (e.g., `python3 -c "import yaml; yaml.safe_load(open('$file'))"` for YAML). Syntax errors in embedded data cause silent runtime failures downstream. See **P2d** for the broader generated-code policy.
- **Log each step** — use `echo`/`Write-Host` before critical operations, not after. This makes partial execution visible.
- **Rationale:** The `deploy-cloudinit-snippets.sh` bug (2026-07-03) was caused by invalid YAML embedded in the heredoc — `shopt -s nullglob` and `shopt -u nullglob` directives leaked into the YAML text, producing unparseable `runcmd` content. Cloud-init silently skipped it entirely (`Skipping modules '...runcmd' because no applicable config is provided`). A local YAML syntax check (`python3 -c "import yaml; yaml.safe_load(open('install-agent.yaml'))"`) *before* deploying to Proxmox would have caught this instantly, saving a full day of debugging.
## Svelte 5 Runtime Behavior
- **Avoid assigning a new array/object to the same `$state` inside an `$effect` unless content actually changed** — otherwise tests fail with `effect_update_depth_exceeded`.
- Use conditional guards or `$derived` when reaction depends on computed state, not unconditional reassignment.

## Svelte File Extensions
- Use `.svelte.ts` for files that contain Svelte-specific syntax (runes like `$state`, `$derived`, `$effect`, `$props()`, etc.).
- Use `.ts` for plain TypeScript modules (no Svelte runes or compiler features).
- This distinction ensures the Svelte compiler processes files that need it, while plain modules go through standard TypeScript only.
## TypeScript ESM Imports (`nodenext` / `node16` moduleResolution)
- **Rule:** All relative imports and re-exports in `.ts` files must use explicit `.js` extensions (e.g., `from "./module.js"`, not `from "./module"`), even though the source files are `.ts`.
- TypeScript with `--moduleResolution nodenext` (or `node16`) enforces this at compile time (TS2835).
- Applies to both `import` and `export ... from` clauses.
- Non-relative imports (bare package specifiers like `"node:https"` or `"vitest"`) do not require extensions.
- Double-quoted strings: single quotes `'` are literal — no escaping needed.
- Avoid `\x27` in single-quoted strings — it writes literal `\x27` bytes, not `'`.

## Splitting Vitest Test Files with Shared Hoisted Mocks
- Vitest `vi.hoisted` values cannot be exported or imported across modules — the mock factory runs before any imports evaluate.
- **Working pattern:** compile-time include directive. Create `shared-mock-setup.ts` (no imports/exports, bare comments only — no JSDoc/backticks) containing `vi.hoisted` + `vi.mock`. Create a Vite plugin (`include-directive.ts`, `enforce: 'pre'`) that replaces `/// #include ./shared-mock-setup.ts` with the file contents.
- Each split test file uses `/// #include ./shared-mock-setup.ts` as line 1.
- **ESLint:** add `shared-mock-setup.ts` to ignores; add `"no-undef": "off"` for test files using the directive (ESLint runs before Vite transforms).

## Lessons Learned

## Notification System
- **One notification per action** — never show both a toast AND an inline bar for the same action.
- **Toast** (floating bottom): transient "work-in-progress" or "task started" feedback → auto-dismisses after 3 seconds.
- **Inline bar** (in-page, above the relevant section): final outcome → success auto-dismisses after 10s, errors stay until manually dismissed.
- When an inline bar arrives (e.g., server response), any pending toast for the same action MUST be cleared.
- Use the unified `toast-notification.ts` store and `ToastNotification.svelte` — do not create ad-hoc notification elements.
- Shared auto-dismiss logic lives in `toast-notification.ts`, never duplicated per component.
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

## Workspace Tools: graphify knowledge graph
- **Both `svelte-playground` and `pve-client` have `graphify-out/graph.json`** — query it before scanning the codebase for structural questions (architecture, "where is X?", "what does Y connect to?", import relationships).
- Use `graphify explain <node>` to get a node's connections, source location, and community in one call.
- Use `graphify query "<question>"` for BFS traversal across the graph structure.
- Use `graphify path "A" "B"` to trace the shortest path between two concepts.
- **Do NOT use graphify for:** reading actual implementation logic, debugging errors, detailed code review, or anything requiring understanding of *how* code works rather than *where* it is.
- **Rationale:** graphify saves exploration tokens by providing codebase structure upfront (god nodes, community layout, surprising connections) without scanning source files. For structural/architecture questions, it replaces 3-5 grep + read_file calls with one `graphify query`.

## Workspace Git Repositories
- **This workspace contains two Git repositories:**
  1. `svelte-playground` (primary — check first for git operations)
  2. `pve-client` (secondary — check second)
- **Never run git commands in the workspace root** (`c:\hrgit`) — it is not a Git repository.
- **Use native `git` CLI via terminal** for all git operations (add, commit, push, pull, etc.). Do not use GitKraken MCP tools or any third-party git tooling wrapper — the native CLI is simpler, more predictable, and consistent with how all other commands are executed.

## Architecture: pve-client + playground
- **Fix API-surface gaps in `pve-client` first**; avoid consumer-side cast workarounds.
- Avoid `as unknown as Record<...>` and similar double-cast patterns.
- Export and consume named typed APIs (`NodeScopedAPI`, `QemuScopedAPI`, `LxcScopedAPI`).
- If raw endpoint access is needed, use `client.request()` directly with typed path/args. Report so a decision can be made whether a named API is needed.
- Server-side terminal/WebSocket responsibility lives in `pve-client`; playground wiring stays thin.
- ESM TS in `pve-client`: use explicit `.js` extensions for relative imports.
- **Background task tracking** — when a server action offloads long-running work (e.g., VM deploy, destroy) to a background task, follow this pattern:
  1. Fire the Proxmox task, capture and **store the UPID** in a shared tracking map (e.g., `pendingDestroy`, `pendingDeploy`)
  2. Return HTTP response immediately — don't block on `task.wait()`
  3. During periodic page refresh, **poll the task by UPID** to detect completion or failure
  4. Surface the actual Proxmox task error message to the user — don't swallow it
  5. Only use a stale-timeout as a **fallback** (not the primary detection mechanism)
  6. Provide a **cancel/retry** action when a task fails so the user can recover from a stuck state
  - Never use fire-and-forget `setTimeout` that swallows errors
  - Never mark a task as failed purely on elapsed time when the UPID is available

## External API Research (P0 — before any API call)
- **ALWAYS read official documentation before using an external API parameter, endpoint, or method.**
- If the API has online docs (Proxmox, browser APIs, npm packages, etc.), fetch them with `fetch_webpage` or equivalent.
- If the API has type definitions in the codebase (`types.ts`, OpenAPI specs, interfaces), read them.
- **Cross-reference sources.** Auto-generated types (`pve-client/src/api/nodes/types.ts`) can be stale or incomplete. Official docs always trump code comments.
- **Never assume** parameter names, types, defaults, or semantics — even if they seem obvious, mirror a sibling endpoint, or "just make sense".
- **If you catch yourself guessing, STOP and look it up.** One round-trip to the docs saves multiple broken commits.
- **Rationale:** Multiple times the model has fabricated API semantics (wrong param name, wrong return type) and pushed broken code that only fails at runtime against a real server.

## Proxmox API Debugging Lessons
- **Verify API parameter semantics before touching serialization.** Example: `agent/file-write` `encode=1` means "Proxmox base64-encodes for you", `encode=0` means "content is already encoded". Sending pre-encoded content with `encode=true` causes double-encoding (files stored as base64 text). Root cause was parameter misunderstanding, not serialization.
- **Fix calling logic at the application layer, not the library layer.** When Proxmox params fail, check the calling code first (wrong flag, wrong encoding, wrong endpoint). Don't reach for `pve-client` serialization fixes unless the library is genuinely broken.
- **Numeric literals beat booleans across bundler transforms.** Proxmox rejects the string `"false"` for boolean form params. Vite SSR can serialize booleans as `"false"` (via `String(false)`) instead of `"0"`. When sending boolean params to Proxmox, prefer numeric `0`/`1` literals over `false`/`true` booleans.
- **Terminal/UI error messages are high-signal.** Proxmox returns explicit validation errors (e.g., `type check ('boolean') failed - got 'false'`). Read them first to rule in/out serialization vs. logic hypotheses.
- **Endpoint-specific params matter.** `file-write` uses `encode`; `file-read` uses `decode`. Different endpoints have different parameter sets — don't reuse one endpoint's params on another.

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
- **Dialog buttons are always enabled** — confirm/cancel buttons in modal dialogs must never be conditionally disabled. The user should always have the choice to confirm or dismiss. Do not use `disabled` attributes on dialog buttons based on workload status, in-flight state, or any other condition.
- **UI stuck-state detection** — when a UI state (e.g., "deploying") depends on conditions that can silently fail, add failure detection with timed grace periods instead of waiting for a hard cap. Surface the failure explicitly with a distinct status (e.g., "deploy-failed") and notification, rather than dropping the entry silently after a long timeout.
- **Grace-period resolution with timestamps** — when resolving a pending UI state from multiple conditions, track the timestamp of when each condition settled, not just whether it settled. This allows distinguishing "still in progress" from "failed — give it a moment" from "confirm failed". Example: `tasksSettledAt` for deploy entries, with a grace period before marking failed.

## Environment and Tooling
- **Never run `npm run dev` directly.** Start the dev server via `acctest-env.ps1` from `svelte-playground/playground/` — it sets environment variables, builds `pve-client`, and starts the dev server.
- Build `pve-client` before running playground if `dist` is missing.
- Windows test runs: redirect `TEMP`/`TMP` to `.vitest/tmp` if needed to avoid `mkdtemp` failures.
- Playground env vars documented in `svelte-playground/playground/PxMx-Admin-For-Datalab-Guide.md`.
- **Browser test prerequisite:** Before running `quality:gate` after a fresh checkout or Playwright update, run `npx playwright install chromium` from `svelte-playground/playground/` to download browser binaries. Without this, Vitest browser tests fail with `browserType.launch` error.

## MCP Tools
- **MCP extension stays enabled** — it provides useful tools.
- **Never call `mcp_gitkraken_cli_*` tools** — the user has no GitKraken account; all calls fail with an auth error.
- Use `git` via the terminal (`run_in_terminal`) for all git operations instead.
- **GitLens extension is separate** from GitKraken MCP — keep using GitLens as normal.
- **`runSubagent`** — do not use default model (ChatGPT hits monthly credit limit). Use `model: "Qwen3.6:27b (copilot)"` instead for unlimited tokens.

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

# Appendix: How to create, maintain and use a POLICIES.md

POLICIES.md solves two separate problems:

- **Cold start** — every new session begins without prior knowledge. This file gives the AI a useful starting point instead of forcing it to reinvent conventions.
- **Observed failure modes** — rules here exist because something went wrong. AI models *know* best practices but don't reliably *follow* them unless explicitly constrained. POLICIES.md is that constraint.

Workflow:

1. **Add a rule** — user or AI. Every rule should answer "what failure did we observe?"
2. **Acceptance gate** — ask the AI: *"Would you behave differently without this rule?"* If the answer is "no," cut it. Don't rely on pushback as a signal; AIs rarely push back unless forced.
3. **Rewrite** — the AI will propose a clearer, more concise formulation. Approve the rewrite.
4. **Evaluate against the 5 purposes** (at the top of this file). Does the rule guide reasoning, port across sessions, enable self-verification, settle a trade-off, or disambiguate a convention? If not, reconsider it.
5. **Check for contradictions** — scan the file. No rule should conflict with another. If it does, resolve it now.
6. **Repeat** — POLICIES.md improves through this dialog. Humans observe failures; AI formulates rules concisely.

Once you have a useful POLICIES.md, make sure the AI reads it at the start of every new session. Relying on memory alone is not enough — models will skip it when the user's first request appears urgent or unrelated.

### Enforcing the AI Agent to Read POLICIES.md First

The most reliable mechanism is a markdown file that your agent always reads a t startup like `AGENTS.md` or `copilot-instructions.md` in your repository root. The AI agent reads this file before each session and follows its directives.

**Example pattern (using copilot in Visual Studio Code):**

1. Create `.github/copilot-instructions.md` with a strong, unambiguous directive:

```markdown
# Workspace Copilot Instructions

## Required Startup Step
- **Read POLICIES.md before doing anything else.** This is not optional — even if the user's first message is a specific, urgent request, read the policy file first.
- Treat POLICIES.md as the authoritative policy source for this workspace.

## Ongoing Behavior
- If a task conflicts with remembered habits, follow POLICIES.md.
- If POLICIES.md is edited during a session, re-read it before continuing.
- Do not create duplicate policy sources; reference POLICIES.md directly.
```

2. In `POLICIES.md` itself (P0), reinforce the directive:

```markdown
## P0: Read This File at Session Start
- **Always** read `POLICIES.md` at the beginning of every new session before taking any other action.
- This step is **never optional**, even when the user's first request is specific, urgent, or appears unrelated to policy.
- Do not begin work on the user's request until this file has been read — the request can wait, the policy cannot.
```

**Why this works:**
- Copilot's built-in `copilot-instructions.md` file is read by the agent **before** any user prompt is processed — it runs first.
- P0 in `POLICIES.md` itself reinforces the directive once the file is in hand.
- Double-binding (external trigger + internal directive) is more resilient than relying on either one alone.
- Keeping the file in `.github/` ensures it's tracked by git, versioned, and visible on GitHub.

**Additional enforcement layer: persistent user memory**
Critical startup directives (especially P0: read this file) should also be recorded in the assistant's persistent user memory (e.g., `/memories/00-session-startup.md`). User memory loads automatically at session start, before conversation begins — providing a third enforcement layer that fires even if the external trigger files are missed for any reason. Triple-binding (copilot-instructions.md → P0 → user memory) prevents the model from skipping policy on cold start.
**Common failure modes to avoid:**
- Weak wording like "consider reading" or "you may want to review" — models will skip it.
- Polite phrasing — models treat requests as suggestions unless stated as mandatory.
- Placing instructions only inside POLICIES.md without an external trigger — the model won't know to read it before processing the user's request.
- Storing `copilot-instructions.md` outside any git repo — changes become untracked and unreviewable. 

---

# AI Skills Installed

These skills are available in the development environment and can be invoked during sessions.

## Claude Skills (User-Level — `~/.claude/skills/`)

**Active:**

| Skill | Source | Trigger | Purpose |
|-------|--------|---------|---------|
| **graphify** | Local skill | `/graphify` or structural questions | Converts codebase/input to persistent knowledge graph with god nodes, community detection, and query/path/explain tools. Use for architecture exploration, "where is X?", import relationships. |

**Optional (deleted to save context tokens):**

The skills below were created but removed — they provided no executable tooling, only markdown-guided best practices. Reinstall if you want explicit checklists:

| Skill | Topic | Removed because... |
|-------|-------|-------------------|
| ~~**doc-coauthoring**~~ | Documentation workflow | Knowledge I already have (Understand → Outline → Draft → Review). Dead weight in context. |
| ~~**frontend-design**~~ | UI design guidance | Generic design principles (typography, color, spacing) — not project-specific enough to justify context load. |
| ~~**webapp-testing**~~ | Playwright/browser testing | Browser testing already has dedicated tools (`open_browser_page`, `click_element`, etc.) in the toolbelt. Skill file was redundant documentation. |

## Agent Customization Skills (VS Code Built-in)

| Skill | Purpose |
|-------|---------|
| **project-setup-info-local** | Comprehensive workspace/project scaffolding for full project initialization (TypeScript, React, Node.js, MCP servers, VS Code extensions, Next.js, Vite, etc.). |
| **agent-customization** | Create, update, review, fix, or debug VS Code agent customization files (`.instructions.md`, `.prompt.md`, `.agent.md`, `SKILL.md`, `copilot-instructions.md`, `AGENTS.md`). |
| **get-search-view-results** | Get current search results from the VS Code Search view. |

## Repository-Level Skills (both `svelte-playground/` and `pve-client/`)

| Skill | Source | Purpose |
|-------|--------|---------|
| **mem0** | `mem0ai/mem0` (GitHub) | Memory/persistence skill. Installed in both repos via `.agents/skills/mem0/` + `skills-lock.json`. |

## mem0 Installation Notes

- **Both repos have `mem0ai` SDK** — `pve-client` as direct dep; `svelte-playground/playground` gets it transitively via `pve-client`.
- **`.env` in both repos** — contains `MEM0_API_KEY`. Already tracked in `.gitignore`.
- **CLI: `@mem0/cli`** — installed globally (`v0.2.10`). Use `mem0` commands in terminal.
- **Agent skill path**: `.agents/skills/mem0/SKILL.md` (both repos)
- **Lock files**: `skills-lock.json` in both repo roots
- **To use**: set `$env:MEM0_API_KEY` (from `.env`) then `mem0 add`, `mem0 search`, etc.
