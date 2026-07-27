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
const READY_TIMEOUT_MS = 15000;
/** barrier ready 轮询间隔（ms）：10ms << READY_TIMEOUT_MS，仅防挂死、不参与 winner 排序 */
const READY_POLL_INTERVAL_MS = 10;

let tmpDir: string;
let chestnutDir: string;

function activeOwner(): { pid: number; owner_token: string } | null {
  const p = path.join(chestnutDir, 'watchdog', 'active', 'owner.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

async function waitForReady(barrierDir: string, n: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const ready = fs.existsSync(barrierDir)
      ? fs.readdirSync(barrierDir).filter((f) => f.startsWith('ready-')).length
      : 0;
    if (ready >= n) return;
    if (Date.now() > deadline) throw new Error(`barrier ready timeout (${ready}/${n})`);
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
}

/** 放 n 个真实 child 经 barrier 并发执行 mode，返回 stdout 行集合 */
async function runWave(mode: 'commit' | 'recover', n: number): Promise<string[]> {
  const barrierDir = path.join(tmpDir, `barrier-${mode}-${randomUUID()}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const lines: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, [CHILD_FIXTURE, chestnutDir, barrierDir, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d: Buffer) => {
      lines.push(...d.toString().split('\n').map((s) => s.trim()).filter(Boolean));
    });
    children.push(child);
  }
  await waitForReady(barrierDir, n);
  fs.writeFileSync(path.join(barrierDir, 'go'), 'go');
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((resolve, reject) => {
          let exitCode: number | null = null;
          // 'close' 在 stdio flush 后触发，保证 stdout 行全部收齐
          c.on('exit', (code) => { exitCode = code; });
          c.on('close', () =>
            exitCode === 0 ? resolve() : reject(new Error(`child exit code ${exitCode}`)),
          );
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
  }, 30000);

  it('winner 退出后 recovery：恰好一个 reclaimer retire 旧 generation、恰好一个 gen2 winner', async () => {
    const wave1 = await runWave('commit', WAVE_SIZE);
    const gen1Token = wave1.find((l) => l.startsWith('winner '))!.split(' ')[2];
    const gen1Pid = wave1.find((l) => l.startsWith('winner '))!.split(' ')[1];
    // wave 1 child 已全部 exit（awaited）→ active owner dead

    const wave2 = await runWave('recover', WAVE_SIZE);

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
  }, 60000);
});
