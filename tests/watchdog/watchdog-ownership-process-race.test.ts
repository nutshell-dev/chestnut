/**
 * Phase 1203 Step D: 真实多进程 watchdog ownership race。
 *
 * 真实 child 在 candidate move 前经文件 barrier 聚齐，放行后并发 rename：
 * - wave 1（commit）：恰好一个 active owner，loser 全部留 immutable outcome；
 * - wave 2（recover）：gen1 winner 已退出（dead），恰好一个 reclaimer retire 旧
 *   generation，且恰好一个 gen2 winner 接管 active。
 *
 * barrier 只保证「同时放行」，不参与 winner 排序（timeout 仅防挂死）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const CHILD_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'ownership-race-child.mjs',
);
const WAVE_SIZE = 4;
const READY_BARRIER_WAIT_BUDGET_MS = 15_000;
/** barrier ready 轮询间隔（ms）：10ms << READY_BARRIER_WAIT_BUDGET_MS，仅防挂死、不参与 winner 排序 */
const READY_POLL_INTERVAL_MS = 10;
const COMMIT_RACE_RUNNER_TIMEOUT_MS = 30_000;
const RECOVERY_RACE_RUNNER_TIMEOUT_MS = 60_000;

let tmpDir: string;
let chestnutDir: string;

function activeOwner(): { pid: number; owner_token: string } | null {
  const p = path.join(chestnutDir, 'watchdog', 'active', 'owner.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

async function waitForReady(barrierDir: string, n: number): Promise<void> {
  const deadline = Date.now() + READY_BARRIER_WAIT_BUDGET_MS;
  for (;;) {
    const ready = fs.existsSync(barrierDir)
      ? fs.readdirSync(barrierDir).filter((f) => f.startsWith('ready-')).length
      : 0;
    if (ready >= n) return;
    if (Date.now() > deadline) throw new Error(`barrier ready timeout (${ready}/${n})`);
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** 放 n 个真实 child 经 barrier 并发执行 mode，返回 stdout 行集合。
 *  每个 child 的 stdout/stderr 被完整收集；非零退出时 reject 包含输出供审计。
 *  recover 模式可传入父级已确认的旧 generation owner record，防止迟到 reclaimer 误动 fresh active。 */
async function runWave(
  mode: 'commit' | 'bounded-commit' | 'recover' | 'admit-stale' | 'admit-latest',
  n: number,
  expectedOwner?: {
    attempt_id: string;
    owner_token: string;
    pid: number;
    recovery_window_id?: string;
  } | null,
): Promise<string[]> {
  const barrierDir = path.join(tmpDir, `barrier-${mode}-${randomUUID()}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const lines: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const results = new Map<ReturnType<typeof spawn>, ChildResult>();
  const args = [CHILD_FIXTURE, chestnutDir, barrierDir, mode];
  if ((mode === 'recover' || mode === 'admit-stale') && expectedOwner) {
    args.push(JSON.stringify(expectedOwner));
  }
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
    results.set(child, result);
    child.stdout!.on('data', (d: Buffer) => {
      const text = d.toString();
      result.stdout += text;
      lines.push(...text.split('\n').map((s) => s.trim()).filter(Boolean));
    });
    child.stderr!.on('data', (d: Buffer) => {
      result.stderr += d.toString();
    });
    child.on('exit', (code, signal) => {
      result.code = code;
      result.signal = signal;
    });
    children.push(child);
  }
  await waitForReady(barrierDir, n);
  fs.writeFileSync(path.join(barrierDir, 'go'), 'go');
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((resolve, reject) => {
          const result = results.get(c)!;
          // 'close' 在 stdio flush 后触发，保证 stdout 行全部收齐
          c.on('close', () => {
            if (result.code === 0) {
              resolve();
              return;
            }
            const summary = [
              `child exit code=${result.code} signal=${result.signal}`,
              '--- stdout ---',
              result.stdout || '(empty)',
              '--- stderr ---',
              result.stderr || '(empty)',
            ].join('\n');
            reject(new Error(summary));
          });
        }),
    ),
  );
  return lines;
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-race-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('真实多进程 ownership race', () => {
  it('并发 candidate commit：恰好一个 active owner，loser 留 immutable outcome', async () => {
    const lines = await runWave('commit', WAVE_SIZE);

    const winners = lines.filter((l) => l.startsWith('winner '));
    const losers = lines.filter((l) => l.startsWith('loser '));
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(WAVE_SIZE - 1);

    const [, winnerPid, winnerToken] = winners[0].split(' ');
    const owner = activeOwner();
    expect(owner).not.toBeNull();
    expect(String(owner!.pid)).toBe(winnerPid);
    expect(owner!.owner_token).toBe(winnerToken);

    // 所有 loser 重读到同一 winner 并留下 candidate outcome
    for (const l of losers) {
      expect(l.split(' ')[2]).toBe(winnerPid);
    }
    const candidatesDir = path.join(chestnutDir, 'watchdog', 'candidates');
    const outcomes = fs
      .readdirSync(candidatesDir)
      .filter((d) => fs.existsSync(path.join(candidatesDir, d, 'outcome.json')));
    expect(outcomes.length).toBe(WAVE_SIZE - 1);
  }, COMMIT_RACE_RUNNER_TIMEOUT_MS);

  it('真实 20-child 同窗口竞争：预算为 4、唯一 winner、迟到 loser 与拒绝证据守恒', async () => {
    const size = 20;
    const budget = 4;
    const lines = await runWave('bounded-commit', size);

    expect(lines.filter((line) => line.startsWith('winner '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('loser '))).toHaveLength(budget - 1);
    expect(lines.filter((line) => line.startsWith('rejected '))).toHaveLength(size - budget);
    expect(activeOwner()).not.toBeNull();

    const attempts = fs.readdirSync(path.join(
      chestnutDir, 'watchdog', 'recovery', 'windows', 'recovery-initial', 'attempts'));
    expect(attempts).toHaveLength(budget);
    const candidatesDir = path.join(chestnutDir, 'watchdog', 'candidates');
    const outcomes = fs.readdirSync(candidatesDir)
      .filter((entry) => fs.existsSync(path.join(candidatesDir, entry, 'outcome.json')));
    expect(outcomes).toHaveLength(budget - 1);
    for (const entry of outcomes) {
      const outcome = JSON.parse(fs.readFileSync(path.join(candidatesDir, entry, 'outcome.json'), 'utf8'));
      expect(outcome).toMatchObject({ outcome: 'lost', window_id: 'recovery-initial' });
      expect(typeof outcome.winner_attempt_id).toBe('string');
    }
    const rejections = fs.readdirSync(path.join(
      chestnutDir, 'watchdog', 'recovery', 'rejections', 'recovery-initial'));
    expect(rejections).toHaveLength(size - budget);
  }, COMMIT_RACE_RUNNER_TIMEOUT_MS);

  it.each([
    { mode: 'admit-stale' as const, source: 'stale owner attempt' },
    { mode: 'admit-latest' as const, source: 'latest winner attempt' },
  ])('同一前代并发准入（$source）：只发布一份有界窗口预算', async ({ mode }) => {
    const parentId = `recovery-after-${'p'.repeat(220)}`;
    const parentAttempt = `${parentId}-candidate-0`;
    const parentDir = path.join(chestnutDir, 'watchdog', 'recovery', 'windows', parentId);
    fs.mkdirSync(parentDir, { recursive: true });
    const parentSeed = JSON.stringify({
      schemaVersion: 1,
      windowId: parentId,
      openedAtMs: 1_008,
      generation: 8,
      budget: 4,
      state: 'open',
    }, null, 2);
    fs.writeFileSync(path.join(parentDir, 'window.json'), parentSeed);
    fs.writeFileSync(path.join(parentDir, 'winner.json'), JSON.stringify({ attemptId: parentAttempt }));

    const lines = await runWave(mode, 8, {
      attempt_id: parentAttempt,
      owner_token: 'stale-token',
      pid: 999999999,
      recovery_window_id: parentId,
    });
    const admitted = lines.filter((line) => line.startsWith('admitted '));
    const rejected = lines.filter((line) => line.startsWith('rejected '));
    expect(admitted).toHaveLength(4);
    expect(rejected).toHaveLength(4);
    const successorIds = new Set(admitted.map((line) => line.split(' ')[2]));
    expect(successorIds.size).toBe(1);
    const successorId = [...successorIds][0];
    expect(successorId).toMatch(/^rw2-[a-f0-9]{64}$/);
    expect(Buffer.byteLength(successorId, 'utf8')).toBe(68);
    for (const line of admitted) {
      expect(Buffer.byteLength(line.split(' ')[3], 'utf8')).toBeLessThanOrEqual(96);
    }
    const successorDir = path.join(chestnutDir, 'watchdog', 'recovery', 'windows', successorId);
    expect(JSON.parse(fs.readFileSync(path.join(successorDir, 'window.json'), 'utf8')))
      .toMatchObject({
        schemaVersion: 2,
        generation: 9,
        predecessor: { kind: 'attempt', id: parentAttempt },
      });
    expect(fs.readdirSync(path.join(successorDir, 'attempts'))
      .filter((entry) => !entry.startsWith('.'))).toHaveLength(4);
    expect(fs.readFileSync(path.join(parentDir, 'window.json'), 'utf8')).toBe(parentSeed);
  }, COMMIT_RACE_RUNNER_TIMEOUT_MS);

  it('winner 退出后 recovery：恰好一个 reclaimer retire 旧 generation、恰好一个 gen2 winner', async () => {
    const wave1 = await runWave('commit', WAVE_SIZE);
    const gen1Token = wave1.find((l) => l.startsWith('winner '))!.split(' ')[2];
    const gen1Pid = wave1.find((l) => l.startsWith('winner '))!.split(' ')[1];
    // wave 1 child 已全部 close（awaited）→ gen1 generation 已退出，这是旧 owner dead 的显式证明。
    // 不再依赖 PID existence 重判，避免 OS 复用 PID 导致假阳性。
    const gen1Owner = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, 'watchdog', 'active', 'owner.json'), 'utf-8'));
    expect(String(gen1Owner.pid)).toBe(gen1Pid);
    expect(gen1Owner.owner_token).toBe(gen1Token);

    const wave2 = await runWave('recover', WAVE_SIZE, gen1Owner);

    expect(wave2.filter((l) => l.startsWith('owner_alive')).length).toBe(0);
    expect(wave2.filter((l) => l.startsWith('retired ')).length).toBe(1);
    expect(wave2.filter((l) => l.startsWith('winner ')).length).toBe(1);

    // 旧 generation 完整保留在 retired/<gen1-token>
    const retiredOwner = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, 'watchdog', 'retired', gen1Token, 'owner.json'), 'utf-8'));
    expect(String(retiredOwner.pid)).toBe(gen1Pid);
    expect(fs.readdirSync(path.join(chestnutDir, 'watchdog', 'retired'))).toEqual([gen1Token]);

    // 新 generation 接管 active、token 不同
    const gen2 = activeOwner();
    expect(gen2).not.toBeNull();
    expect(gen2!.owner_token).not.toBe(gen1Token);
  }, RECOVERY_RACE_RUNNER_TIMEOUT_MS);
});
