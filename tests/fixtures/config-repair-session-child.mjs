import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const [first, ...rest] = process.argv.slice(2);

function publish(readyPath, exitedPath, mode, extra = {}) {
  const ready = {
    pid: process.pid,
    processGroupId: process.pid,
    cwd: process.cwd(),
    mode,
    ...extra,
  };
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ready));
  fs.renameSync(temporary, readyPath);
  process.send?.({ type: 'ready', pid: process.pid, exitedPath });
}

const INPUT_EXIT_DELAY_MS = 20;

function finite(readyPath, exitedPath, mode, lifetimeArg) {
  publish(readyPath, exitedPath, mode, mode === 'orphan' ? { groupChildPid: process.pid } : {});
  const finish = signal => {
    if (mode === 'final-output') {
      fs.writeSync(1, 'FINAL_STDOUT_SENTINEL\n');
      fs.writeSync(2, 'FINAL_STDERR_SENTINEL\n');
    }
    fs.writeFileSync(exitedPath, JSON.stringify({ pid: process.pid, signal }));
    process.exit(0);
  };
  process.on('SIGTERM', () => finish('SIGTERM'));
  process.on('SIGINT', () => finish('SIGINT'));
  if (mode === 'single-prompt') {
    const inputs = [];
    process.stdout.write('PROMPT>');
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
  if (mode === 'final-output') process.on('SIGTERM', () => {});
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
    if (mode !== 'orphan') {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    }
  });
}
