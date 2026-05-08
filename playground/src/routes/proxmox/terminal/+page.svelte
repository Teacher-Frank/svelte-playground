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

    const onResize = () => {
      fitAddon?.fit();
      if (ws?.readyState === WebSocket.OPEN && term) {
        ws.send(`R:${term.cols}:${term.rows}`);
      }
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
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerEl);
      term.focus();
      term.writeln('\x1b[90mConnecting to terminal...\x1b[0m');
      fitAddon.fit();

      const wsUrl =
        `/proxmox/terminal/ws` +
        `?vmid=${encodeURIComponent(data.vmid)}` +
        `&node=${encodeURIComponent(data.node)}` +
        `&type=${encodeURIComponent(data.type)}`;

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        term?.focus();
        ws!.send(`R:${term!.cols}:${term!.rows}`);
        // Trigger an immediate shell prompt for guests that only render it after input.
        ws!.send('\r');
      };

      ws.onmessage = ({ data: payload }) => {
        if (payload instanceof ArrayBuffer) {
          term?.write(new Uint8Array(payload));
        } else {
          term?.write(String(payload));
        }
      };

      ws.onerror = () => {
        term?.writeln('\r\n\x1b[31mWebSocket connection error\x1b[0m');
      };

      ws.onclose = (ev) => {
        term?.writeln(`\r\n\x1b[33mConnection closed (${ev.code})\x1b[0m`);
      };

      term.onData((input) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(input);
      });

      window.addEventListener('resize', onResize);
    })();

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
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

  /* Let xterm fill the container and keep viewport scrollable for scrollback. */
  .terminal-container :global(.xterm),
  .terminal-container :global(.xterm-viewport) {
    height: 100% !important;
  }

  .terminal-container :global(.xterm-viewport) {
    overflow-y: auto !important;
    scrollbar-gutter: stable;
  }
</style>
