<script lang="ts">
  export interface UploadFileProgress {
    filename: string;
    status: 'pending' | 'uploading' | 'done' | 'error';
    size?: number;
    error?: string;
  }

  let {
    workloadLabel,
    workloadVmid,
    workloadNode,
    workloadTypeIsVm = false,
    onClose,
  }: {
    workloadLabel: string;
    workloadVmid: string | number;
    workloadNode: string;
    workloadTypeIsVm?: boolean;
    onClose: () => void;
  } = $props();

  let fileInputEl: HTMLInputElement | undefined = $state();

  // Upload dialog state
  let uploadTargetDir = $state('/tmp/upload');
  let selectedFiles: File[] = $state([]);
  let uploadInProgress = $state(false);
  let uploadProgress: UploadFileProgress[] = $state([]);
  let uploadAvailable: boolean | null = $state(null);
  let uploadReason: string | undefined = $state();
  let uploadAvailableSpace: number | null = $state(null);

  const uploadDisabled = $derived(uploadInProgress || (uploadAvailable === false));

  const maxUploadSize = $derived(
    uploadAvailableSpace !== null ? Math.max(0, uploadAvailableSpace - 100_000_000) : Infinity,
  );

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function resetState(): void {
    selectedFiles = [];
    uploadProgress = [];
    uploadInProgress = false;
    uploadAvailable = null;
    uploadReason = undefined;
    uploadAvailableSpace = null;
  }

  async function checkAgentStatus(): Promise<void> {
    try {
      const url = `/proxmox/agent-status?vmid=${workloadVmid}&node=${workloadNode}&type=${workloadTypeIsVm ? 'vm' : 'container'}`;
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

  function openDialog(): void {
    resetState();
    checkAgentStatus();
  }

  function closeDialog(): void {
    resetState();
    onClose();
  }

  function triggerFileInput(): void {
    fileInputEl?.click();
  }

  function handleFileSelect(event: Event): void {
    const target = event.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);

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

    target.value = '';
  }

  async function startUpload(): Promise<void> {
    if (!selectedFiles.length || uploadInProgress) return;

    uploadInProgress = true;
    const fd = new FormData();
    fd.append('vmid', String(workloadVmid));
    fd.append('node', workloadNode);
    fd.append('type', workloadTypeIsVm ? 'vm' : 'container');
    fd.append('path', uploadTargetDir);

    for (const file of selectedFiles) {
      fd.append('files', file, file.name);
    }

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

  $effect(() => {
    openDialog();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="upload-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Upload files"
  onclick={() => !uploadInProgress && closeDialog()}
  onkeydown={(e) => {
    if (e.key === 'Escape' && !uploadInProgress) closeDialog();
  }}
  tabindex="-1"
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="upload-dialog" onclick={(e) => e.stopPropagation()} role="document">
    <div class="upload-dialog-header">
      <h3>Upload to {workloadLabel}</h3>
      <button class="close-btn" onclick={closeDialog}>&times;</button>
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

    {#if workloadTypeIsVm}
      <div class="upload-notice">
        ℹ️ Files are uploaded as root. <code>sudo</code> is required to modify or move them.
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

<style>
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

  .upload-notice {
    background: #2d353d;
    border: 1px solid #3d4d5a;
    color: #88b8e0;
    padding: 0.6rem 0.8rem;
    border-radius: 4px;
    margin-bottom: 0.8rem;
    font-size: 0.85rem;
  }

  .upload-notice code {
    background: #333a40;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-family: var(--font-mono);
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
</style>
