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

    const sendResizeFrame = () => {
      if (!term || ws?.readyState !== WebSocket.OPEN) return;

      if (term.cols <= 0 || term.rows <= 0) return;

      const sizeFrame = `${term.cols}:${term.rows}`;
      if (sizeFrame === lastSentSize) return;

      // Send structured control frames instead of prefix-encoded text.
      // This avoids collisions where user input could look like a resize frame.
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      lastSentSize = sizeFrame;
    };

    const syncTerminalSize = () => {
      fitAddon?.fit();
      term?.scrollToBottom();
      sendResizeFrame();
    };

    const scheduleTerminalSizeSync = () => {
      if (disposed) return;

      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (!disposed) syncTerminalSize();
      });
    };

    const scheduleInitialResizeResends = () => {
      if (disposed) return;
      if (resizeSyncAttempts >= 3) return;

      resizeSyncAttempts += 1;
      sizeResendTimer = setTimeout(() => {
        if (disposed) return;
        scheduleTerminalSizeSync();
        scheduleInitialResizeResends();
      }, 250);
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

      if ('fonts' in document && document.fonts?.ready) {
        void document.fonts.ready.then(() => {
          if (!disposed) scheduleTerminalSizeSync();
        });
      }

      resizeObserver = new ResizeObserver(() => {
        scheduleTerminalSizeSync();
      });
      resizeObserver.observe(containerEl);

      const wsUrl =
        `/proxmox/terminal/ws` +
        `?vmid=${encodeURIComponent(data.vmid)}` +
        `&node=${encodeURIComponent(data.node)}` +
        `&type=${encodeURIComponent(data.type)}`;

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        lastSentSize = '';
        resizeSyncAttempts = 0;
        term?.focus();
        syncTerminalSize();
        scheduleInitialResizeResends();
      };

      ws.onmessage = ({ data: payload }) => {
        if (payload instanceof ArrayBuffer) {
          term?.write(new Uint8Array(payload), () => {
            term?.scrollToBottom();
          });
        } else {
          term?.write(String(payload), () => {
            term?.scrollToBottom();
          });
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
        term?.scrollToBottom();
        sendBinaryInput(input);
      });
    })();

    return () => {
      disposed = true;
      if (sizeResendTimer) clearTimeout(sizeResendTimer);
      cancelAnimationFrame(fitFrame);
      resizeObserver?.disconnect();
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
