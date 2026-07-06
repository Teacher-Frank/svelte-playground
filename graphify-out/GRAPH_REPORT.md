# Graph Report - ..  (2026-07-06)

## Corpus Check
- 166 files · ~97,025 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 528 nodes · 782 edges · 54 communities (33 shown, 21 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

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
- [[_COMMUNITY_Todo Routes|Todo Routes]]
- [[_COMMUNITY_Guest Agent Install|Guest Agent Install]]
- [[_COMMUNITY_VNC Bridge Install|VNC Bridge Install]]
- [[_COMMUNITY_Hookscript Setup|Hookscript Setup]]
- [[_COMMUNITY_VM Template Setup|VM Template Setup]]
- [[_COMMUNITY_App Type Declarations|App Type Declarations]]
- [[_COMMUNITY_Storybook Main Config|Storybook Main Config]]
- [[_COMMUNITY_Storybook Preview Config|Storybook Preview Config]]
- [[_COMMUNITY_SvelteKit Config|SvelteKit Config]]
- [[_COMMUNITY_Test Environment Script|Test Environment Script]]

## God Nodes (most connected - your core abstractions)
1. `loadResults()` - 19 edges
2. `scripts` - 18 edges
3. `createClient()` - 17 edges
4. `../../PxMxAdmin.svelte` - 15 edges
5. `constructor()` - 12 edges
6. `compilerOptions` - 12 edges
7. `add()` - 11 edges
8. `handleProxmoxUpload()` - 10 edges
9. `handleProxmoxAgentStatus()` - 9 edges
10. `ToastContext` - 9 edges

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

## Communities (54 total, 21 thin omitted)

### Community 0 - "Proxmox Actions & Types"
Cohesion: 0.06
Nodes (67): executeConvertToTemplateAction(), executeDestroyAction(), executeWorkloadAction(), executeWorkloadConfigureAction(), validResizeDisks, cloneLxcGuestTemplate(), cloneLxcTemplate(), deployVmFromTemplate() (+59 more)

### Community 1 - "Docs Generated Assets"
Cohesion: 0.08
Nodes (47): add(), Ae(), at(), Be(), Ce(), constructor(), createComponents(), De() (+39 more)

### Community 2 - "Svelte Styling & Layout"
Cohesion: 0.06
Nodes (24): ./PxMxStyle.css, $app/forms, @sveltejs/kit, $app/navigation, AUTO_DISMISS_MS, DisplayedNotification, NotificationKind, NotificationScope (+16 more)

### Community 3 - "Fit Addon (Terminal)"
Cohesion: 0.05
Nodes (41): @xterm/addon-fit, ./$types.js, ./$types.js, @novnc/novnc, devDependencies, @chromatic-com/storybook, eslint, @eslint/compat (+33 more)

### Community 4 - "SvelteCSF Addon (Storybook)"
Cohesion: 0.06
Nodes (25): @storybook/addon-svelte-csf, svelte/easing, svelte/elements, $app/environment, dependencies, busboy, https, @novnc/novnc (+17 more)

### Community 5 - "WebSocket Protocol (RFC 6455)"
Cohesion: 0.10
Nodes (34): RFC-6455, HttpGuard, httpGuards, port, server, attachProxmoxAgentStatusHandler(), createClient(), getContainerAgentStatus() (+26 more)

### Community 6 - "Package Configuration"
Cohesion: 0.06
Nodes (34): allowScripts, esbuild@0.27.7, exports, files, keywords, name, overrides, cookie (+26 more)

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

### Community 14 - "Vitest Jiti Runtime"
Cohesion: 0.29
Nodes (5): config_helper_1, eslint_plugin_1, getTSConfigRootDirFromStack_1, raw_plugin_1, typescript_estree_1

### Community 15 - "Cloud-init Snippet Deploy"
Cohesion: 0.60
Nodes (5): bold(), green(), red(), deploy-cloudinit-snippets.sh script, yellow()

### Community 19 - "Test Runner Scripts"
Cohesion: 0.50
Nodes (3): child, vitestEntrypoint, vitestTempDir

## Knowledge Gaps
- **156 isolated node(s):** `config`, `preview`, `eslint_plugin_1`, `raw_plugin_1`, `typescript_estree_1` (+151 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ToastContext` connect `Toast Notifications` to `Proxmox Actions & Types`, `Svelte Styling & Layout`?**
  _High betweenness centrality (0.141) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Fit Addon (Terminal)` to `Package Configuration`, `TypeDoc Dependencies`?**
  _High betweenness centrality (0.124) - this node is a cross-community bridge._
- **What connects `config`, `preview`, `eslint_plugin_1` to the rest of the system?**
  _157 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Proxmox Actions & Types` be split into smaller, more focused modules?**
  _Cohesion score 0.06200411401704378 - nodes in this community are weakly interconnected._
- **Should `Docs Generated Assets` be split into smaller, more focused modules?**
  _Cohesion score 0.07744107744107744 - nodes in this community are weakly interconnected._
- **Should `Svelte Styling & Layout` be split into smaller, more focused modules?**
  _Cohesion score 0.06475485661424607 - nodes in this community are weakly interconnected._
- **Should `Fit Addon (Terminal)` be split into smaller, more focused modules?**
  _Cohesion score 0.045454545454545456 - nodes in this community are weakly interconnected._