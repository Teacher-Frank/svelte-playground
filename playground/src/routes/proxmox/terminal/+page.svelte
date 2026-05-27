<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  const workloadIdentity = $derived(
    data.name ? `${data.name} (${data.vmid})` : `${data.vmid}`,
  );

  const workloadLabel = $derived(
    `${data.type === 'vm' ? 'VM' : 'Container'} ${workloadIdentity} on ${data.node}`,
  );

  onMount(() => {
    let disposed = false;
    let term: import('@xterm/xterm').Terminal | undefined;
    let ws: WebSocket | undefined;
    let fitAddon: import('@xterm/addon-fit').FitAddon | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let fitFrame = 0;
    let lastSentSize = '';
    let resizeSyncAttempts = 0;
    let sizeResendTimer: ReturnType<typeof setTimeout> | undefined;
    const convergenceTimers: Array<ReturnType<typeof setTimeout>> = [];

    // Fallback: If xterm fit underestimates initial size, compute rows/cols from cell metrics and force resize.
    // This is critical for correct PTY geometry on first open, especially in browser layouts with late sizing.
    // Safe to remove if upstream xterm.js or layout always reports correct size on first paint.
    const maybeApplyFallbackGeometry = () => {
      if (!term || !containerEl) return;

      // On some startup paths xterm fit can stick at conservative defaults
      // (for example 80x20) until an actual viewport resize event occurs.
      // Derive cols/rows from container pixels + measured cell metrics to
      // force the initial PTY geometry to converge without manual resize.
      const metrics = (term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: {
                  width?: number;
                  height?: number;
                };
              };
            };
          };
        };
      })._core?._renderService?.dimensions?.css?.cell;

      const cellWidth = metrics?.width ?? 0;
      const cellHeight = metrics?.height ?? 0;
      if (!(cellWidth > 0) || !(cellHeight > 0)) return;

      const estimatedCols = Math.floor(containerEl.clientWidth / cellWidth);
      const estimatedRows = Math.floor(containerEl.clientHeight / cellHeight);
      if (!(estimatedCols > 0) || !(estimatedRows > 0)) return;

      if (estimatedCols === term.cols && estimatedRows === term.rows) return;

      // Apply and forward a deterministic fallback size when xterm fit lags.
      term.resize(estimatedCols, estimatedRows);
    };

    // Sends a resize control frame to the backend. If 'force' is true, always sends even if cols/rows are unchanged.
    // This is essential for startup convergence: early frames can be dropped or deduped, so retries must be sent.
    const sendResizeFrame = (force = false) => {
      if (!term || ws?.readyState !== WebSocket.OPEN) return;

      if (term.cols <= 0 || term.rows <= 0) return;

      const sizeFrame = `${term.cols}:${term.rows}`;
      if (!force && sizeFrame === lastSentSize) return;

      // Send structured control frames instead of prefix-encoded text.
      // This avoids collisions where user input could look like a resize frame.
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      lastSentSize = sizeFrame;
    };

    // Syncs xterm fit, applies fallback, and sends resize. 'forceResizeFrame' ensures backend always receives frame.
    const syncTerminalSize = (forceResizeFrame = false) => {
      fitAddon?.fit();
      maybeApplyFallbackGeometry();
      sendResizeFrame(forceResizeFrame);
    };

    const scheduleTerminalSizeSync = () => {
      if (disposed) return;

      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (!disposed) syncTerminalSize();
      });
    };

    // On open, repeatedly force-send resize frames to backend to guarantee PTY geometry converges.
    // This is needed because some browser/WS/Proxmox paths drop or ignore early control frames.
    const scheduleInitialResizeResends = () => {
      if (disposed) return;
      if (resizeSyncAttempts >= 8) return;

      resizeSyncAttempts += 1;
      sizeResendTimer = setTimeout(() => {
        if (disposed) return;
        // Force-send startup resize retries even if cols/rows are unchanged.
        // This protects against early dropped control frames.
        syncTerminalSize(true);
        scheduleInitialResizeResends();
      }, 250);
    };

    const scheduleConvergenceResync = () => {
      // Some host/layout combinations report a conservative initial fit.
      // Recheck geometry over a short startup window without user resizing.
      const delaysMs = [50, 150, 300, 600, 1000, 1600, 2400];
      for (const delayMs of delaysMs) {
        const timer = setTimeout(() => {
          if (disposed) return;
          scheduleTerminalSizeSync();
        }, delayMs);
        convergenceTimers.push(timer);
      }
    };

    const onWindowResize = () => {
      scheduleTerminalSizeSync();
    };

    const onWindowFocus = () => {
      scheduleTerminalSizeSync();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      scheduleTerminalSizeSync();
      scheduleConvergenceResync();
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);

      if (disposed || !containerEl) return;

      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'monospace, "Courier New"',
        scrollback: 5000,
        scrollOnUserInput: true,
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerEl);
      term.focus();
      scheduleTerminalSizeSync();
      scheduleConvergenceResync();

      if ('fonts' in document && document.fonts?.ready) {
        void document.fonts.ready.then(() => {
          if (!disposed) scheduleTerminalSizeSync();
        });
      }

      resizeObserver = new ResizeObserver(() => {
        scheduleTerminalSizeSync();
      });
      resizeObserver.observe(containerEl);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('focus', onWindowFocus);
      document.addEventListener('visibilitychange', onVisibilityChange);

      const wsUrl =
        `/proxmox/terminal/ws` +
        `?vmid=${encodeURIComponent(data.vmid)}` +
        `&node=${encodeURIComponent(data.node)}` +
        `&type=${encodeURIComponent(data.type)}`;

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      // On websocket open, force an initial resize frame and start convergence retries.
      // This ensures the guest PTY is sized correctly even if the first frame is dropped or ignored.
      ws.onopen = () => {
        lastSentSize = '';
        resizeSyncAttempts = 0;
        term?.focus();
        // Force the first open-time resize frame in case early sizing races.
        syncTerminalSize(true);
        scheduleInitialResizeResends();
      };

      ws.onmessage = ({ data: payload }) => {
        if (payload instanceof ArrayBuffer) {
          // Do not force viewport scroll on terminal output.
          // Full-screen apps (e.g. vi/vim) manage cursor/viewport themselves.
          term?.write(new Uint8Array(payload));
        } else {
          term?.write(String(payload));
        }

        // Keep geometry converged when output starts before final layout settles.
        if (resizeSyncAttempts < 3) scheduleTerminalSizeSync();
      };

      ws.onerror = () => {
        term?.writeln('\r\n\x1b[31mWebSocket connection error\x1b[0m');
      };

      ws.onclose = (ev) => {
        term?.writeln(`\r\n\x1b[33mConnection closed (${ev.code})\x1b[0m`);
      };

      const inputEncoder = new TextEncoder();

      const sendBinaryInput = (input: string) => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        ws.send(inputEncoder.encode(input));
      };

      term.onData((input) => {
        if (!term) return;
        sendBinaryInput(input);
      });
    })();

    return () => {
      disposed = true;
      if (sizeResendTimer) clearTimeout(sizeResendTimer);
      for (const timer of convergenceTimers) clearTimeout(timer);
      cancelAnimationFrame(fitFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ws?.close();
      term?.dispose();
    };
  });
</script>

<svelte:head>
  <title>Terminal — {workloadLabel}</title>
</svelte:head>

<div class="terminal-page">
  <header class="terminal-header">
    <span class="workload-label">{workloadLabel}</span>
  </header>

  <div class="terminal-container" bind:this={containerEl}></div>
</div>

<style>
  @import '@xterm/xterm/css/xterm.css';

  :global(body) {
    margin: 0;
    height: 100%;
  }

  :global(html) {
    height: 100%;
  }

  .terminal-page {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    background: #1e1e1e;
    color: #ccc;
    min-height: 0;
  }

  .terminal-header {
    display: flex;
    align-items: center;
    padding: 0.5rem 1rem;
    background: #2d2d2d;
    border-bottom: 1px solid #444;
    flex-shrink: 0;
    font-size: 0.9rem;
  }

  .workload-label {
    font-family: monospace;
    color: #ddd;
  }

  .terminal-container {
    flex: 1;
    padding: 0;
    overflow: hidden;
    /* xterm.js needs a sized container to initialise correctly */
    min-height: 0;
  }

  /* Let xterm fill the container; viewport geometry is managed by xterm itself. */
  .terminal-container :global(.xterm) {
    height: 100% !important;
  }
</style>
