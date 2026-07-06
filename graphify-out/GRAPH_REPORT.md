# Graph Report - svelte-playground  (2026-07-06)

## Corpus Check
- 152 files · ~111,559 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 875 nodes · 1138 edges · 74 communities (54 shown, 20 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `34fe5716`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Proxmox Actions & Types|Proxmox Actions & Types]]
- [[_COMMUNITY_Docs Generated Assets|Docs Generated Assets]]
- [[_COMMUNITY_Svelte Styling & Layout|Svelte Styling & Layout]]
- [[_COMMUNITY_Fit Addon (Terminal)|Fit Addon (Terminal)]]
- [[_COMMUNITY_SvelteCSF Addon (Storybook)|SvelteCSF Addon (Storybook)]]
- [[_COMMUNITY_WebSocket Protocol (RFC 6455)|WebSocket Protocol (RFC 6455)]]
- [[_COMMUNITY_Package Configuration|Package Configuration]]
- [[_COMMUNITY_TypeDoc Dependencies|TypeDoc Dependencies]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_VM Checklist Verification|VM Checklist Verification]]
- [[_COMMUNITY_Dev Startup Benchmark|Dev Startup Benchmark]]
- [[_COMMUNITY_Database (Database)|Database (Database)]]
- [[_COMMUNITY_noVNC Type Definitions|noVNC Type Definitions]]
- [[_COMMUNITY_Toast Notifications|Toast Notifications]]
- [[_COMMUNITY_Vitest Jiti Runtime|Vitest Jiti Runtime]]
- [[_COMMUNITY_Cloud-init Snippet Deploy|Cloud-init Snippet Deploy]]
- [[_COMMUNITY_Blog Data|Blog Data]]
- [[_COMMUNITY_Vitest Examples|Vitest Examples]]
- [[_COMMUNITY_Blog Routes|Blog Routes]]
- [[_COMMUNITY_Test Runner Scripts|Test Runner Scripts]]
- [[_COMMUNITY_Terminal Upload Tests|Terminal Upload Tests]]
- [[_COMMUNITY_Docs Icons|Docs Icons]]
- [[_COMMUNITY_Attachment Handler|Attachment Handler]]
- [[_COMMUNITY_Clone Template Tests|Clone Template Tests]]
- [[_COMMUNITY_ESLint Jiti Config|ESLint Jiti Config]]
- [[_COMMUNITY_Svelte Jiti Config|Svelte Jiti Config]]
- [[_COMMUNITY_App Global Styles|App Global Styles]]
- [[_COMMUNITY_Guest Agent Install|Guest Agent Install]]
- [[_COMMUNITY_VNC Bridge Install|VNC Bridge Install]]
- [[_COMMUNITY_Hookscript Setup|Hookscript Setup]]
- [[_COMMUNITY_VM Template Setup|VM Template Setup]]
- [[_COMMUNITY_App Type Declarations|App Type Declarations]]
- [[_COMMUNITY_Storybook Main Config|Storybook Main Config]]
- [[_COMMUNITY_Storybook Preview Config|Storybook Preview Config]]
- [[_COMMUNITY_SvelteKit Config|SvelteKit Config]]
- [[_COMMUNITY_Test Environment Script|Test Environment Script]]
- [[_COMMUNITY_Python vs TypeScript SDK Differences|Python vs TypeScript SDK Differences]]
- [[_COMMUNITY_Mem0 Use Cases & Examples|Mem0 Use Cases & Examples]]
- [[_COMMUNITY_Platform Client|Platform Client]]
- [[_COMMUNITY_Mem0 Platform Architecture|Mem0 Platform Architecture]]
- [[_COMMUNITY_Workspace-Independent (General Principles)|Workspace-Independent (General Principles)]]
- [[_COMMUNITY_Mem0 SDK Guide|Mem0 SDK Guide]]
- [[_COMMUNITY_Mem0 Platform Integration|Mem0 Platform Integration]]
- [[_COMMUNITY_Mem0 Platform API Reference|Mem0 Platform API Reference]]
- [[_COMMUNITY_Mem0 Skill for Claude|Mem0 Skill for Claude]]
- [[_COMMUNITY_mem0_doc_search.py|mem0_doc_search.py]]
- [[_COMMUNITY_Workspace-Dependent (This Project)|Workspace-Dependent (This Project)]]
- [[_COMMUNITY_....PxMxAdmin.svelte|../../PxMxAdmin.svelte]]
- [[_COMMUNITY_Technology-specific|Technology-specific]]
- [[_COMMUNITY_notification-store.svelte.ts|notification-store.svelte.ts]]
- [[_COMMUNITY_..DemoBigRedButton.svelte|../DemoBigRedButton.svelte]]
- [[_COMMUNITY_templateDialogEnhance.ts|templateDialogEnhance.ts]]
- [[_COMMUNITY_PxMxAdmin.svelte.spec.ts|PxMxAdmin.svelte.spec.ts]]
- [[_COMMUNITY_PxMxAdminRefresh.svelte.spec.ts|PxMxAdminRefresh.svelte.spec.ts]]
- [[_COMMUNITY_POLICIES|POLICIES.md]]
- [[_COMMUNITY_Appendix Development Stack|Appendix: Development Stack]]

## God Nodes (most connected - your core abstractions)
1. `Workspace-Independent (General Principles)` - 23 edges
2. `loadResults()` - 19 edges
3. `scripts` - 18 edges
4. `createClient()` - 17 edges
5. `../../PxMxAdmin.svelte` - 15 edges
6. `Platform Features -- Mem0 Platform` - 13 edges
7. `Mem0 SDK Guide` - 13 edges
8. `Workspace-Dependent (This Project)` - 13 edges
9. `constructor()` - 12 edges
10. `compilerOptions` - 12 edges

## Surprising Connections (you probably didn't know these)
- `proxmoxAgentStatusPlugin()` --calls--> `handleProxmoxAgentStatus()`  [EXTRACTED]
  playground/vite.config.ts → playground/server/proxmoxGuestAgentStatus.ts
- `proxmoxUploadPlugin()` --calls--> `handleProxmoxUpload()`  [EXTRACTED]
  playground/vite.config.ts → playground/server/proxmoxTerminalUpload.ts
- `proxmoxTerminalPlugin()` --calls--> `attachProxmoxTerminalWsProxy()`  [EXTRACTED]
  playground/vite.config.ts → playground/server/proxmoxTerminalWs.ts
- `proxmoxVncPlugin()` --calls--> `attachProxmoxVncWsProxy()`  [EXTRACTED]
  playground/vite.config.ts → playground/server/proxmoxVncWs.ts
- `renameLxcGuestTemplate()` --calls--> `createClient()`  [EXTRACTED]
  playground/src/routes/proxmox/action-template-deployers.ts → playground/src/routes/proxmox/helpers.ts

## Import Cycles
- None detected.

## Communities (74 total, 20 thin omitted)

### Community 0 - "Proxmox Actions & Types"
Cohesion: 0.05
Nodes (68): ToastContext, executeConvertToTemplateAction(), executeDestroyAction(), executeWorkloadAction(), executeWorkloadConfigureAction(), validResizeDisks, cloneLxcGuestTemplate(), cloneLxcTemplate() (+60 more)

### Community 1 - "Docs Generated Assets"
Cohesion: 0.08
Nodes (47): add(), Ae(), at(), Be(), Ce(), constructor(), createComponents(), De() (+39 more)

### Community 2 - "Svelte Styling & Layout"
Cohesion: 0.18
Nodes (7): $app/forms, @sveltejs/kit, ./PxMxTemplateActionButtons.svelte, enabled, ./PxMxTemplateDialog.svelte, ./PxMxTemplateTable.svelte, ./PxMxWorkloadControls.svelte

### Community 3 - "Fit Addon (Terminal)"
Cohesion: 0.05
Nodes (39): @xterm/addon-fit, @novnc/novnc, devDependencies, @chromatic-com/storybook, eslint, @eslint/compat, @eslint/js, eslint-plugin-storybook (+31 more)

### Community 4 - "SvelteCSF Addon (Storybook)"
Cohesion: 0.13
Nodes (9): @storybook/addon-svelte-csf, svelte/easing, ./Canvas.svelte, ../DemoCanvas.svelte, ../DemoClassReactivity.svelte, ../DemoJSTypeWriter.svelte, ../DemoTransition.svelte, messages (+1 more)

### Community 5 - "WebSocket Protocol (RFC 6455)"
Cohesion: 0.10
Nodes (34): RFC-6455, HttpGuard, httpGuards, port, server, attachProxmoxAgentStatusHandler(), createClient(), getContainerAgentStatus() (+26 more)

### Community 6 - "Package Configuration"
Cohesion: 0.04
Nodes (45): allowScripts, esbuild@0.27.7, dependencies, busboy, https, @novnc/novnc, pve-client, terminal.js (+37 more)

### Community 7 - "TypeDoc Dependencies"
Cohesion: 0.10
Nodes (19): typedoc, categorizeByGroup, entryPoints, entryPointStrategy, exclude, excludeExternals, excludeInternal, excludePrivate (+11 more)

### Community 8 - "TypeScript Config"
Cohesion: 0.13
Nodes (14): compilerOptions, allowJs, checkJs, forceConsistentCasingInFileNames, module, moduleResolution, resolveJsonModule, rewriteRelativeImportExtensions (+6 more)

### Community 9 - "VM Checklist Verification"
Cohesion: 0.30
Nodes (13): dpkg_is_installed(), fail(), has_systemd(), is_debian_based(), is_rhel_based(), pass(), pkg_install_cmd(), pkg_installed() (+5 more)

### Community 10 - "Dev Startup Benchmark"
Cohesion: 0.27
Nodes (10): average(), basePort, isServerReachable(), main(), runs, runSingle(), StartupSample, stripAnsi() (+2 more)

### Community 11 - "Database (Database)"
Cohesion: 0.27
Nodes (7): createTodo(), db, deleteTodo(), getOrCreateTodos(), getTodos(), Todo, actions

### Community 12 - "noVNC Type Definitions"
Cohesion: 0.20
Nodes (5): ClipboardEventDetail, @novnc/novnc, RFB, RFBCredentials, RFBOptions

### Community 13 - "Toast Notifications"
Cohesion: 0.05
Nodes (39): add(messages, **kwargs), add(messages, *, user_id, agent_id, run_id, metadata, infer=True), AsyncMemory, AsyncMemoryClient (Asynchronous), batch_delete(memories), Batch Methods, batch_update(memories), Configuration (+31 more)

### Community 14 - "Vitest Jiti Runtime"
Cohesion: 0.29
Nodes (5): config_helper_1, eslint_plugin_1, getTSConfigRootDirFromStack_1, raw_plugin_1, typescript_estree_1

### Community 15 - "Cloud-init Snippet Deploy"
Cohesion: 0.60
Nodes (5): bold(), green(), red(), deploy-cloudinit-snippets.sh script, yellow()

### Community 19 - "Test Runner Scripts"
Cohesion: 0.50
Nodes (3): child, vitestEntrypoint, vitestTempDir

### Community 50 - "Test Environment Script"
Cohesion: 0.05
Nodes (42): Advanced Retrieval, Available MCP Tools, Best Practices, Configuration, Configuration, Create Webhook, Criteria Retrieval, Custom Categories (+34 more)

### Community 54 - "Python vs TypeScript SDK Differences"
Cohesion: 0.06
Nodes (31): Architectural Differences, Common Gotcha, Constructor, Entity ID Passing (v3), Method Naming, OSS Config Naming, OSS Scope Parameter Naming, Parameter Passing (+23 more)

### Community 55 - "Mem0 Use Cases & Examples"
Cohesion: 0.05
Nodes (36): 1. Personalized AI Companion, 2. Customer Support with Categories, 3. Healthcare Coach, 4. Content Creation Workflow, 5. Multi-Agent / Multi-Tenant, 6. Personalized Search, 7. Email Intelligence, Common Patterns Across Use Cases (+28 more)

### Community 56 - "Platform Client"
Cohesion: 0.06
Nodes (33): add(messages, config), add(messages, options?), Batch Methods, batchDelete(memories), batchUpdate(memories), Configuration, delete(memoryId), deleteAll(options?) (+25 more)

### Community 57 - "Mem0 Platform Architecture"
Cohesion: 0.06
Nodes (30): Comparison with Alternatives, Conversation memory, Core Concept, Creation, Critical: cross-entity queries, Deletion, Extraction modes, How layering works in practice (+22 more)

### Community 58 - "Workspace-Independent (General Principles)"
Cohesion: 0.09
Nodes (23): P0: Read This File at Session Start, P10: Repository Guardrails, P10a: Cross-Session Memory, P11: Maintenance, P1: Single Source of Truth, P2: Quality and Refactoring, P2a: Test-First Refactoring, P2b: Consistent Patterns (+15 more)

### Community 59 - "Mem0 SDK Guide"
Cohesion: 0.11
Nodes (18): add() -- Store Memories, Additional Methods, Advanced Add Options, Batch Operations (TypeScript), Breaking Changes in v3, Common Filter Patterns, Common Pitfalls, delete() / deleteAll() -- Remove Memories (+10 more)

### Community 60 - "Mem0 Platform Integration"
Cohesion: 0.12
Nodes (16): Add memories, Client SDK References, Common edge cases, Common integration pattern, Delete a memory, Get all memories, Live documentation search, Mem0 Platform Integration (+8 more)

### Community 61 - "Mem0 Platform API Reference"
Cohesion: 0.15
Nodes (13): Add Response (v3), Endpoints, Filter Constraints, Filter System, Filterable Fields, Get All Response (v3), Mem0 Platform API Reference, Memory Object Structure (+5 more)

### Community 62 - "Mem0 Skill for Claude"
Cohesion: 0.17
Nodes (11): Claude.ai, Claude API (Skills API), CLI (Claude Code, OpenCode, OpenClaw, or any tool that supports skills), Installation, License, Links, Mem0 Skill for Claude, Prerequisites (+3 more)

### Community 63 - "mem0_doc_search.py"
Cohesion: 0.27
Nodes (11): fetch_page(), fetch_url(), get_index(), list_section(), main(), Fetch a specific documentation page., Fetch the full documentation index from llms.txt., List all known pages in a documentation section. (+3 more)

### Community 64 - "Workspace-Dependent (This Project)"
Cohesion: 0.17
Nodes (12): Architecture: pve-client + playground, Environment and Tooling, External API Research (P0 — before any API call), MCP Tools, Proxmox API Debugging Lessons, Proxmox Behavior, Runbook, UI Interaction (+4 more)

### Community 65 - "../../PxMxAdmin.svelte"
Cohesion: 0.24
Nodes (3): ./PxMxStyle.css, $app/navigation, ../../PxMxAdmin.svelte

### Community 66 - "Technology-specific"
Cohesion: 0.20
Nodes (10): Lessons Learned, Notification System, PowerShell Text Processing, Refactor Approach, Shell Scripts: Fail Fast and Loud (Bash + PowerShell), Splitting Vitest Test Files with Shared Hoisted Mocks, Svelte 5 Runtime Behavior, Svelte File Extensions (+2 more)

### Community 67 - "notification-store.svelte.ts"
Cohesion: 0.25
Nodes (5): AUTO_DISMISS_MS, DisplayedNotification, NotificationKind, NotificationScope, scopes

### Community 68 - "../DemoBigRedButton.svelte"
Cohesion: 0.29
Nodes (5): svelte/elements, $app/environment, ./BigRedButton.svelte, ../DemoBigRedButton.svelte, storybook/test

### Community 69 - "templateDialogEnhance.ts"
Cohesion: 0.48
Nodes (5): createOptimisticDialogEnhance(), DialogEnhanceOptions, EnhanceArgs, EnhanceResult, focusAndSelectInput()

### Community 72 - "POLICIES.md"
Cohesion: 0.50
Nodes (3): Appendix: How to create, maintain and use a POLICIES.md, Directives Playbook, Enforcing the AI Agent to Read POLICIES.md First

### Community 73 - "Appendix: Development Stack"
Cohesion: 0.50
Nodes (4): Appendix: Development Stack, pve-client (Proxmox TypeScript API Client — library), svelte-playground/playground (SvelteKit Admin App — application), Workflow

## Knowledge Gaps
- **409 isolated node(s):** `What This Skill Does`, `CLI (Claude Code, OpenCode, OpenClaw, or any tool that supports skills)`, `Claude.ai`, `Claude API (Skills API)`, `Prerequisites` (+404 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ToastContext` connect `Proxmox Actions & Types` to `notification-store.svelte.ts`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Fit Addon (Terminal)` to `Package Configuration`, `TypeDoc Dependencies`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **What connects `What This Skill Does`, `CLI (Claude Code, OpenCode, OpenClaw, or any tool that supports skills)`, `Claude.ai` to the rest of the system?**
  _415 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Proxmox Actions & Types` be split into smaller, more focused modules?**
  _Cohesion score 0.05347985347985348 - nodes in this community are weakly interconnected._
- **Should `Docs Generated Assets` be split into smaller, more focused modules?**
  _Cohesion score 0.07744107744107744 - nodes in this community are weakly interconnected._
- **Should `Fit Addon (Terminal)` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._
- **Should `SvelteCSF Addon (Storybook)` be split into smaller, more focused modules?**
  _Cohesion score 0.12631578947368421 - nodes in this community are weakly interconnected._