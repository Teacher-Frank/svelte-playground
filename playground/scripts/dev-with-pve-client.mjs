import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = resolve(scriptDir, '..');
const pveClientRoot = resolve(playgroundRoot, '..', '..', 'pve-client');
const children = [];
let shuttingDown = false;

function start(name, command, cwd) {
	const child = spawn(command, {
		stdio: 'inherit',
		shell: true,
		cwd,
		env: process.env
	});

	children.push(child);

	child.on('exit', (code, signal) => {
		if (shuttingDown) return;

		if (signal) {
			shutdown(1, `${name} exited from signal ${signal}`);
			return;
		}

		if (code && code !== 0) {
			shutdown(code, `${name} exited with code ${code}`);
			return;
		}

		shutdown(0);
	});

	child.on('error', (error) => {
		if (shuttingDown) return;
		shutdown(1, `${name} failed to start: ${error.message}`);
	});
}

function shutdown(exitCode = 0, reason) {
	if (shuttingDown) return;
	shuttingDown = true;

	if (reason) {
		console.error(reason);
	}

	for (const child of children) {
		if (!child.killed) {
			child.kill('SIGTERM');
		}
	}

	setTimeout(() => {
		for (const child of children) {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
		}
		process.exit(exitCode);
	}, 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('pve-client build:watch', 'npm run build:watch', pveClientRoot);
start('playground dev', 'npm run dev', playgroundRoot);
