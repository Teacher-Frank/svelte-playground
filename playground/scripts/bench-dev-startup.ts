import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { resolve } from 'node:path';

type StartupSample = {
  run: number;
  startupMs: number;
  viteReportedMs?: number;
};

const viteEntrypoint = resolve('node_modules', 'vite', 'bin', 'vite.js');
const runs = Number(process.env.PLAYGROUND_DEV_BENCH_RUNS ?? '4');
const basePort = Number(process.env.PLAYGROUND_DEV_BENCH_BASE_PORT ?? '45173');

const toFixed = (value: number): string => value.toFixed(1);

const stripAnsi = (value: string): string => {
  // Remove CSI and OSC escape sequences without regex control chars.
  let result = '';
  let index = 0;

  while (index < value.length) {
    const char = value[index];

    if (char === '\u001b') {
      const next = value[index + 1];

      // CSI: ESC [ ... final-byte
      if (next === '[') {
        index += 2;
        while (index < value.length) {
          const code = value.charCodeAt(index);
          index += 1;
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
        }
        continue;
      }

      // OSC: ESC ] ... BEL or ESC \
      if (next === ']') {
        index += 2;
        while (index < value.length) {
          const current = value[index];
          if (current === '\u0007') {
            index += 1;
            break;
          }
          if (current === '\u001b' && value[index + 1] === '\\') {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
};

const average = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const isServerReachable = (port: number): Promise<boolean> =>
  new Promise((resolveReachable) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 750,
      },
      (res) => {
        res.resume();
        resolveReachable(true);
      }
    );

    req.on('error', () => resolveReachable(false));
    req.on('timeout', () => {
      req.destroy();
      resolveReachable(false);
    });
    req.end();
  });

const runSingle = (run: number): Promise<StartupSample> =>
  new Promise((resolveRun, rejectRun) => {
    const port = basePort + run - 1;
    const startedAt = Date.now();

    let settled = false;
    let viteReportedMs: number | undefined;
    let outputBuffer = '';
    const readinessProbe = setInterval(() => {
      if (settled) return;

      void isServerReachable(port).then((reachable) => {
        if (!reachable || settled) return;

        settled = true;
        clearTimeout(timer);
        clearInterval(readinessProbe);

        const startupMs = Date.now() - startedAt;
        child.once('exit', () => {
          resolveRun({ run, startupMs, viteReportedMs });
        });
        child.kill('SIGTERM');
      });
    }, 250);

    const child = spawn(
      process.execPath,
      [viteEntrypoint, 'dev', '--host', '127.0.0.1', '--strictPort', '--port', String(port), '--clearScreen', 'false'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PLAYGROUND_USE_MKCERT: 'false',
        },
      }
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(readinessProbe);
      child.kill('SIGTERM');
      const diagnostic = outputBuffer.trim().slice(-800);
      rejectRun(new Error(
        `Run ${run} timed out waiting for Vite readiness on port ${port}.` +
        (diagnostic ? ` Last output:\n${diagnostic}` : '')
      ));
    }, 60_000);

    const maybeFinish = (text: string) => {
      if (settled) return;

      outputBuffer = `${outputBuffer}${stripAnsi(text)}`.slice(-16_384);

      const readyMatch = outputBuffer.match(/ready in\s+([\d.]+)\s*ms/i);
      if (readyMatch) {
        viteReportedMs = Number(readyMatch[1]);
      }

      if (/\bready in\b/i.test(outputBuffer) || /Local:\s+https?:\/\//i.test(outputBuffer)) {
        settled = true;
        clearTimeout(timer);
        clearInterval(readinessProbe);

        const startupMs = Date.now() - startedAt;
        child.once('exit', () => {
          resolveRun({ run, startupMs, viteReportedMs });
        });
        child.kill('SIGTERM');
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      maybeFinish(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      maybeFinish(chunk.toString());
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readinessProbe);
      rejectRun(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readinessProbe);
      rejectRun(new Error(`Run ${run} exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
    });
  });

const main = async (): Promise<void> => {
  if (!Number.isInteger(runs) || runs < 2) {
    throw new Error('PLAYGROUND_DEV_BENCH_RUNS must be an integer >= 2.');
  }
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65000) {
    throw new Error('PLAYGROUND_DEV_BENCH_BASE_PORT must be an integer between 1024 and 65000.');
  }

  const samples: StartupSample[] = [];
  console.info(
    `[bench] measuring Vite dev startup over ${runs} runs (run 1 = cold, 2..N = warm) on base port ${basePort}.`
  );

  for (let run = 1; run <= runs; run += 1) {
    const sample = await runSingle(run);
    samples.push(sample);

    const reported = sample.viteReportedMs !== undefined ? `, vite-reported=${toFixed(sample.viteReportedMs)}ms` : '';
    console.info(`[bench] run ${run}: startup=${toFixed(sample.startupMs)}ms${reported}`);
  }

  const cold = samples[0].startupMs;
  const warmSamples = samples.slice(1).map((sample) => sample.startupMs);
  const warmAvg = average(warmSamples);

  console.info('[bench] summary');
  console.info(`[bench] cold-start: ${toFixed(cold)}ms`);
  console.info(`[bench] warm-average (${warmSamples.length} runs): ${toFixed(warmAvg)}ms`);
};

main().catch((error) => {
  console.error('[bench] failed:', error);
  process.exit(1);
});
