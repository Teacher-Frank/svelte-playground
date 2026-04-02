import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const vitestTempDir = resolve('.vitest', 'tmp');
mkdirSync(vitestTempDir, { recursive: true });

const child = spawn(
	process.execPath,
	[resolve('node_modules', 'vitest', 'vitest.mjs'), ...process.argv.slice(2)],
	{
		stdio: 'inherit',
		env: {
			...process.env,
			TEMP: vitestTempDir,
			TMP: vitestTempDir
		}
	}
);

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});