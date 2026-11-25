#!/usr/bin/env node
/**
 * Phase 1203 Step D: 真实多进程 ownership race child fixture。
 *
 * 用 node:fs 原语实现 candidate→active / active→retired rename 协议
 * （仲裁单位 = rename syscall；本 fixture 证 OS 级单 winner）。
 *
 * usage: node ownership-race-child.mjs <chestnutDir> <barrierDir> <commit|recover|admit-stale|admit-latest> [payloadJson]
 *   recover 模式下 expectedOwnerJson 是父级提供的旧 generation owner record（attempt_id/owner_token/pid），
 *   用于防迟到 reclaimer 误动 fresh active；与生产 retireOwnership 的 expected 检查等价。
 * stdout 协议（每行一条）：
 *   winner <pid> <token>            commit rename 成功
 *   loser <pid> <winnerPid>         commit collision（已写 candidate outcome.json）
 *   retired <pid> <oldToken>        stale retire rename 成功
 *   retire_lost <pid> <oldToken>    retire 竞争失败（含 active 已被移走）
 *   rejected <pid> [windowId]       bounded admission 未获得固定预算 slot
 *   admitted <pid> <windowId> <attemptId>  有界后继 admission 成功
 *   timeout <pid>                   barrier 超时（exit 2）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const [chestnutDir, barrierDir, mode, expectedOwnerJson] = process.argv.slice(2);
const expectedOwner = mode === 'recover' && expectedOwnerJson ? JSON.parse(expectedOwnerJson) : null;
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

function admissionId(windowId, slot) {
  const legacy = `${windowId}-candidate-${slot}`;
  if (Buffer.byteLength(legacy, 'utf8') <= 96) return legacy;
  return `ca2-${createHash('sha256').update(JSON.stringify([windowId, slot])).digest('hex')}`;
}

function admitSuccessor() {
  const windows = path.join(chestnutDir, 'watchdog', 'recovery', 'windows');
  const staleOwner = mode === 'admit-stale' && expectedOwnerJson
    ? JSON.parse(expectedOwnerJson)
    : null;
  let predecessor;
  let generation;
  let selectedId;
  if (staleOwner) {
    predecessor = { kind: 'attempt', id: staleOwner.attempt_id };
    const parent = JSON.parse(fs.readFileSync(
      path.join(windows, staleOwner.recovery_window_id, 'window.json'), 'utf8'));
    generation = parent.generation + 1;
  } else {
    const latestId = fs.readdirSync(windows)
      .filter((entry) => !entry.startsWith('.'))
      .map((windowId) => ({
        windowId,
        seed: JSON.parse(fs.readFileSync(path.join(windows, windowId, 'window.json'), 'utf8')),
      }))
      .sort((a, b) => a.seed.generation - b.seed.generation || a.windowId.localeCompare(b.windowId))
      .at(-1).windowId;
    const winnerPath = path.join(windows, latestId, 'winner.json');
    const closedPath = path.join(windows, latestId, 'closed.json');
    if (!fs.existsSync(winnerPath) && !fs.existsSync(closedPath)) {
      selectedId = latestId;
    } else {
      const latestSeed = JSON.parse(fs.readFileSync(path.join(windows, latestId, 'window.json'), 'utf8'));
      generation = latestSeed.generation + 1;
      predecessor = fs.existsSync(winnerPath)
        ? { kind: 'attempt', id: JSON.parse(fs.readFileSync(winnerPath, 'utf8')).attemptId }
        : { kind: 'window', id: latestId };
    }
  }

  if (predecessor) {
    const boundedId = `rw2-${createHash('sha256')
      .update(JSON.stringify([predecessor.kind, predecessor.id])).digest('hex')}`;
    const legacyId = `recovery-after-${predecessor.id}`;
    const legacyExists = Buffer.byteLength(legacyId, 'utf8') <= 255 &&
      fs.existsSync(path.join(windows, legacyId));
    const boundedExists = fs.existsSync(path.join(windows, boundedId));
    if (legacyExists && boundedExists) throw new Error('Recovery successor divergence');
    selectedId = legacyExists ? legacyId : boundedId;
    if (!legacyExists && !boundedExists) {
      const staging = path.join(windows, `.opening-${process.pid}`);
      const seed = {
        schemaVersion: 2,
        windowId: boundedId,
        openedAtMs: Date.now(),
        generation,
        budget: 4,
        state: 'open',
        predecessor,
      };
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'window.json'), JSON.stringify(seed, null, 2));
      try {
        fs.renameSync(staging, path.join(windows, boundedId));
      } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        if (!fs.existsSync(path.join(windows, boundedId))) throw error;
        const winner = JSON.parse(fs.readFileSync(path.join(windows, boundedId, 'window.json'), 'utf8'));
        if (winner.schemaVersion !== 2 || winner.windowId !== boundedId ||
            winner.generation !== generation ||
            JSON.stringify(winner.predecessor) !== JSON.stringify(predecessor)) {
          throw new Error('Recovery successor identity mismatch');
        }
      }
    }
  }

  const selectedDir = path.join(windows, selectedId);
  const seed = JSON.parse(fs.readFileSync(path.join(selectedDir, 'window.json'), 'utf8'));
  const attempts = path.join(selectedDir, 'attempts');
  fs.mkdirSync(attempts, { recursive: true });
  for (let slot = 0; slot < seed.budget; slot++) {
    const slotDir = path.join(attempts, String(slot));
    const attemptId = admissionId(selectedId, slot);
    const admission = {
      schemaVersion: 1,
      attemptId,
      windowId: selectedId,
      slot,
      admittedAtMs: Date.now(),
      callerPid: process.pid,
    };
    const staging = path.join(attempts, `.admitting-${process.pid}`);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'admission.json'), JSON.stringify(admission, null, 2));
    try {
      fs.renameSync(staging, slotDir);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (fs.existsSync(slotDir)) continue;
      throw error;
    }
    const candidate = path.join(chestnutDir, 'watchdog', 'candidates', attemptId);
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(candidate, 'admission.json'), JSON.stringify(admission, null, 2));
    console.log(`admitted ${process.pid} ${selectedId} ${attemptId}`);
    return;
  }
  const rejection = path.join(chestnutDir, 'watchdog', 'recovery', 'rejections', selectedId);
  fs.mkdirSync(rejection, { recursive: true });
  fs.writeFileSync(path.join(rejection, `${process.pid}.json`), JSON.stringify({
    kind: 'rejected', reason: 'budget_exhausted', windowId: selectedId,
  }));
  console.log(`rejected ${process.pid} ${selectedId}`);
}

function boundedCommit() {
  const windowId = 'recovery-initial';
  const budget = 4;
  const attempts = path.join(chestnutDir, 'watchdog', 'recovery', 'windows', windowId, 'attempts');
  fs.mkdirSync(attempts, { recursive: true });
  let admittedSlot = null;
  for (let slot = 0; slot < budget; slot++) {
    const slotDir = path.join(attempts, String(slot));
    try {
      fs.mkdirSync(slotDir);
      fs.writeFileSync(path.join(slotDir, 'admission.json'), JSON.stringify({
        schemaVersion: 1,
        attemptId: `attempt-${process.pid}`,
        windowId,
        slot,
        admittedAtMs: Date.now(),
        callerPid: process.pid,
      }));
      admittedSlot = slot;
      break;
    } catch (error) {
      if (!fs.existsSync(slotDir)) throw error;
    }
  }
  if (admittedSlot === null) {
    const rejection = path.join(chestnutDir, 'watchdog', 'recovery', 'rejections', windowId);
    fs.mkdirSync(rejection, { recursive: true });
    fs.writeFileSync(path.join(rejection, `${process.pid}.json`), JSON.stringify({
      kind: 'rejected', reason: 'budget_exhausted', windowId,
    }));
    console.log(`rejected ${process.pid}`);
    return;
  }

  const token = `token-${process.pid}`;
  const attemptId = `attempt-${process.pid}`;
  const candidate = path.join(chestnutDir, 'watchdog', 'candidates', attemptId);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'owner.json'), ownerRecord(token));
  const active = path.join(chestnutDir, 'watchdog', 'active');
  try {
    fs.renameSync(candidate, active);
    fs.writeFileSync(
      path.join(chestnutDir, 'watchdog', 'recovery', 'windows', windowId, 'winner.json'),
      JSON.stringify({ attemptId, pid: process.pid }),
      { flag: 'wx' },
    );
    console.log(`winner ${process.pid} ${token}`);
  } catch (error) {
    const owner = JSON.parse(fs.readFileSync(path.join(active, 'owner.json'), 'utf-8'));
    fs.writeFileSync(
      path.join(candidate, 'outcome.json'),
      JSON.stringify({
        outcome: 'lost',
        window_id: windowId,
        winner_attempt_id: owner.attempt_id,
        winner: owner.pid,
      }),
      { flag: 'wx' },
    );
    console.log(`loser ${process.pid} ${owner.pid}`);
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
  // 父级 runWave('commit') 已 await 所有 child close，旧 generation 已死；
  // 这里不再用 PID existence 重判，避免 wave2 PID reuse 假阳性。
  // 仿生产 retireOwnership：只有 active record 与 expected 旧 generation 完全匹配才执行 retire，
  // 防止迟到 reclaimer 把 wave2 内部新产生的 fresh active 误移到 retired。
  if (
    expectedOwner &&
    (
      owner.attempt_id !== expectedOwner.attempt_id ||
      owner.owner_token !== expectedOwner.owner_token ||
      owner.pid !== expectedOwner.pid
    )
  ) {
    console.log(`retire_lost ${process.pid} mismatch`);
    commit();
    return;
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
else if (mode === 'bounded-commit') boundedCommit();
else if (mode === 'admit-stale' || mode === 'admit-latest') admitSuccessor();
else recover();
