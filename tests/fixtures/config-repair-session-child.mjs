import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const [first, ...rest] = process.argv.slice(2);

function workerIdentity(mode, extra = {}) {
  return {
    pid: process.pid,
    processGroupId: process.pid,
    cwd: process.cwd(),
    mode,
    ...extra,
  };
}

function publish(readyPath, exitedPath, mode, extra = {}) {
  const ready = workerIdentity(mode, extra);
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ready));
  fs.renameSync(temporary, readyPath);
  process.send?.({ type: 'ready', pid: process.pid, exitedPath });
}

function publishInvalidReady(readyPath, exitedPath, mode) {
  // Keep a separate, machine-readable identity solely for independent test
  // teardown. The session driver must never consume this sidecar as ready.
  fs.writeFileSync(
    path.join(process.cwd(), 'worker-identity.json'),
    JSON.stringify(workerIdentity(mode)),
  );
  if (mode === 'no-ready') return;
  if (mode === 'bad-ready-json') {
    fs.writeFileSync(readyPath, '{"pid":');
    return;
  }
  const invalid = mode === 'bad-ready-schema'
    ? { ...workerIdentity(mode), pid: 1, processGroupId: 1 }
    : { ...workerIdentity(mode), cwd: path.dirname(process.cwd()) };
  fs.writeFileSync(readyPath, JSON.stringify(invalid));
  process.send?.({ type: 'ready', pid: process.pid, exitedPath });
}

const INPUT_EXIT_DELAY_MS = 20;
const SPLIT_PROMPT_POLL_MS = 5;
const WRAPPER_HOLD_INTERVAL_MS = 1_000;

function finite(readyPath, exitedPath, mode, lifetimeArg) {
  if (mode === 'no-ready' || mode.startsWith('bad-ready-')) {
    publishInvalidReady(readyPath, exitedPath, mode);
  } else {
    publish(readyPath, exitedPath, mode, mode === 'orphan' ? { groupChildPid: process.pid } : {});
  }
  const finish = signal => {
    if (mode === 'final-output') {
      fs.writeSync(1, 'FINAL_STDOUT_SENTINEL\n');
      fs.writeSync(2, 'FINAL_STDERR_SENTINEL\n');
    }
    fs.writeFileSync(exitedPath, JSON.stringify({ pid: process.pid, signal }));
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    if (mode === 'ignore-term') return;
    finish('SIGTERM');
  });
  process.on('SIGINT', () => finish('SIGINT'));
  if (mode === 'single-prompt' || mode === 'split-prompt') {
    const inputs = [];
    if (mode === 'split-prompt') {
      process.stdout.write('PRO');
      const releasePath = path.join(process.cwd(), 'release-second-prompt-chunk');
      const releasePoll = setInterval(() => {
        if (!fs.existsSync(releasePath)) return;
        clearInterval(releasePoll);
        process.stdout.write('MPT>');
      }, SPLIT_PROMPT_POLL_MS);
    } else {
      process.stdout.write('PROMPT>');
    }
    process.stdin.on('data', chunk => {
      inputs.push(chunk.toString());
      fs.writeFileSync(path.join(process.cwd(), 'input-observed.json'), JSON.stringify(inputs));
      process.stdout.write('\nnoise while processing first answer\n');
      setTimeout(() => finish('input'), INPUT_EXIT_DELAY_MS);
    });
  }
  setTimeout(() => finish('lifetime'), Number(lifetimeArg ?? '5000'));
}

if (first === '--worker') {
  const [readyPath, exitedPath, mode, ...args] = rest;
  if (mode === 'cli') {
    const [cliPath, ...cliArgs] = args;
    publish(readyPath, exitedPath, mode, { cliPath: path.resolve(cliPath) });
    process.argv = [process.execPath, cliPath, ...cliArgs];
    await import(pathToFileURL(cliPath).href);
  } else {
    finite(readyPath, exitedPath, mode, args[0]);
  }
} else {
  const [readyPath, exitedPath, mode, ...args] = [first, ...rest];
  if (!readyPath || !exitedPath || !mode) {
    throw new Error('usage: config-repair-session-child.mjs READY EXITED MODE [ARGS]');
  }
  if (mode === 'final-output' || mode === 'hold-wrapper') process.on('SIGTERM', () => {});
  // Signal listeners alone do not keep Node alive after the worker exits.
  if (mode === 'hold-wrapper') setInterval(() => {}, WRAPPER_HOLD_INTERVAL_MS);
  const child = spawn(process.execPath, [
    selfPath, '--worker', readyPath, exitedPath, mode, ...args,
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.once('message', message => {
    if (message?.type === 'ready' && mode === 'orphan') process.exit(0);
  });
  child.once('error', error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (mode !== 'orphan' && mode !== 'hold-wrapper') {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    }
  });
}
