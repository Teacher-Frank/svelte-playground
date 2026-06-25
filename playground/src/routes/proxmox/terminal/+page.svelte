<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();

  // Terminal error state (for provisioning errors like missing serial console)
  let terminalError: string | undefined = $state();
  let terminalErrorType: 'serial' | 'not-found' | 'not-running' | 'other' = $state('other');

  // Upload dialog state
  let uploadDialogOpen = $state(false);
  let uploadTargetDir = $state('/tmp/upload');
  let selectedFiles: File[] = $state([]);
  let uploadInProgress = $state(false);
  let uploadProgress = $state<{ filename: string; status: 'pending' | 'uploading' | 'done' | 'error'; size?: number; error?: string }[]>([]);
  let uploadAvailable: boolean | null = $state(null);
  let uploadReason: string | undefined = $state();
  let uploadAvailableSpace: number | null = $state(null);

  const workloadIdentity = $derived(
    data.name ? `${data.name} (${data.vmid})` : `${data.vmid}`,
  );

  const workloadLabel = $derived(
    `${data.type === 'vm' ? 'VM' : 'Container'} ${workloadIdentity} on ${data.node}`,
  );

  const uploadDisabled = $derived(uploadInProgress || (uploadAvailable === false));
  const uploadTooltip = $derived(
    uploadAvailable === false
      ? uploadReason || 'Upload unavailable'
      : 'Upload files to this workload',
  );

  const maxUploadSize = $derived(
    uploadAvailableSpace !== null ? Math.max(0, uploadAvailableSpace - 100_000_000) : Infinity,
  );

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  async function checkAgentStatus(): Promise<void> {
    try {
      const url = `/proxmox/agent-status?vmid=${data.vmid}&node=${data.node}&type=${data.type}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        uploadAvailable = false;
        uploadReason = 'Failed to check agent status';
        return;
      }
      const result = await resp.json();
      uploadAvailable = result.available;
      uploadReason = result.reason;
      uploadAvailableSpace = result.availableSpace;
    } catch {
      uploadAvailable = false;
      uploadReason = 'Network error checking agent status';
    }
  }

  function openUploadDialog(): void {
    uploadDialogOpen = true;
    selectedFiles = [];
    uploadProgress = [];
    uploadInProgress = false;
    checkAgentStatus();
  }

  function closeUploadDialog(): void {
    uploadDialogOpen = false;
    selectedFiles = [];
    uploadProgress = [];
    uploadInProgress = false;
  }

  function triggerFileInput(): void {
    fileInputEl?.click();
  }

  function handleFileSelect(event: Event): void {
    const target = event.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);

    // Filter out files that exceed max upload size
    const validFiles = files.filter((file) => {
      if (maxUploadSize !== Infinity && file.size > maxUploadSize) {
        console.warn(`File ${file.name} exceeds available space limit`);
        return false;
      }
      return true;
    });

    selectedFiles = validFiles;
    uploadProgress = validFiles.map((file) => ({
      filename: file.name,
      status: 'pending',
      size: file.size,
    }));

    // Reset file input so the same file can be selected again
    target.value = '';
  }

  async function startUpload(): Promise<void> {
    if (!selectedFiles.length || uploadInProgress) return;

    uploadInProgress = true;
    const fd = new FormData();
    fd.append('vmid', String(data.vmid));
    fd.append('node', data.node);
    fd.append('type', data.type);
    fd.append('path', uploadTargetDir);

    for (const file of selectedFiles) {
      fd.append('files', file, file.name);
    }

    // Update progress to uploading for all files
    uploadProgress = uploadProgress.map((p) => ({ ...p, status: 'uploading' as const }));

    try {
      const resp = await fetch('/proxmox/upload', {
        method: 'POST',
        body: fd,
      });

      const result = await resp.json();

      if (!resp.ok) {
        uploadProgress = uploadProgress.map((p) => ({
          ...p,
          status: 'error' as const,
          error: result.error || 'Upload failed',
        }));
        return;
      }

      // Map results back to progress
      if (Array.isArray(result.results)) {
        uploadProgress = result.results.map((r: { filename: string; success: boolean; error?: string; size: number }) => ({
          filename: r.filename,
          status: r.success ? 'done' : 'error',
          size: r.size,
          error: r.error,
        }));
      }
    } catch (err) {
      uploadProgress = uploadProgress.map((p) => ({
        ...p,
        status: 'error' as const,
        error: (err as Error).message,
      }));
    } finally {
      uploadInProgress = false;
    }
  }

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
    //
    // Why we access private xterm internals (accepts as-cast per P4a exception):
    // - xterm.js has no public API for measuring rendered cell dimensions before fit stabilizes.
    // - FitAddon.fit() uses the same private metrics but doesn't expose them.
    // - Without this fallback, initial PTY geometry sticks at defaults (80x24) on slow-rendered pages,
    //   causing the guest shell to wrap incorrectly until the first explicit resize event.
    // - The cast chain uses optional chaining (?.) at every level — if xterm.js ever renames _core
    //   or _renderService, this degrades to a no-op return rather than a runtime crash (P4a safety).
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
      const socket = ws;
      ws.onopen = () => {
        lastSentSize = '';
        resizeSyncAttempts = 0;
        term?.focus();
        // Force the first open-time resize frame in case early sizing races.
        syncTerminalSize(true);
        scheduleInitialResizeResends();
        // Send an initial newline to nudge the shell to display the prompt immediately,
        // matching the LXC terminal behavior (some guests hang waiting for input on first connect).
        socket.send(new TextEncoder().encode('\n'));
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
        if (ev.code === 4001) {
          // Provisioning error (serial not configured, VM not found, etc).
          // Classify the error type and show a friendly overlay.
          const reason = ev.reason || '';
          terminalError = reason;
          
          const lowerReason = reason.toLowerCase();
          if (/serial/i.test(lowerReason)) {
            terminalErrorType = 'serial';
          } else if (/not found/i.test(lowerReason)) {
            terminalErrorType = 'not-found';
          } else if (/not running/i.test(lowerReason)) {
            terminalErrorType = 'not-running';
          }
          
          term?.dispose();
        } else {
          term?.writeln(`\r\n\x1b[33mConnection closed (${ev.code})\x1b[0m`);
        }
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
    <div class="terminal-actions">
      <button
        class="upload-btn"
        disabled={uploadDisabled}
        title={uploadTooltip}
        onclick={() => uploadDialogOpen ? closeUploadDialog() : openUploadDialog()}
      >
        →_ Upload
      </button>
    </div>
  </header>

  {#if terminalError}
    <div class="terminal-error-overlay">
      <div class="terminal-error-card" role="alert">
        <div class="error-icon">
          {#if terminalErrorType === 'serial'}
            ⚠️
          {:else if terminalErrorType === 'not-found'}
            🔍
          {:else if terminalErrorType === 'not-running'}
            ⏸️
          {:else}
            ❌
          {/if}
        </div>
        <h2>
          {#if terminalErrorType === 'serial'}
            Terminal Not Available
          {:else if terminalErrorType === 'not-found'}
            Virtual Machine Not Found
          {:else if terminalErrorType === 'not-running'}
            Virtual Machine Not Running
          {:else}
            Terminal Connection Failed
          {/if}
        </h2>
        <p class="error-message">{terminalError}</p>
        {#if terminalErrorType === 'serial'}
          <div class="error-action-hint">
            💡 <strong>What to do:</strong> A serial port needs to be added to this VM's configuration in Proxmox (e.g., <code>serial0: socket</code>). Contact the admin to enable terminal access.
          </div>
        {:else if terminalErrorType === 'not-found'}
          <div class="error-action-hint">
            💡 <strong>What to do:</strong> The VM may have been deleted or the ID is incorrect. Verify the VM exists in Proxmox.
          </div>
        {:else if terminalErrorType === 'not-running'}
          <div class="error-action-hint">
            💡 <strong>What to do:</strong> Start the VM from the Proxmox web interface orhetzner panel, then try again.
          </div>
        {/if}
        <div class="error-admin-contact">
          Need help? Contact your Proxmox administrator.
        </div>
      </div>
    </div>
  {:else}
    <div class="terminal-container" bind:this={containerEl}></div>
  {/if}

  {#if uploadDialogOpen}
    <div
      class="upload-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Upload files"
      onclick={() => !uploadInProgress && closeUploadDialog()}
      onkeydown={(e) => {
        if (e.key === 'Escape' && !uploadInProgress) closeUploadDialog();
      }}
      tabindex="-1"
    >
      <!-- tabindex makes this content surface interactive to satisfy a11y — the parent overlay has the real click handler to close -->
      <div
        class="upload-dialog"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {}}
        role="document"
        tabindex="-1"
      >
        <div class="upload-dialog-header">
          <h3>Upload to {workloadLabel}</h3>
          <button class="close-btn" onclick={closeUploadDialog}>&times;</button>
        </div>

        {#if uploadAvailable === false}
          <div class="upload-warning">
            ⚠️ {uploadReason || 'Upload not available'}
          </div>
        {/if}

        {#if uploadAvailableSpace !== null}
          <div class="upload-space">
            Available: {formatSize(uploadAvailableSpace)}
          </div>
        {/if}

        <label class="upload-label">
          Target directory
          <input
            type="text"
            bind:value={uploadTargetDir}
            disabled={uploadInProgress}
            class="upload-path-input"
          />
        </label>

        <div class="upload-actions">
          <button
            class="select-files-btn"
            disabled={uploadDisabled}
            onclick={triggerFileInput}
          >
            Select Files...
          </button>

          <button
            class="upload-go-btn"
            disabled={uploadDisabled || selectedFiles.length === 0}
            onclick={startUpload}
          >
            Upload {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}
          </button>
        </div>

        <input
          bind:this={fileInputEl}
          type="file"
          multiple
          class="hidden-input"
          onchange={handleFileSelect}
        />

        {#if uploadProgress.length > 0}
          <div class="upload-progress">
            {#each uploadProgress as file (file.filename)}
              <div class="file-row">
                <span class="file-name">{file.filename}</span>
                <span class="file-size">{file.size !== undefined ? formatSize(file.size) : ''}</span>
                <span class="file-status">
                  {#if file.status === 'pending'}
                    ⏳ Queued
                  {:else if file.status === 'uploading'}
                    ⬆️ Uploading
                  {:else if file.status === 'done'}
                    ✓ Done
                  {:else if file.status === 'error'}
                    ✗ {file.error || 'Failed'}
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
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
    justify-content: space-between;
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

  .terminal-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .upload-btn {
    background: #4a4a4a;
    color: #ddd;
    border: 1px solid #555;
    padding: 0.3rem 0.7rem;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.15s;
  }

  .upload-btn:hover:not(:disabled) {
    background: #5a5a5a;
  }

  .upload-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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

  /* Upload overlay */
  .upload-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .upload-dialog {
    background: #2d2d2d;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 1.5rem;
    min-width: 420px;
    max-width: 600px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .upload-dialog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .upload-dialog-header h3 {
    margin: 0;
    font-size: 1rem;
    color: #eee;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #888;
    font-size: 1.4rem;
    cursor: pointer;
    line-height: 1;
    padding: 0 0.2rem;
  }

  .close-btn:hover {
    color: #ccc;
  }

  .upload-warning {
    background: #3d2d2d;
    border: 1px solid #5a3d3d;
    color: #e08080;
    padding: 0.6rem 0.8rem;
    border-radius: 4px;
    margin-bottom: 0.8rem;
    font-size: 0.9rem;
  }

  .upload-space {
    color: #8ab88a;
    font-size: 0.85rem;
    margin-bottom: 0.8rem;
  }

  .upload-label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
    color: #aaa;
  }

  .upload-path-input {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #ddd;
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.9rem;
  }

  .upload-path-input:disabled {
    opacity: 0.5;
  }

  .upload-actions {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .select-files-btn,
  .upload-go-btn {
    background: #4a4a4a;
    color: #ddd;
    border: 1px solid #555;
    padding: 0.4rem 0.8rem;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.15s;
  }

  .select-files-btn:hover:not(:disabled),
  .upload-go-btn:hover:not(:disabled) {
    background: #5a5a5a;
  }

  .upload-go-btn:not(:disabled) {
    background: #3d6b3d;
    border-color: #4a8a4a;
  }

  .upload-go-btn:not(:disabled):hover {
    background: #4a8a4a;
  }

  .select-files-btn:disabled,
  .upload-go-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .hidden-input {
    display: none;
  }

  .upload-progress {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .file-row {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    font-size: 0.85rem;
    padding: 0.2rem 0;
  }

  .file-name {
    flex: 1;
    color: #ddd;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    color: #888;
    min-width: 60px;
    text-align: right;
  }

  .file-status {
    min-width: 80px;
    text-align: right;
  }

  /* Terminal error overlay */
  .terminal-error-overlay {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: #1e1e1e;
  }

  .terminal-error-card {
    background: #2d2d2d;
    border: 1px solid #593;
    border-left: 4px solid #c90;
    border-radius: 6px;
    padding: 2rem;
    max-width: 560px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .terminal-error-card h2 {
    margin: 0 0 1rem 0;
    font-size: 1.25rem;
    color: #ddd;
    font-weight: 600;
  }

  .error-icon {
    font-size: 2.5rem;
    margin-bottom: 1rem;
    line-height: 1;
  }

  .error-message {
    margin: 0 0 1.5rem 0;
    color: #ccc;
    line-height: 1.6;
    font-size: 0.95rem;
  }

  .error-action-hint {
    background: #36362a;
    border: 1px solid #4a3f20;
    border-radius: 4px;
    padding: 1rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
    line-height: 1.5;
    color: #c0b090;
  }

  .error-action-hint code {
    background: #4a4a3a;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.85rem;
  }

  .error-admin-contact {
    font-size: 0.85rem;
    color: #888;
    text-align: center;
    padding-top: 0.5rem;
    border-top: 1px solid #444;
  }
</style>
