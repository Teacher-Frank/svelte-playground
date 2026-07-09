<script lang="ts">
  import { onMount } from 'svelte';
  import type { RFBCredentials } from '@novnc/novnc';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  type VncStatusState = 'connecting' | 'credentials' | 'connected' | 'warning' | 'error';
  let statusText = $state('Connecting to GUI...');
  let statusState = $state<VncStatusState>('connecting');
  // Separate overlay message so the header bar stays short.
  let overlayMessage = $state<string | null>(null);
  let requestedCredentialTypes = $state<string[]>([]);
  let credentialUsername = $state('');
  let credentialPassword = $state('');
  let credentialTarget = $state('');
  let credentialError = $state<string | null>(null);
  let rfbSession: import('@novnc/novnc').default | undefined = $state();
  let reconnectInProgress = $state(false);
  let autoCredentialsSubmitted = $state(false);
  let reconnectSession: (() => Promise<void>) | undefined;

  $effect(() => {
    // Seed defaults from server-provided ticket credentials once per page load
    // without overwriting user edits during later credential prompts.
    if (!credentialUsername && data.vncUsername) {
      credentialUsername = data.vncUsername;
    }
    if (!credentialPassword && data.vncPassword) {
      credentialPassword = data.vncPassword;
    }
  });

  const showOverlay = $derived(statusState !== 'connected');
  const showCredentialPrompt = $derived(statusState === 'credentials');

  const requiresUsername = $derived(requestedCredentialTypes.includes('username'));

  const requiresPassword = $derived(requestedCredentialTypes.length === 0 || requestedCredentialTypes.includes('password'));
  const requiresTarget = $derived(requestedCredentialTypes.includes('target'));

  const workloadIdentity = $derived(
    data.name ? `${data.name} (${data.vmid})` : `${data.vmid}`,
  );

  const workloadLabel = $derived(
    `${data.type === 'vm' ? 'VM' : 'Container'} ${workloadIdentity} on ${data.node}`,
  );

  const describeSecurityFailure = (status: number, reason?: string): string => {
    // Keep browser-facing messaging concise and safe. Detailed traces stay server-side.
    const cleanedReason = reason?.replace(/[\r\n]+/g, ' ').trim();
    const shortReason = cleanedReason ? cleanedReason.slice(0, 180) : undefined;

    if (status === 1 || status === 2) {
      return `Authentication was rejected (code ${status})${shortReason ? `: ${shortReason}` : ''}.`;
    }

    return `Security negotiation failed (code ${status})${shortReason ? `: ${shortReason}` : ''}.`;
  };

  onMount(() => {
    let disposed = false;
    let facade: { disconnect: () => void } | undefined;
    let connectedAtLeastOnce = false;
    let connectWatchdog: ReturnType<typeof setTimeout> | undefined;
    let staleWatchdog: ReturnType<typeof setTimeout> | undefined;

    const clearConnectWatchdog = () => {
      if (connectWatchdog) {
        clearTimeout(connectWatchdog);
        connectWatchdog = undefined;
      }
    };

    const clearStaleWatchdog = () => {
      if (staleWatchdog) {
        clearTimeout(staleWatchdog);
        staleWatchdog = undefined;
      }
    };

    // When stale timer fires, we can't just assume "no GUI" — the desktop might
    // be idle. Sample the noVNC canvas: if pixels are mostly black, it's likely
    // a headless VM. If there's visible content, the desktop is just idle.
    const checkAndWarnStale = () => {
      if (disposed || statusState === 'error') return;
      const canvas = containerEl?.querySelector('canvas');
      if (!canvas) return;

      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        if (w === 0 || h === 0) return;

        // Sample multiple 16×16 tiles across the framebuffer so we catch
        // content whether it's at the top (boot text), center (desktop),
        // or anywhere else.
        let nonblack = 0;
        const offsets = [
          { x: 0, y: 0 }, // top-left
          { x: Math.floor(w / 2), y: 0 }, // top-center
          { x: 0, y: Math.floor(h / 2) }, // middle-left
          { x: Math.floor(w / 2), y: Math.floor(h / 2) }, // center
          { x: Math.floor(w / 4), y: Math.floor(h / 4) }, // quarter
        ];

        for (const o of offsets) {
          const sx = Math.max(0, Math.min(o.x, w - 16));
          const sy = Math.max(0, Math.min(o.y, h - 16));
          const sample = ctx.getImageData(sx, sy, 16, 16);
          for (let i = 0; i < sample.data.length; i += 4) {
            const r = sample.data[i];
            const g = sample.data[i + 1];
            const b = sample.data[i + 2];
            if (r > 30 || g > 30 || b > 30) nonblack++;
          }
        }
        // If any sampled pixels have significant brightness, it's an idle desktop.
        if (nonblack > 0) return;

        statusText = 'No GUI desktop detected';
        overlayMessage =
          'This VM appears to be running without a graphical desktop. The VNC framebuffer has not updated since connection. Use the Terminal button on the workload page for live console output.';
        statusState = 'warning';
      } catch {
        // Canvas sampling failed — don't warn, leave as connected.
      }
    };

    const openRfbSession = async () => {
      if (!containerEl) return;

      const { default: RFB } = await import('@novnc/novnc');

      // Connect to the local ws bridge instead of talking to Proxmox directly.
      // This keeps credentials/tickets server-side and avoids browser header limits.
      const wsUrl =
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` +
        `/proxmox/vnc/ws?upstream=${encodeURIComponent(data.upstreamWsUrl)}` +
        `&vmid=${encodeURIComponent(data.vmid)}`;

      // Replace any previous session first so reconnect attempts cannot leave
      // multiple RFB instances racing to update the same DOM container.
      rfbSession?.disconnect();

      // Do not send empty credentials during initial handshake. In bridge mode,
      // an empty password can trigger immediate target-side disconnects.
      const initialCredentials: RFBCredentials = {};
      if (typeof data.vncUsername === 'string' && data.vncUsername.trim().length > 0) {
        initialCredentials.username = data.vncUsername.trim();
      }
      if (typeof data.vncPassword === 'string' && data.vncPassword.length > 0) {
        initialCredentials.password = data.vncPassword;
      }

      const rfbOptions = Object.keys(initialCredentials).length > 0
        ? { shared: true, credentials: initialCredentials }
        : { shared: true };

      const rfb = new RFB(containerEl, wsUrl, rfbOptions);
      rfbSession = rfb;
      facade = {
        disconnect: () => rfb.disconnect(),
      };

      clearConnectWatchdog();
      connectWatchdog = setTimeout(() => {
        if (disposed || statusState === 'connected') return;
        statusText =
          'Could not connect to the GUI websocket bridge. Check bridge availability and upstream endpoint.';
        statusState = 'error';
      }, 8000);

      // Default to scale-to-fit so GUI sessions stay usable on smaller displays.
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.focusOnClick = true;
      rfb.background = '#111827';

      rfb.addEventListener('connect', () => {
        if (disposed) return;
        connectedAtLeastOnce = true;
        clearConnectWatchdog();
        statusText = 'Connected';
        statusState = 'connected';
        autoCredentialsSubmitted = false;
        requestedCredentialTypes = [];
        credentialError = null;

        // Start stale framebuffer detection — headless VMs (e.g., Debian without
        // X11/desktop) connect fine but their QEMU VGA framebuffer never updates
        // after the initial boot splash. The first framebuffer arrives *before*
        // the 'connect' event, so we start the timer here. Subsequent 'update'
        // events reset it. During credential/security negotiation we clear the
        // timer so auth pauses don't trigger false warnings.
        clearStaleWatchdog();
        staleWatchdog = setTimeout(checkAndWarnStale, 8000);

        const onFramebufferUpdate = () => {
          if (disposed || statusState === 'warning' || statusState === 'error') return;
          clearStaleWatchdog();
          staleWatchdog = setTimeout(checkAndWarnStale, 8000);
        };
        rfb.addEventListener('update', onFramebufferUpdate);
      });

      rfb.addEventListener('disconnect', (event: Event) => {
        if (disposed) return;
        if (reconnectInProgress) return;
        clearConnectWatchdog();
        clearStaleWatchdog();
        // Preserve more specific credential/security states instead of
        // overwriting them with a generic disconnect warning.
        if (statusState === 'credentials' || statusState === 'error') return;
        const detail = (event as CustomEvent<{ clean?: boolean }>).detail;

        if (!connectedAtLeastOnce) {
          statusText =
            'GUI websocket bridge closed before connection was established. Verify bridge service and target socket.';
          statusState = 'error';
          return;
        }

        statusText = detail?.clean ? 'Disconnected. Refresh to reconnect.' : 'Connection dropped unexpectedly.';
        statusState = 'warning';
      });

      rfb.addEventListener('credentialsrequired', (event: Event) => {
        if (disposed) return;
        // Clear stale timer — no framebuffer updates during credential exchange.
        clearStaleWatchdog();
        const detail = (event as CustomEvent<{ types?: string[] }>).detail;
        requestedCredentialTypes = Array.isArray(detail?.types) ? detail.types : [];

        // Native Proxmox VNC issues short-lived ticket credentials server-side.
        // If available, submit them automatically so operators are not asked to
        // enter a password they never see.
        if (!autoCredentialsSubmitted && typeof data.vncPassword === 'string' && data.vncPassword.length > 0) {
          const autoCredentials: RFBCredentials = { password: data.vncPassword };
          if (data.vncUsername && data.vncUsername.trim().length > 0) {
            autoCredentials.username = data.vncUsername.trim();
          }

          autoCredentialsSubmitted = true;
          statusText = 'Submitting VNC session credentials...';
          statusState = 'connecting';
          credentialError = null;

          try {
            rfb.sendCredentials(autoCredentials);
            return;
          } catch {
            // Fall through to explicit prompt if automatic submission fails.
          }
        }

        statusText =
          typeof data.vncPassword === 'string' && data.vncPassword.length > 0
            ? 'GUI session authentication failed. Click Reconnect to request a new Proxmox session ticket.'
            : 'Server requested credentials. Use the guest VNC password configured with vncpasswd.';
        statusState = typeof data.vncPassword === 'string' && data.vncPassword.length > 0 ? 'warning' : 'credentials';
        credentialError = null;
      });

      rfb.addEventListener('securityfailure', (event: Event) => {
        if (disposed) return;
        clearConnectWatchdog();
        clearStaleWatchdog();
        const detail = (event as CustomEvent<{ status: number; reason?: string }>).detail;
        const code = Number.isFinite(detail.status) ? detail.status : -1;
        statusText = describeSecurityFailure(code, detail.reason);

        // Force explicit operator retry after security failure because continuing
        // with a half-negotiated session can create ambiguous auth loops.
        // Most bridge-backed and native sessions here are password-only unless
        // the server explicitly requests additional fields.
        requestedCredentialTypes = ['password'];
        if (typeof data.vncPassword === 'string' && data.vncPassword.length > 0) {
          credentialError = null;
          statusText = 'Proxmox VNC ticket authentication failed. Click Reconnect to request a fresh ticket.';
          statusState = 'warning';
        } else {
          credentialError = statusText;
          statusState = 'credentials';
        }
      });

      /* ── Clipboard support ─────────────────────────────────────── */
      // Client → guest: intercept paste inside the VNC container, forward to VM
      const handlePaste = (event: ClipboardEvent) => {
        if (statusState !== 'connected') return;
        const text = event.clipboardData?.getData('text/plain');
        if (text && text.length > 0) {
          event.preventDefault();
          rfb.sendClipboard(text);
        }
      };
      containerEl.addEventListener('paste', handlePaste);

      // Guest → client: receive clipboard text pushed from the VM
      const handleClipboardReceived = (event: Event) => {
        if (disposed) return;
        const detail = (event as CustomEvent).detail as { text?: string };
        const text = detail?.text;
        if (typeof text === 'string' && text.length > 0) {
          navigator.clipboard?.writeText(text).catch(() => {
            // Clipboard write may fail in background tabs — silently degrade.
          });
        }
      };
      rfb.addEventListener('clipboard', handleClipboardReceived);
    };

    reconnectSession = async () => {
      if (disposed || reconnectInProgress) return;
      reconnectInProgress = true;
      clearStaleWatchdog();
      statusText = 'Reconnecting GUI session...';
      statusState = 'connecting';
      credentialError = null;
      requestedCredentialTypes = [];

      try {
        await openRfbSession();
      } catch (error: unknown) {
        if (disposed) return;
        statusText = `Reconnect failed: ${error instanceof Error ? error.message : String(error)}`;
        statusState = 'error';
      } finally {
        reconnectInProgress = false;
      }
    };

    void openRfbSession().catch((error: unknown) => {
      if (disposed) return;
      statusText = `Failed to initialize GUI: ${error instanceof Error ? error.message : String(error)}`;
      statusState = 'error';
    });

    return () => {
      disposed = true;
      clearConnectWatchdog();
      clearStaleWatchdog();
      reconnectSession = undefined;
      facade?.disconnect();
      rfbSession = undefined;
    };
  });

  const handleReconnectClick = () => {
    if (!reconnectSession) return;
    void reconnectSession();
  };

  const submitCredentials = (event: SubmitEvent) => {
    event.preventDefault();

    if (!rfbSession) {
      credentialError = 'Connection is not ready yet. Please wait and try again.';
      return;
    }

    // For LXC bridge-backed sessions we keep login password-only unless the
    // backend explicitly requests a username.
    const credentials: RFBCredentials = {};
    if (requiresUsername && credentialUsername.trim().length > 0) {
      credentials.username = credentialUsername.trim();
    }
    if (credentialPassword.length > 0) {
      credentials.password = credentialPassword;
    }
    if (requiresTarget && credentialTarget.trim().length > 0) {
      credentials.target = credentialTarget.trim();
    }

    if (requiresPassword && !credentials.password) {
      credentialError = 'Password is required.';
      return;
    }

    credentialError = null;
    statusText = 'Submitting credentials...';
    statusState = 'connecting';
    try {
      rfbSession.sendCredentials(credentials);
    } catch (err) {
      statusState = 'credentials';
      credentialError = err instanceof Error
        ? `Could not submit credentials: ${err.message}`
        : 'Could not submit credentials.';
    }
  };
</script>

<svelte:head>
  <title>GUI Console — {workloadLabel}</title>
</svelte:head>

<div class="vnc-page">
  <header class="vnc-header">
    <span class="workload-label">{workloadLabel}</span>
    <span class="status-text" class:status-error={statusState === 'error'}>{statusText}</span>
  </header>

  <div class="vnc-container" bind:this={containerEl}>
    {#if showOverlay}
      <!-- Keep a central status surface while connecting/failing so users get
           immediate, readable feedback instead of a blank canvas area. -->
      <div class="vnc-overlay" class:error={statusState === 'error'}>
        {#if showCredentialPrompt}
          <div class="overlay-title">GUI Login Required</div>
          <div class="overlay-text">{overlayMessage ?? statusText}</div>

          <form class="credential-form" onsubmit={submitCredentials}>
            {#if requiresUsername}
              <label>
                Username
                <input bind:value={credentialUsername} autocomplete="username" />
              </label>
            {/if}

            {#if requiresPassword}
              <label>
                Password
                <input type="password" bind:value={credentialPassword} autocomplete="current-password" />
              </label>
            {/if}

            {#if requiresTarget}
              <label>
                Target
                <input bind:value={credentialTarget} autocomplete="off" />
              </label>
            {/if}

            {#if credentialError}
              <p class="credential-error">{credentialError}</p>
            {/if}

            <button type="submit">Continue</button>
          </form>
        {:else}
          <div class="overlay-title">GUI Console</div>
          <div class="overlay-text">{overlayMessage ?? statusText}</div>
          {#if statusState === 'warning' || statusState === 'error'}
            <!-- Provide explicit in-place reconnect so operators do not need a full refresh. -->
            <button
              type="button"
              class="reconnect-btn"
              onclick={handleReconnectClick}
              disabled={reconnectInProgress}
            >
              {reconnectInProgress ? 'Reconnecting...' : 'Reconnect'}
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  :global(body),
  :global(html) {
    margin: 0;
    height: 100%;
  }

  .vnc-page {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 0;
  }

  .vnc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0.9rem;
    background: #1e293b;
    border-bottom: 1px solid #334155;
    flex-shrink: 0;
    font-size: 0.88rem;
  }

  .workload-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e2e8f0;
  }

  .status-text {
    color: #93c5fd;
    font-size: 0.82rem;
    white-space: nowrap;
  }

  .status-text.status-error {
    color: #fca5a5;
  }

  .vnc-container {
    flex: 1;
    position: relative;
    min-height: 0;
    overflow: hidden;
  }

  .vnc-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: radial-gradient(circle at center, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.92));
    text-align: center;
    padding: 1.5rem;
  }

  .vnc-overlay.error {
    background: radial-gradient(circle at center, rgba(69, 10, 10, 0.72), rgba(30, 12, 12, 0.92));
  }

  .overlay-title {
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #dbeafe;
  }

  .overlay-text {
    font-size: 0.92rem;
    color: #e2e8f0;
    max-width: 52rem;
    line-height: 1.45;
  }

  .credential-form {
    display: grid;
    gap: 0.65rem;
    min-width: min(26rem, 88vw);
    margin-top: 0.25rem;
  }

  .credential-form label {
    display: grid;
    gap: 0.3rem;
    text-align: left;
    font-size: 0.82rem;
    color: #cbd5e1;
  }

  .credential-form input {
    width: 100%;
    box-sizing: border-box;
    background: #0b1220;
    border: 1px solid #475569;
    border-radius: 0.45rem;
    color: #e2e8f0;
    font-size: 0.9rem;
    padding: 0.55rem 0.6rem;
  }

  .credential-form button {
    justify-self: end;
    background: #3b82f6;
    border: 1px solid #60a5fa;
    border-radius: 0.45rem;
    color: #eff6ff;
    cursor: pointer;
    font-weight: 600;
    padding: 0.45rem 0.8rem;
  }

  .credential-form button:hover {
    background: #2563eb;
  }

  .reconnect-btn {
    margin-top: 0.35rem;
    background: #0ea5e9;
    border: 1px solid #38bdf8;
    border-radius: 0.45rem;
    color: #f0f9ff;
    cursor: pointer;
    font-weight: 600;
    padding: 0.45rem 0.8rem;
  }

  .reconnect-btn:hover:not(:disabled) {
    background: #0284c7;
  }

  .reconnect-btn:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .credential-error {
    margin: 0;
    color: #fca5a5;
    font-size: 0.82rem;
  }

  .vnc-container :global(canvas) {
    max-width: 100%;
  }
</style>
