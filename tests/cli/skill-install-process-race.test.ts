/**
 * Phase 1931 Step B/C：同名/混合来源安装的跨进程确定性竞争。
 *
 * 真实子进程经 esbuild 打包的 fixture 调用真实生产 handler
 * （skillInstallUserCommand / skillInstallClawCommand），持久文件 barrier
 * 控制交错时序——不依赖调度快慢、不用 sleep 猜到达点（轮询仅防挂死）。
 *
 * Step B（local×local 同名）：A 取得新位置 claim 后暂停，B 读 live holder
 * 冲突失败且不改写 A 的 claim；释放 A 完成全量发布。
 * Step C（local×pool 混合来源争同一 Motion 目标）：见 C1/C2/C3。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { skillInstallUserCommand } from '../../src/cli/commands/skill.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createSkillVersions, type SkillVersions } from '../../src/foundation/skill-system/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const FIXTURE_SRC = path.resolve(process.cwd(), 'tests/cli/fixtures/skill-install-race-child.ts');

/** 定位 pnpm 隔离布局下的 esbuild bin（tsup 的传递依赖，不新增直接依赖）。 */
function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const hit = fs
    .readdirSync(pnpmDir)
    .filter((d) => d.startsWith('esbuild@'))
    .sort();
  for (const d of hit) {
    const bin = path.join(pnpmDir, d, 'node_modules/esbuild/bin/esbuild');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

let fixtureBundleDir: string;
let fixtureBundle: string;

beforeAll(async () => {
  fixtureBundleDir = await createTrackedTempDir('skill-race-fixture-build-');
  fixtureBundle = path.join(fixtureBundleDir, 'skill-install-race-child.mjs');
  execFileSync(
    resolveEsbuildBin(),
    [FIXTURE_SRC, '--bundle', '--platform=node', '--format=esm', '--target=node20', `--outfile=${fixtureBundle}`],
    { stdio: 'pipe' },
  );
}, 60_000);

/* ---------- 类型与 scenario ---------- */

type InterceptOp = 'writeExclusiveSync' | 'mkdirExclusiveSync' | 'moveDir';
interface InterceptSpec {
  stage: string;
  op: InterceptOp;
  baseDirSuffix: string;
  rel: string;
  when: 'pre' | 'post';
}
interface Scenario {
  actor: string;
  mode: 'local' | 'pool';
  source?: string;
  skill: string;
  instanceParent: string;
  barrierDir: string;
  intercepts: InterceptSpec[];
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface ChildHandle {
  proc: ChildProcess;
  result: ChildResult;
  /** close 后 resolve（stdio 已 flush，stdout/stderr 收齐）。 */
  done: Promise<void>;
}

/* ---------- 测试上下文 ---------- */

let tmpDir: string;
let savedRoot: string | undefined;
const liveChildren = new Set<ChildProcess>();

const plainDeps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };

beforeEach(async () => {
  tmpDir = await createTrackedTempDir('skill-install-race-');
  savedRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tmpDir;
});

afterEach(async () => {
  // 终止遗留 child 并等待 close 后再清目录
  for (const c of liveChildren) {
    try { c.kill('SIGKILL'); } catch { /* already dead */ }
  }
  await Promise.all(
    [...liveChildren].map(
      (c) => new Promise<void>((r) => { c.on('close', () => r()); setTimeout(r, 5_000); }),
    ),
  );
  liveChildren.clear();
  if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = savedRoot;
  await cleanupTempDir(tmpDir);
});

afterAll(async () => {
  await cleanupTempDir(fixtureBundleDir);
});

/* ---------- barrier / child 基础设施 ---------- */

function writeScenario(s: Scenario): string {
  const p = path.join(s.barrierDir, `scenario-${s.actor}.json`);
  fs.writeFileSync(p, JSON.stringify(s));
  return p;
}

function runChild(s: Scenario): ChildHandle {
  fs.mkdirSync(s.barrierDir, { recursive: true });
  const proc = spawn(process.execPath, [fixtureBundle, writeScenario(s)], {
    env: { ...process.env, CHESTNUT_ROOT: s.instanceParent, NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(proc);
  const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
  proc.stdout!.on('data', (d: Buffer) => { result.stdout += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { result.stderr += d.toString(); });
  const done = new Promise<void>((resolve) => {
    proc.on('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      liveChildren.delete(proc);
      resolve();
    });
  });
  return { proc, result, done };
}

interface RaceEvent { actor: string; stage: string; pid: number; at: number }

function readEvents(barrierDir: string): RaceEvent[] {
  const f = path.join(barrierDir, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RaceEvent);
}

/** 有界轮询等待事件到达（仅防挂死，不参与时序构造）。 */
async function waitEvent(barrierDir: string, actor: string, stage: string, timeoutMs = 120_000): Promise<RaceEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = readEvents(barrierDir).find((e) => e.actor === actor && e.stage === stage);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`event timeout: ${actor}/${stage}; events=${JSON.stringify(readEvents(barrierDir))}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function release(barrierDir: string, key: string): void {
  fs.writeFileSync(path.join(barrierDir, `release-${key}`), 'release');
}

/* ---------- 领域辅助 ---------- */

const SKILL_NAME = 'raceskill';

/** 本地 payload：SKILL.md / run.sh / notes.txt 三文件，跨 payload 至少两文件不同。 */
function makeLocalSource(parent: string, version: string): { dir: string; files: Record<string, string> } {
  const dir = path.join(tmpDir, parent, SKILL_NAME);
  const files = {
    'SKILL.md': `---\nname: ${SKILL_NAME}\ndescription: race ${version}\n---\n# ${SKILL_NAME} ${version}\n`,
    'run.sh': `echo ${version}\n`,
    'notes.txt': `notes of ${version}\n`,
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return { dir, files };
}

function motionSkillDir(): string {
  return path.join(tmpDir, '.chestnut', 'motion', 'skills', SKILL_NAME);
}
function localClaimPath(): string {
  return path.join(tmpDir, '.chestnut', 'skill-install', 'local', `.${SKILL_NAME}.installing`);
}
function poolClaimPath(): string {
  return path.join(tmpDir, '.chestnut', 'motion', 'skills', `.${SKILL_NAME}.installing`);
}
function parentSkillsDir(): string {
  return path.join(tmpDir, 'skills');
}

async function poolVersions(): Promise<SkillVersions> {
  const clawspace = path.join(tmpDir, '.chestnut', 'motion', 'clawspace');
  return createSkillVersions({
    repositoryDir: path.join(clawspace, 'dispatch-skills'),
    workspaceParent: path.join(clawspace, '.dispatch-workspaces'),
    stateDir: path.join(clawspace, '.dispatch-version-state'),
    fsFactory: plainDeps.fsFactory,
    audit: makeAudit().audit,
  });
}

/** 父进程预初始化池（避免把 Git init 失败当竞争证据）；poolPayload 非空时发布该版本。 */
async function prepublishPool(version: string | null): Promise<void> {
  if (version === null) {
    // 仅初始化：安装一个无关技能，建立 dispatch 仓库
    const warmDir = path.join(tmpDir, 'warmup-src', 'warmupskill');
    fs.mkdirSync(warmDir, { recursive: true });
    fs.writeFileSync(path.join(warmDir, 'SKILL.md'), `---\nname: warmupskill\ndescription: warm\n---\n# warmup\n`);
    fs.writeFileSync(path.join(warmDir, 'run.sh'), 'echo warm\n');
    await skillInstallUserCommand(plainDeps, warmDir);
    return;
  }
  const src = makeLocalSource(`prepublish-${version}`, version);
  await skillInstallUserCommand(plainDeps, src.dir);
}

/** 断言 Motion 目标恰为某一完整 payload（全文件逐字节，无协议工件残留）。 */
function expectMotionTargetIs(files: Record<string, string>): void {
  const dir = motionSkillDir();
  const actual = fs.readdirSync(dir).sort();
  expect(actual).toEqual(Object.keys(files).sort());
  for (const [name, content] of Object.entries(files)) {
    expect(fs.readFileSync(path.join(dir, name), 'utf-8')).toBe(content);
  }
}

function resultLine(h: ChildHandle): string {
  const line = h.result.stdout.split('\n').find((l) => l.startsWith('RACE|'));
  expect(line, `child 须输出 RACE| 结构化行；stdout=${h.result.stdout}\nstderr=${h.result.stderr}`).toBeDefined();
  return line!;
}

/* ---------- Step B：同名本地安装跨进程竞争 ---------- */

describe('Step B：同名本地安装跨进程竞争（真实 handler 子进程 + 持久 barrier）', () => {
  it('A 持新位置 claim 期间 B 冲突失败且零改写；释放后 A 完成全量发布', async () => {
    await prepublishPool(null); // 池预初始化：排除 Git init 失败干扰
    const payloadA = makeLocalSource('src-a', 'vA');
    const payloadB = makeLocalSource('src-b', 'vB');
    expect(payloadA.files['SKILL.md']).not.toBe(payloadB.files['SKILL.md']);
    expect(payloadA.files['run.sh']).not.toBe(payloadB.files['run.sh']);

    const barrierDir = path.join(tmpDir, 'barrier-b1');
    fs.mkdirSync(barrierDir, { recursive: true });

    // A：claim 独占写成功后、继续发布前暂停
    const a = runChild({
      actor: 'A', mode: 'local', source: payloadA.dir, skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [{
        stage: 'claim-acquired', op: 'writeExclusiveSync',
        baseDirSuffix: '.chestnut', rel: path.join('skill-install', 'local', `.${SKILL_NAME}.installing`),
        when: 'post',
      }],
    });

    const acquired = await waitEvent(barrierDir, 'A', 'claim-acquired');
    // 持久证明：claim 真实可解析、holder = A（活）
    const claimBeforeB = fs.readFileSync(localClaimPath(), 'utf-8');
    const claimJson = JSON.parse(claimBeforeB);
    expect(claimJson.pid).toBe(acquired.pid);
    expect(claimJson.pid).toBe(a.proc.pid);
    expect(() => process.kill(acquired.pid, 0)).not.toThrow();

    // B：无 barrier，读 live holder 应冲突失败
    const b = runChild({
      actor: 'B', mode: 'local', source: payloadB.dir, skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir, intercepts: [],
    });
    await b.done;

    expect(b.result.code).not.toBe(0);
    const bLine = resultLine(b);
    expect(bLine).toContain('RACE|ERROR|B|CliError|');
    // B 的失败必须来自安装冲突：live holder in-progress 或异源 payload 拒绝
    // （Phase 1929 Step E：异源/布局拒绝优先于 holder 存活判定），两者都是
    // fail-closed 冲突；绝不接受 Git 初始化/fixture 错误充当通过。
    expect(bLine).toMatch(/already in progress|interrupted install with a different source payload/);
    expect(b.result.stderr).not.toMatch(/git/i); // 不是 Git 初始化失败
    // B 不改写 A 的 claim（字节不变）
    expect(fs.readFileSync(localClaimPath(), 'utf-8')).toBe(claimBeforeB);
    // A 全程活着且未 settle
    expect(() => process.kill(acquired.pid, 0)).not.toThrow();
    expect(readEvents(barrierDir).some((e) => e.actor === 'A' && e.stage.startsWith('settled'))).toBe(false);
    const bSettled = await waitEvent(barrierDir, 'B', 'settled:error');

    // 释放 A，完成安装
    release(barrierDir, 'A:claim-acquired');
    await a.done;
    expect(a.result.code).toBe(0);
    expect(resultLine(a)).toBe('RACE|RESULT|A|ok');

    // 事件序列：A ready → A claim-acquired → B settled:error → A settled:ok；PID 不同
    const stages = readEvents(barrierDir).map((e) => `${e.actor}:${e.stage}`);
    const idx = (s: string) => stages.indexOf(s);
    expect(idx('A:ready')).toBeGreaterThanOrEqual(0);
    expect(idx('A:claim-acquired')).toBeGreaterThan(idx('A:ready'));
    expect(idx('B:settled:error')).toBeGreaterThan(idx('A:claim-acquired'));
    expect(idx('A:settled:ok')).toBeGreaterThan(idx('B:settled:error'));
    expect(acquired.pid).not.toBe(bSettled.pid);

    // 最终事实：Motion 全文件 = payload A；池 = payload A；claim 释放；父目录零写入
    expectMotionTargetIs(payloadA.files);
    expect(await (await poolVersions()).loadPublished(SKILL_NAME)).toContain(`# ${SKILL_NAME} vA`);
    expect(fs.existsSync(localClaimPath())).toBe(false);
    expect(fs.existsSync(parentSkillsDir())).toBe(false);
    // 新 namespace 无快照孤儿残留
    const claimParent = path.dirname(localClaimPath());
    const residue = fs.existsSync(claimParent)
      ? fs.readdirSync(claimParent).filter((n) => n.startsWith('.'))
      : [];
    expect(residue).toEqual([]);
  }, 180_000);
});
