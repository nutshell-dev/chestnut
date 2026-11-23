import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [readyPath, exitedPath, cwd, lifetimeArg] = process.argv.slice(2);
if (!readyPath || !exitedPath || !cwd) {
  throw new Error('usage: resource-retention-child.mjs READY EXITED CWD [LIFETIME_MS]');
}
const lifetimeMs = Number(lifetimeArg ?? '5000');
const childSource = `
  const fs = require('node:fs');
  const [readyPath, exitedPath, cwd, lifetime] = process.argv.slice(1);
  const finish = () => {
    fs.writeFileSync(exitedPath, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
    process.exit(0);
  };
  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
  process.send?.({ type: 'ready', pid: process.pid, cwd: process.cwd() });
  setTimeout(finish, Number(lifetime));
`;
const child = spawn(process.execPath, [
  '-e', childSource, readyPath, exitedPath, cwd, String(lifetimeMs),
], {
  cwd,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.once('message', message => {
  if (message?.type !== 'ready') return;
  const ready = {
    wrapperPid: process.pid,
    processGroupId: process.pid,
    groupChildPid: child.pid,
    cwd: path.resolve(cwd),
    child: message,
  };
  fs.writeFileSync(readyPath, JSON.stringify(ready));
  process.stdout.write(`${JSON.stringify(ready)}\n`, () => process.exit(0));
});
child.once('error', error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
setTimeout(() => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}, Math.min(lifetimeMs + 1000, 2000)).unref();
