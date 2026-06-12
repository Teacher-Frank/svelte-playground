# Directives Playbook

This file is the authoritative policy source for this workspace.

## Workspace Operations

- **Multi-machine workflow**: Work is split across two machines on a weekly rotation.
  - **Fri–Tue**: Primary development station.
  - **Wed–Thu**: Surface Pro in Rotterdam.
- Always run `git pull` before starting a session on either machine.
- Re-read `AGENTS.md` and `POLICIES.md` at the start of each session.

## Priority 1: Single Source of Truth
- `POLICIES.md` is the only authoritative policy file in the repository.
- Do not create or maintain duplicate policy files (for example, `policy.md` or mirrored variants).
- Any derived notes (including memory summaries) must be generated from this file and never diverge from it.
- As a general rule, we do not store the same data in more than 1 location or file.

## Priority 2: Quality and Process Directives
- Keep code clean and concise; remove redundant and unused logic.
- Keep code resilient; handle errors, edge cases, and unexpected input.
- Validation pass criteria:
  - All required validation commands exit successfully with no unresolved errors.
  - New or changed code is human-readable: clear naming, coherent structure, and no dead or misleading code.
  - New or changed code includes comments where intent is non-obvious, with emphasis on why a decision was made.
- Document changes with the reason behind decisions, not only behavior.

## Priority 3: Validation Gate
- Before any commit, merge, or PR update, all required validation MUST pass:
  - `npm run check`
  - `npm run lint`
  - `npm run test:unit`
- If validation fails, the change MUST NOT be committed, merged, or pushed unless an approved exception exists under the Exceptions Policy.

## Priority 4: Core Architecture Directives
- Fix API-surface gaps in `pve-client` first; avoid consumer-side cast workarounds.
- Avoid `as unknown as Record<...>` and similar double-cast patterns.
- Export and consume named typed APIs (for example, `NodeScopedAPI`, `QemuScopedAPI`, `LxcScopedAPI`).
- If raw endpoint access is needed, use `client.request()` directly with typed path/args. Report this so a decision can be made whether a named type API is needed.
- Keep server-side terminal/WebSocket responsibility in `pve-client`; keep playground integration thin.

## Priority 5: Proxmox Behavioral Directives
- Use real node identity for all actions; never submit fallback node values like `unknown`.
- For node-scoped workload lists, use typed node APIs.
- For guest actions, route by workload type:
  - VM: `nodeApi.qemu.vmid(id)`
  - CT: `nodeApi.lxc.id(id)`

## Priority 6: UI Interaction Directives
- For all modal-based actions (deploy, rename, configure, and future equivalents), submit behavior must be optimistic and single-shot:
  - On submit, close the modal immediately.
  - Immediately show a success-style "action started" status message.
  - Prevent duplicate submits while the request is in flight (disable relevant action triggers/buttons).
  - If the request fails, clear optimistic started messaging and show the server-provided error.

## Priority 7: Environment and Tooling Directives
- On Windows test runs, redirect `TEMP`/`TMP` to `.vitest/tmp` when needed to avoid `mkdtemp` failures.
- Build `pve-client` before running playground if `pve-client/dist` is missing.
- In `pve-client` ESM TS setup, use explicit `.js` extensions for relative imports.
- Keep wrapper script docs/help synchronized with actual parameter names.
- All playground environment variables must be documented in `svelte-playground/playground/PxMx-Admin-For-Datalab-Guide.md`.

## Priority 7a: Error Message Policy
- When an error is caused by a wrong or rejected value, always include the actual value in the error message so that users and developers can identify the problem without additional investigation.
- Missing/empty-value errors do not need to show a value (there is nothing to show).
- Sensitive values (passwords, tokens, secrets) must never be included in error messages.

## Priority 8: Exceptions Policy
- Runtime exception handling policy:
  - Prefer specific, local exception handling where failures are expected and can be handled meaningfully.
  - Add one general fallback exception handler at the server entry point to catch uncaught errors that escape specific handlers.
  - The fallback handler is a backup safety net, not a replacement for specific exception handling.
  - The fallback handler must log enough context for diagnosis and return a controlled error response.
- Process exceptions policy:
  - Keep process/policy exceptions minimal, explicit, and temporary.
  - Every process/policy exception entry must include: scope, reason, and removal condition.
  - Do not add broad or convenience process/policy exceptions; only permit narrow blockers with clear technical rationale.
  - Review process/policy exceptions monthly and remove any that are no longer necessary.

## Priority 9: Canonical Runbook
- Unless the user specifies otherwise, run commands from `svelte-playground/playground` for playground changes and from `pve-client` for library changes.
- **To start the dev server, run `acctest-env.ps1`** from `svelte-playground/playground`. This script:
  1. Sets all required environment variables (Proxmox auth, storage, VNC bridge, etc.).
  2. Builds `pve-client` (`npm run build`).
  3. Starts the playground dev server (`npm run dev`).
- Playground common commands (run after the dev server is already started):
  - Type and Svelte diagnostics: `npm run check`
  - Lint: `npm run lint`
  - Unit/integration tests: `npm run test:unit -- --run`
  - Full quality gate: `npm run quality:gate`
  - Dev startup benchmark: `npm run bench:dev-startup`
- `pve-client` common commands:
  - Build: `npm run build`
  - Type/lint/tests: run the package-local `check`, `lint`, and `test` scripts when present.
- Validation success criteria:
  - Command exits with code `0`.
  - No unresolved errors in command output.

## Priority 10: Default Decision Policy
- Unless the user specifies otherwise:
  - Preserve existing APIs and behavior for consumers.
  - Prefer small, focused changes over broad refactors.
  - Fix root causes at library boundaries (`pve-client`) instead of adding cast-based consumer workarounds.
  - Prefer readability and maintainability first, then optimize performance where measurements justify it.
  - Keep UI behavior predictable and explicit over implicit automation.

## Priority 11: Change Acceptance Checklist
- A change is considered done only when all of the following are true:
  - Scope is fully implemented as requested.
  - Updated behavior is covered by tests or existing tests still prove behavior.
  - Required validation for the affected package passes.
  - No new diagnostics are introduced.
  - User-facing behavior changes are reflected in docs/comments where relevant.
  - Policy-impacting decisions are captured in `POLICIES.md` when durable.

## Priority 12: Review Severity Rubric
- Use these severity levels for reviews:
  - High: likely data loss, security risk, broken core flow, or guaranteed runtime failure.
  - Medium: functional bug, regression risk, or maintainability issue likely to cause near-term defects.
  - Low: clarity, consistency, minor UX polish, or non-blocking technical debt.
- Review output format:
  - Findings first, ordered by severity, each with file reference.
  - Then open questions/assumptions.
  - Then brief change summary.

## Priority 13: Repository Guardrails
- Never introduce duplicate policy sources; `POLICIES.md` remains authoritative.
- Do not reintroduce cast-heavy consumer patterns when a typed library surface can be added instead.
- Do not bypass validation gate requirements for commits/PR updates unless an explicit exception is recorded under the Exceptions Policy.
- Avoid destructive repository operations unless explicitly requested by the user.

## Priority 14: Maintenance Rule
- At the end of meaningful sessions, append or refine directives/lessons here if a new durable pattern was confirmed.
- During monthly review, validate each exception and either remove it or refresh its justification and removal condition.

## Priority 15: Bug Resolve Policy
- For every confirmed bug, capture a short bug record before coding:
  - Scope: affected feature/package and user-visible impact.
  - Reproduction: deterministic steps, environment, and observed vs expected behavior.
  - Severity: map to the review rubric (High, Medium, Low) and state why.
- Resolve bugs using this default sequence:
  - Contain: prevent additional harm or repeated triggering when feasible.
  - Before implementing a fix, create and run a test that reproduces the exact bug (unit/integration/e2e as appropriate) and verify it fails for the expected reason.
  - Fix root cause at the correct boundary (library surface first when shared behavior is involved).
  - Use that same reproducer test as the primary regression test and iterate on the fix until it passes.
  - Validate with required quality gates for the affected package.
- Closure criteria for a bug fix:
  - Reproduction no longer fails after the fix.
  - The reproducer test demonstrates fail-before and pass-after for the exact bug condition.
  - No new diagnostics are introduced.
  - User-facing behavior changes are documented where relevant.
- Hotfix exception path:
  - For urgent production blockers, a minimal containment patch may ship first.
  - A follow-up root-cause fix and regression test must be scheduled immediately and tracked to completion.

## Lessons Learned
- Type safety is most effective at library boundaries; local app casts create brittle debt.
- Most recurring regressions come from environment/setup drift, not core logic.
- Reliable Proxmox actions depend on accurate node propagation end-to-end.
- Terminal interoperability benefits from explicit sequence normalization and trace logging.
- Consistent pre-merge validation prevents avoidable late-stage churn.