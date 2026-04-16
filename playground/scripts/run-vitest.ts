import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const vitestTempDir = 'C:\\temp';
const vitestEntrypoint = resolve('node_modules', 'vitest', 'vitest.mjs');

mkdirSync(vitestTempDir, { recursive: true });

const child = spawn(process.execPath, [vitestEntrypoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEMP: vitestTempDir,
    TMP: vitestTempDir,
    TMPDIR: vitestTempDir,
  },
});

child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});