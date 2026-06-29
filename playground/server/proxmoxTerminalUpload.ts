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
      const filename = filenameBuffer.name;
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

  // agent_file_write has size limits (~500MB max depending on version)
  // For large files, we'd need chunking, but MVP handles reasonable sizes
  await nodeApi.qemu.vmid(vmid).agent.file_write({
    file: filePath,
    content: base64Content,
    encode: true,
  });
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
