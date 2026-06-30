/**
 * POST /proxmox/upload — Upload files to VM/container via Proxmox APIs.
 *
 * Accepts multipart form data with fields:
 *   - vmid: number
 *   - node: string
 *   - type: 'vm' | 'container'
 *   - path: string (target directory inside VM/container, default: /tmp/upload)
 *   - files: File[] (multiple files via multipart)
 *
 * For VMs: uses QEMU agent_file_write (requires guest agent)
 * For LXC: uses exec + base64 decode
 *
 * Response: per-file results with success/error status
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import Busboy from 'busboy';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readFileToBuffer(req: IncomingMessage): Promise<{ fields: Record<string, string>; files: Array<{ fieldname: string; filename: string; buffer: Buffer }> }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });

    const fields: Record<string, string> = {};
    const files: Array<{ fieldname: string; filename: string; buffer: Buffer }> = [];

    busboy.on('field', (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on('file', (_fieldname, file, filenameBuffer) => {
      // Busboy 1.x file event third arg is a FileInfo object: { filename, encoding, mime }
      // In some versions it may be a Buffer or string.
      let filename: string | undefined;
      if (typeof filenameBuffer === 'string') {
        filename = filenameBuffer;
      } else if (typeof filenameBuffer === 'object' && filenameBuffer !== null) {
        const fb = filenameBuffer as Record<string, unknown>;
        // FileInfo has .filename (may be Buffer or string)
        if (fb.filename !== undefined) filename = String(fb.filename);
        // Legacy fallback: Buffer.toString
        else if (typeof (filenameBuffer as Buffer)['toString'] === 'function') filename = (filenameBuffer as Buffer).toString('utf8');
      }
      if (!filename) {
        console.log(`[upload] Warning: empty filename received, skipping file`);
        file.resume(); // drain the stream
        return;
      }

      console.log(`[upload] Received file: ${filename}`);

      const chunks: Buffer[] = [];

      file.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      file.on('end', () => {
        files.push({
          fieldname: _fieldname,
          filename,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    busboy.on('finish', () => {
      resolve({ fields, files });
    });

    busboy.on('error', (err) => {
      reject(err);
    });

    req.pipe(busboy);
  });
}

async function ensureDirectoryExists(
  nodeApi: import('pve-client').NodeScopedAPI,
  node: string,
  vmid: number,
  type: 'vm' | 'container',
  path: string,
): Promise<void> {
  const mkdirCmd = ['mkdir', '-p', path];

  if (type === 'vm') {
    const execResult = await nodeApi.qemu.vmid(vmid).agent.exec({
      command: mkdirCmd,
    });

    // Poll for completion
    for (let i = 0; i < 10; i++) {
      const status = await nodeApi.qemu.vmid(vmid).agent.exec_status({
        $query: { pid: execResult.pid },
      });
      if (status.exited) {
        if (status.exitcode !== 0 && status['err-data']) {
          throw new Error(`Failed to create directory ${path}: ${status['err-data']}`);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else {
    const execResult = await nodeApi.lxc.id(vmid).exec({
      cmd: mkdirCmd,
      timeout: 10,
    });

    const status = await nodeApi.lxc.id(vmid).exec_status({
      $query: { pid: execResult.pid },
    });

    if (status.exitcode !== 0 && status['err-data']) {
      throw new Error(`Failed to create directory ${path}: ${status['err-data']}`);
    }
  }
}

async function writeFileToVm(
  nodeApi: import('pve-client').NodeScopedAPI,
  node: string,
  vmid: number,
  filePath: string,
  fileBuffer: Buffer,
): Promise<void> {
  const base64Content = fileBuffer.toString('base64');
  const filename = filePath.split('/').pop() ?? filePath;

  console.log(`[upload:vm] Writing file: ${filename} (${fileBuffer.length} bytes) to ${filePath}`);

  // agent_file_write has size limits (~500MB max depending on version)
  // For large files, we'd need chunking, but MVP handles reasonable sizes
  try {
    // Proxmox agent/file-write `encode` param (default=1) controls a base64-encoding step:
    //   encode=1: Proxmox base64-encodes `content`, then QEMU decodes → yields raw bytes
    //   encode=0: Proxmox passes `content` through untouched to QEMU, which still decodes → content MUST be pre-encoded
    // We pre-base64 encode and set encode=0 so our encoding is the one that QEMU decodes.
    // CRITICAL: Must use numeric 0 (not boolean false) because Vite SSR transforms serialize
    // booleans inconsistently, and Proxmox rejects "true"/"false" strings (expects "0"/"1").
    // encode: 0 tells QEMU to pass content through as-is (we pre-base64 encoded).
    // Numeric 0 is required — boolean false gets mangled by bundler serialization.
    const result = await nodeApi.qemu.vmid(vmid).agent.file_write({
      file: filePath,
      content: base64Content,
      encode: 0,
    });
    console.log(`[upload:vm] file_write returned:`, JSON.stringify(result).substring(0, 200));

    // file_write is async on the guest agent - wait briefly for the file to appear
    // then verify with a read check
    let retries = 0;
    const maxRetries = 30;
    while (retries < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      retries++;
      try {
        // agent/file-read is a GET endpoint — params go in $query
        // encode=1 tells Proxmox to base64-encode the content before returning it,
        // so we get a clean JSON response with the content field as a base64 string.
        // Without encode=1, Proxmox returns raw binary which decodes to garbage (~22 bytes).
        const readResult = await nodeApi.qemu.vmid(vmid).agent.file_read({
          $query: { file: filePath, encode: 1 },
        });
        // Proxmox file-read with encode=1 returns: { content: "<base64>", "bytes-read": N }
        // pve-client unwraps { data: ... }, so readResult is the inner object directly.
        console.log(`[upload:vm] file_read result keys: ${Object.keys(readResult as object).join(',')}`);
        const base64 = (readResult as { content?: string })?.content ?? '';
        const readContent = Buffer.from(base64, 'base64');
        if (Number(readContent.length) === fileBuffer.length) {
          console.log(`[upload:vm] Verified ${filename} on VM (${readContent.length} bytes)`);
          // QEMU guest agent writes as root and doesn't set executable bit.
          // Run chmod +x to make shell scripts executable (best-effort — skip if agent/exec flaky).
          // Only apply to .sh, .bash, .py, .pl, .rb, or files without extension.
          if (/\.(sh|bash|py|pl|rb)$/.test(filename) || !filename.includes('.')) {
            try {
              const chmodResult = await nodeApi.qemu.vmid(vmid).agent.exec({
                command: ['chmod', '+x', filePath],
              });
              for (let c = 0; c < 10; c++) {
                const chmodStatus = await nodeApi.qemu.vmid(vmid).agent.exec_status({
                  $query: { pid: chmodResult.pid },
                });
                if (chmodStatus.exited) {
                  if (chmodStatus.exitcode === 0) {
                    console.log(`[upload:vm] chmod +x ${filename}`);
                  }
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
            } catch (chmodErr: unknown) {
              console.log(`[upload:vm] Warning: chmod +x failed for ${filePath}: ${(chmodErr as Error).message}`);
            }
          }
          return;
        }
        console.log(
          `[upload:vm] Retry ${retries}/${maxRetries} for ${filename}: read ${readContent.length} bytes, expected ${fileBuffer.length}`
        );
      } catch (err: unknown) {
        const msg = (err as Error).message;
        console.log(`[upload:vm] Retry ${retries}/${maxRetries} for ${filename}: ${msg}`);
        // File not ready yet - keep waiting
      }
    }

    throw new Error(`Timed out waiting for ${filename} to appear on VM after ${maxRetries}s`);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    console.log(`[upload:vm] Error writing ${filename}:`, msg);
    throw err;
  }
}

async function writeFileToContainer(
  nodeApi: import('pve-client').NodeScopedAPI,
  node: string,
  vmid: number,
  filePath: string,
  fileBuffer: Buffer,
): Promise<void> {
  const base64Content = fileBuffer.toString('base64');

  // Use base64 decode to write file safely
  const cmd = ['bash', '-c', `echo '${base64Content}' | base64 -d > '${filePath}'`];

  const execResult = await nodeApi.lxc.id(vmid).exec({
    cmd,
    timeout: 60, // 60s timeout for larger files
  });

  const status = await nodeApi.lxc.id(vmid).exec_status({
    $query: { pid: execResult.pid },
  });

  if (status.exitcode !== 0) {
    throw new Error(`Failed to write file: exit code ${status.exitcode}${status['err-data'] ? `: ${status['err-data']}` : ''}`);
  }
}

export async function handleProxmoxUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const { fields, files } = await readFileToBuffer(req);

    const vmidStr = fields.vmid;
    const node = fields.node;
    const type = fields.type;
    const targetDir = fields.path || '/tmp/upload';

    if (!vmidStr || !node || !type) {
      sendJson(res, 400, { error: 'Missing vmid, node, or type fields' });
      return;
    }

    const vmid = parseInt(vmidStr, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      sendJson(res, 400, { error: 'vmid must be a positive integer' });
      return;
    }

    if (type !== 'vm' && type !== 'container') {
      sendJson(res, 400, { error: `Invalid type: ${type}` });
      return;
    }

    if (files.length === 0) {
      sendJson(res, 400, { error: 'No files uploaded' });
      return;
    }

    // Limit: max 10 files per upload batch
    if (files.length > 10) {
      sendJson(res, 400, { error: 'Maximum 10 files per upload batch' });
      return;
    }

    // Create PVE client
    const baseUrl = process.env.PVE_BASE_URL;
    const username = process.env.PVE_USERNAME?.trim() || undefined;
    const password = process.env.PVE_PASSWORD?.trim() || undefined;
    const realm = process.env.PVE_REALM?.trim() || 'pam';
    const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

    if (!baseUrl) {
      sendJson(res, 500, { error: 'PVE_BASE_URL not configured' });
      return;
    }

    if (!username || !password) {
      sendJson(res, 500, { error: 'PVE_USERNAME and PVE_PASSWORD required' });
      return;
    }

    const { Agent } = await import('node:https');
    const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

    const { Client } = await import('pve-client');
    const client = new Client({
      baseUrl,
      username,
      password,
      realm,
      agent,
    });
    await client.login();

    const nodeApi = client.api.nodes.get(node);

    // Ensure target directory exists (skip if directory creation fails — may already exist)
    try {
      await ensureDirectoryExists(nodeApi, node, vmid, type, targetDir);
    } catch (err: unknown) {
      // Directory creation via agent/exec is flaky — directory may already exist
      // Continue and let file-write fail with a clear error if needed
      console.log(`[upload] Warning: mkdir failed for ${targetDir}: ${(err as Error).message}`);
    }

    // Process each file
    const results: Array<{
      filename: string;
      path: string;
      size: number;
      success: boolean;
      error?: string;
    }> = [];

    for (const file of files) {
      const targetPath = `${targetDir}/${file.filename}`;

      try {
        if (type === 'vm') {
          await writeFileToVm(nodeApi, node, vmid, targetPath, file.buffer);
        } else {
          await writeFileToContainer(nodeApi, node, vmid, targetPath, file.buffer);
        }

        results.push({
          filename: file.filename,
          path: targetPath,
          size: file.buffer.length,
          success: true,
        });
      } catch (err: unknown) {
        results.push({
          filename: file.filename,
          path: targetPath,
          size: file.buffer.length,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    sendJson(res, 200, { results });
  } catch (err: unknown) {
    sendJson(res, 500, {
      error: `Upload failed: ${(err as Error).message}`,
      results: [],
    });
  }
}

export function attachProxmoxUploadHandler(
  httpServer: import('node:http').Server,
): void {
  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/proxmox/upload')) return;

    void handleProxmoxUpload(req, res);
  });
}
