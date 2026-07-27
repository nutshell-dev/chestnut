#!/usr/bin/env node
/**
 * Phase 1203 Step D: 真实多进程 ownership race child fixture。
 *
 * 用 node:fs 原语实现 candidate→active / active→retired rename 协议
 * （仲裁单位 = rename syscall；本 fixture 证 OS 级单 winner）。
 *
 * usage: node ownership-race-child.mjs <chestnutDir> <barrierDir> <commit|recover>
 * stdout 协议（每行一条）：
 *   winner <pid> <token>            commit rename 成功
 *   loser <pid> <winnerPid>         commit collision（已写 candidate outcome.json）
 *   retired <pid> <oldToken>        stale retire rename 成功
 *   retire_lost <pid> <oldToken>    retire 竞争失败（含 active 已被移走）
 *   owner_alive <pid> <ownerPid>    active owner 仍活（不应发生 → exit 3）
 *   timeout <pid>                   barrier 超时（exit 2）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const [chestnutDir, barrierDir, mode] = process.argv.slice(2);
const BARRIER_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForGo() {
  fs.writeFileSync(path.join(barrierDir, `ready-${process.pid}`), String(process.pid));
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!fs.existsSync(path.join(barrierDir, 'go'))) {
    if (Date.now() > deadline) {
      console.log(`timeout ${process.pid}`);
      process.exit(2);
    }
    await sleep(5);
  }
}

function ownerRecord(token) {
  return JSON.stringify({
    schema_version: 1,
    attempt_id: `attempt-${process.pid}`,
    owner_token: token,
    pid: process.pid,
    process_start_time: 'unknown',
    workspace_root: chestnutDir,
    created_at: new Date().toISOString(),
  }, null, 2);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commit() {
  const token = `token-${process.pid}`;
  const candidate = path.join(chestnutDir, 'watchdog', 'candidates', `attempt-${process.pid}`);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'owner.json'), ownerRecord(token));
  const active = path.join(chestnutDir, 'watchdog', 'active');
  try {
    fs.renameSync(candidate, active);
    console.log(`winner ${process.pid} ${token}`);
  } catch {
    const owner = JSON.parse(fs.readFileSync(path.join(active, 'owner.json'), 'utf-8'));
    fs.writeFileSync(
      path.join(candidate, 'outcome.json'),
      JSON.stringify({ outcome: 'lost', winner: owner.pid }),
    );
    console.log(`loser ${process.pid} ${owner.pid}`);
  }
}

function recover() {
  const active = path.join(chestnutDir, 'watchdog', 'active');
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(active, 'owner.json'), 'utf-8'));
  } catch {
    // active 已被其他 reclaimer 移走
    console.log(`retire_lost ${process.pid} gone`);
    commit();
    return;
  }
  if (alive(owner.pid)) {
    console.log(`owner_alive ${process.pid} ${owner.pid}`);
    process.exit(3);
  }
  const retired = path.join(chestnutDir, 'watchdog', 'retired', owner.owner_token);
  try {
    fs.mkdirSync(path.dirname(retired), { recursive: true });
    fs.renameSync(active, retired);
    console.log(`retired ${process.pid} ${owner.owner_token}`);
  } catch {
    console.log(`retire_lost ${process.pid} ${owner.owner_token}`);
  }
  commit();
}

await waitForGo();
if (mode === 'commit') commit();
else recover();
