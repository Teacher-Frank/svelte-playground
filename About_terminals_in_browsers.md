# About terminals in browsers

This file is intended to be a living note for the current terminal work.

It should be maintained as long as the three agreed terminal issues remain open:

1. main issue 1: held navigation/delete corruption
2. main issue 2: cursor jumps to the middle and `vi` does not use the full screen
3. main issue 3: prompt should appear immediately on open

Until all three issues are fixed, this file should track:

- what we changed
- what worked
- what did not work
- which issue each finding relates to

## Current operating recommendation

For LXC web-terminal usage in this project, the current operational recommendation is:

1. use `bash` as the default guest shell
2. do not treat `pwsh` as the default supported interactive shell for held-navigation stress behavior yet

Reason:

- repeated held navigation corruption was not reproducible in bash under the same conditions where pwsh still showed corruption.

## Current status

### main issue 1: held navigation/delete corruption

Status: fixed (accepted)

What is currently true:

- prompt responsiveness is better than before
- some single-key navigation cases improved
- held Left no longer fails immediately in the same way it did at the start
- corruption still appears under long held navigation in pwsh scenarios
- the remaining corruption is still structured and escape-sequence shaped, not random
- even after browser-side deterministic CSI navigation and browser-side repeat batching, long held Left still produced visible corruption such as `DDDDDDDD[DDDDD[DD[D[DD`
- removing `PSReadLine` did not eliminate held-left corruption; a later check still produced `"[D[DDD[D"`
- the same held-left test did not reproduce in `bash`; after 20 seconds there was no corruption
- running `pwsh -NoProfile` still produced corruption such as `D[DD[DDDDD[DDD[DDDDDD`
- running the same test in basic `sh` produced literal `^[[C` sequences, which is consistent with a shell that does not provide the same interactive line-editing behavior as `bash`
- profile-based compatibility logic was removed in favor of one stable raw-leaning path plus bash recommendation
- issue 1 is considered fixed for this project scope by decision, with bash as the operational default shell

### main issue 2: cursor jumps to the middle and `vi` does not use the full screen

Status: fixed

What is currently true:

- geometry and resize behavior were improved and instrumented
- browser-side forced `scrollToBottom()` calls on output/input/resize were removed so full-screen TUIs like `vi` can control viewport and cursor positioning without client-side scroll overrides
- startup resize convergence now force-sends initial and retry resize frames, so initial PTY size no longer remains stuck at `20x80` until manual browser resize
- under bash, `stty size` and vi dimensions now converge correctly on open
- issue 2 had two sub-issues in practice:
   - incorrect initial screen size (fixed)
   - pwsh cursor hop toward mid-screen (fixed)

### main issue 3: prompt should appear immediately on open

Status: fixed (observed)

What is currently true:

- enabling prompt nudge restored prompt appearance in cases where it had regressed
- prompt/open behavior is better than during the middle of this debugging session
- prompt delay has not been observed recently in normal testing, so this issue is considered fixed unless it reappears

## End-to-end chain in this workspace

The terminal path in this project is not a single terminal. It is a chain of components that each have their own responsibilities and their own failure modes.

1. Keyboard and browser event layer
   - Implemented in [svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte](svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte)
   - Responsibilities:
     - Creates the xterm.js terminal instance
     - Observes container size and sends resize control frames
     - Opens the browser WebSocket to the playground server
     - For compatibility profiles, intercepts plain navigation keys and sends deterministic CSI sequences directly from the browser
     - Persists the selected terminal profile in local storage

2. Browser terminal page load and profile selection
   - Implemented in [svelte-playground/playground/src/routes/proxmox/terminal/+page.server.ts](svelte-playground/playground/src/routes/proxmox/terminal/+page.server.ts)
   - Responsibilities:
     - Parses `vmid`, `node`, `type`, `name`, and `profile` from the page URL
     - Validates terminal page parameters
     - Supplies the selected profile to the Svelte page

3. Playground WebSocket proxy layer
   - Implemented in [svelte-playground/playground/server/proxmoxTerminalWs.ts](svelte-playground/playground/server/proxmoxTerminalWs.ts)
   - Responsibilities:
     - Accepts browser WebSocket upgrades on `/proxmox/terminal/ws`
     - Authenticates to Proxmox
     - Opens the pve-client terminal helper
     - Maps terminal profiles to bridge options
     - Enables trace logging for diagnostics

4. Terminal bridge and session layer
   - Implemented in [pve-client/src/helpers/Terminal.ts](pve-client/src/helpers/Terminal.ts)
   - Responsibilities:
     - Opens and manages the Proxmox terminal WebSocket session
     - Bridges browser input to Proxmox stdin frames
     - Forwards Proxmox output back to the browser
     - Parses and forwards resize events
     - Applies optional compatibility transforms and tracing

5. Proxmox termproxy and guest PTY
   - Not implemented in this workspace
   - Responsibilities:
     - Accepts framed stdin and resize messages
     - Connects to the VM or container PTY
     - Delivers PTY output back over the Proxmox WebSocket

6. Guest shell and line editor
   - Not implemented in this workspace
   - Examples:
     - bash + readline
     - zsh + ZLE
     - pwsh + PSReadLine
     - fish built-in editor
   - Responsibilities:
     - Interprets control sequences
     - Maintains command-line editing state
     - Decides whether a sequence is a navigation key, a literal string, or a malformed fragment

## The main lesson

---

**All three main issues are now closed. Maintenance of this document is paused unless new terminal issues arise.**

A browser terminal is not just "xterm in a page". It is a multi-stage protocol path:

`keyboard -> browser event model -> xterm/browser terminal -> browser websocket -> app bridge -> proxmox websocket -> guest pty -> shell line editor`

Any stage can preserve, rewrite, split, delay, or misinterpret control sequences.

## What worked

The following changes produced clear improvements or solved a local sub-problem.

1. Prompt nudge re-enabled
    - Related issue: main issue 3
    - Result:
       - Restored prompt visibility after open in scenarios where the shell appeared unresponsive

2. Profile system
    - Related issues: mainly issue 1, but useful across all three
    - Result:
       - Created a controlled way to compare raw behavior against compatibility behavior without code edits
       - Reduced confusion during testing by making behavior selectable and persistent

3. Profile persistence and reset
    - Related issues: all
    - Result:
       - Made iterative testing practical across multiple containers and workloads

4. Better trace labeling and richer bridge tracing
    - Related issues: all
    - Result:
       - Made it much easier to tell which profile and code path produced a trace
       - Confirmed many failures were structured sequence failures, not generic corruption

5. Modified cursor-key simplification
    - Related issue: main issue 1
    - Result:
       - Helped with modified key forms such as Shift+Arrow leaking parameterized CSI fragments

6. Split escape-tail coalescing
    - Related issue: main issue 1
    - Result:
       - Helped for fragmented escape sequences that arrived across WebSocket frames
       - Reduced immediate corruption for some navigation-key cases

7. Browser-side deterministic plain navigation sequences for compatibility profiles
    - Related issue: main issue 1
    - Result:
       - Is the cleanest architectural direction tried so far for compatibility profiles
       - Moves the decision earlier in the chain instead of relying entirely on downstream repair
   - It improved the architecture, but by itself did not eliminate long held-left corruption in pwsh/PSReadLine

9. Browser-side batching of intercepted navigation keys
   - Related issue: main issue 1
   - Result:
   - Reduced the number of writes generated in the browser for long held keys
   - Did not eliminate long held-left corruption in pwsh/PSReadLine

10. Removing `PSReadLine` as a discriminating guest-side check
      - Related issue: main issue 1
      - Result:
         - Corruption still appeared after removing `PSReadLine`
         - This means the remaining held-left problem is not explained by `PSReadLine` alone

11. Running the same held-left test in `bash`
      - Related issue: main issue 1
      - Result:
         - No corruption after 20 seconds in the same container
         - This is the strongest evidence so far that the remaining problem is PowerShell-host-specific rather than a generic browser/LXC terminal failure

12. Running the held-left test in `pwsh -NoProfile`
      - Related issue: main issue 1
      - Result:
         - Corruption still appeared even without the normal PowerShell profile stack
         - This further weakens the hypothesis that the remaining issue is caused by profile customizations or ordinary module startup state

13. Running the same test in basic `sh`
      - Related issue: main issue 1
      - Result:
         - Produced literal `^[[C`-style output
         - This is not directly comparable to `bash` or `pwsh` because plain `sh` often does not provide the same interactive line-editing layer

8. Prompt and geometry diagnostics
    - Related issues: main issue 2 and main issue 3
    - Result:
       - Made it easier to separate startup/prompt issues from held-key corruption issues

## What did not work well enough

The following changes either failed, regressed behavior, or did not solve the problem sufficiently.

1. Assuming the problem was only Shift+Arrow or modified keys
    - Related issue: main issue 1
    - Result:
       - Too narrow
       - Held plain navigation keys turned out to be a broader and more important sub-problem

2. Treating Home/End as isolated problems
    - Related issue: main issue 1
    - Result:
       - Also too narrow
       - The corruption pattern is broader and affects multiple navigation-key families

3. Relying on a single global SS3/CSI rule
    - Related issue: main issue 1
    - Result:
       - Some guests behaved better with normalization
       - Other cases leaked `OD` or `[D`
       - A single universal rule was not robust enough

4. Repeated server-side orphan-fragment repair as the only strategy
    - Related issue: main issue 1
    - Result:
       - Helped on some local symptoms
       - Did not eliminate long held-key corruption under pwsh/PSReadLine
       - Showed diminishing returns as a primary strategy

5. Small coalescing-window tuning by itself
    - Related issue: main issue 1
    - Result:
       - Changing windows changed symptom timing but did not remove the root behavior
       - This suggests the remaining issue is not just timing-window selection

6. Browser-side deterministic CSI plus browser-side repeat batching as a complete answer
    - Related issue: main issue 1
    - Result:
       - This still failed under long held Left in pwsh-friendly mode
       - That strongly suggests the remaining failure is downstream of xterm key generation alone

7. Binary-vs-text transport framing as a complete answer
    - Related issue: main issue 1
    - Result:
       - Transport changes changed symptoms, but neither framing mode alone solved the full problem

8. Assuming the issue was a classic buffer overflow
    - Related issue: main issue 1
    - Result:
       - Evidence did not support this
       - The corruption remained patterned and terminal-sequence-specific

9. Treating the remaining held-left problem as a purely `PSReadLine`-specific bug
    - Related issue: main issue 1
    - Result:
       - The `Remove-Module PSReadLine` check did not clear the corruption
       - The remaining problem is likely lower in the path than `PSReadLine` alone

10. Treating the remaining held-left problem as shell-agnostic
      - Related issue: main issue 1
      - Result:
         - `bash` remained clean for 20 seconds under the same held-left test
         - The remaining corruption is not behaving like a generic browser terminal defect across all guest shells

11. Treating the remaining held-left problem as caused by the normal PowerShell profile only
      - Related issue: main issue 1
      - Result:
         - `pwsh -NoProfile` still reproduced the corruption
         - The remaining problem appears to be deeper in PowerShell's host/input handling than profile configuration alone

12. Treating plain `sh` as equivalent to `bash` for this comparison
      - Related issue: main issue 1
      - Result:
         - `sh` showed literal escape output, which makes it a poor apples-to-apples comparison for interactive line-editing behavior

## Likely current interpretation

The current evidence suggests that main issue 1 is not one bug. It is a cluster of related failure modes around repeated navigation input in a browser terminal path, especially when pwsh + PSReadLine is the guest editor.

The most likely contributors are:

1. mode-sensitive xterm output under repeat
2. fragmentation or delayed parsing of escape streams
3. PSReadLine sensitivity to partial or delayed navigation sequences
4. interleaving with cursor-report traffic
5. guest-side line-editor behavior that is not fully neutralized by browser-side normalization alone
6. lower-level guest terminal handling in pwsh/ConsoleHost or the PTY path, not just `PSReadLine`
7. PowerShell-specific host behavior that differs materially from bash in the same container
8. PowerShell host/input behavior that persists even in `pwsh -NoProfile`

This means the eventual solution is likely to be a combination of:

1. earlier normalization/interception for compatibility profiles
2. narrower and safer bridge-side repair
3. preserving a raw mode for guests that do not need compatibility help

### 1. Control-sequence problems were structured, not random

The observed corruption was not random noise. The recurring visible fragments were things like:

- `D`
- `[D`
- `OD`
- `[3~`
- `;1;2D`

These are all recognizable terminal navigation fragments with a missing leading `ESC` or a mismatched sequence family.

That strongly suggested protocol fragmentation, mode mismatch, or line-editor timeout behavior, not a classic buffer overflow.

### 2. CSI and SS3 are both standard sequence families

Two sequence families mattered repeatedly:

- CSI: `ESC [` followed by parameters and a final byte
- SS3: `ESC O` followed by a final byte

Examples for arrows:

- CSI Left: `ESC [ D`
- SS3 Left: `ESC O D`

These are not app-specific inventions. They are standard terminal control sequence forms inherited from VT/ANSI conventions.

### 3. The guest shell and its line editor matter a lot

The same browser and bridge can behave differently depending on the guest shell/editor combination.

Important examples:

- bash usually uses readline
- zsh uses ZLE
- pwsh uses PSReadLine

In this session, pwsh in Linux containers appeared especially sensitive to repeated navigation input and cursor-mode mismatches.

### 4. Long held-key corruption was a separate sub-problem from single-key behavior

Single navigation keypresses often worked while held-key repeats failed after a few seconds.

This pointed to a different failure mode:

- repeat-driven frame fragmentation
- late loss of `ESC`
- line editor timeout on partial escape streams
- or repeated interleaving with cursor-position response traffic

This is why main issue 1 turned out to have multiple sub-issues.

### 5. Browser-side interception is cleaner than endless server-side repair for some keys

After repeated server-side repair attempts, the most promising direction was to move plain navigation-key handling earlier in the chain.

Current implementation:

- In compatibility profiles, [svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte](svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte) intercepts unmodified navigation keys and sends deterministic CSI sequences directly.

Reason:

- This avoids relying on xterm's current cursor-mode output for the most problematic repeat cases.

## Compatibility features currently implemented

Most compatibility logic lives in [pve-client/src/helpers/Terminal.ts](pve-client/src/helpers/Terminal.ts), with profile selection in [svelte-playground/playground/server/proxmoxTerminalWs.ts](svelte-playground/playground/server/proxmoxTerminalWs.ts).

Implemented features include:

1. SS3 to CSI normalization
   - Optional
   - Can normalize all cursor keys or only selected subsets

2. Modified cursor-key simplification
   - Example: `ESC[1;2D` can be simplified to `ESC[D`

3. Split escape-tail coalescing
   - Reassembles incomplete trailing escape sequences that arrive across multiple frames

4. Orphan navigation fragment repair
   - Repair path for recent navigation traffic when fragments like `D`, `[D`, `OD`, or bracket/final bursts appear after the leading `ESC` is lost

5. Navigation repeat coalescing
   - Short idle-window batching for held navigation keys so fewer writes are sent under repeat pressure

6. Prompt nudge
   - A one-time delayed Enter to encourage a prompt to appear on shell open when guests stay visually idle

7. Single stable bridge policy (current)
   - Raw-leaning input forwarding
   - Prompt nudge retained
   - No profile-specific runtime transforms

## Current runtime policy

Runtime policy is implemented in [svelte-playground/playground/server/proxmoxTerminalWs.ts](svelte-playground/playground/server/proxmoxTerminalWs.ts).

Current policy is intentionally simple:

1. binary stdin forwarding
2. resize forwarding
3. prompt nudge enabled
4. compatibility transforms disabled by default

This keeps the runtime predictable while bash is the recommended default shell for web-terminal use.

## Why browser terminals are hard to make universal

The target environment here is LXC containers across many Linux distributions, with user-chosen shells.

That means the terminal must tolerate variation across:

- distros
- terminfo definitions
- shells
- line editors
- full-screen programs
- guest cursor-mode behavior

There is no single transform that is perfect for every guest.

The practical approach is:

1. Keep a raw path available
2. Keep runtime behavior simple and predictable by default
3. Keep trace logging available so failures are diagnosable

## Recommended engineering stance going forward

1. Treat the browser terminal as a protocol stack, not a widget
2. Prefer targeted compatibility profiles over one global rewrite path
3. Add fixes at the earliest stable layer when possible
4. Keep raw mode available for guests that already behave correctly
5. Test against multiple shells and line editors, especially pwsh + PSReadLine
6. Avoid broad repairs that can mutate ordinary user text

## Files most relevant to this topic

- [svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte](svelte-playground/playground/src/routes/proxmox/terminal/+page.svelte)
- [svelte-playground/playground/src/routes/proxmox/terminal/+page.server.ts](svelte-playground/playground/src/routes/proxmox/terminal/+page.server.ts)
- [svelte-playground/playground/server/proxmoxTerminalWs.ts](svelte-playground/playground/server/proxmoxTerminalWs.ts)
- [pve-client/src/helpers/Terminal.ts](pve-client/src/helpers/Terminal.ts)
