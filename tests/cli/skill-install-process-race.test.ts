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

/* ---------- Step C 共用 intercept ---------- */

/** 目标占位操作（absent 分支 mkdirExclusiveSync）barrier。 */
function targetGate(stage: string, when: 'pre' | 'post'): InterceptSpec {
  return {
    stage, op: 'mkdirExclusiveSync',
    baseDirSuffix: path.join('.chestnut', 'motion', 'skills'), rel: SKILL_NAME, when,
  };
}
/** 池→Motion 的 target-local claim 写（版本选择在 claim 前完成，此事件 = 版本已固定）。 */
const POOL_CLAIM_GATE: InterceptSpec = {
  stage: 'claim-acquired', op: 'writeExclusiveSync',
  baseDirSuffix: path.join('.chestnut', 'motion'), rel: path.join('skills', `.${SKILL_NAME}.installing`),
  when: 'post',
};

/** 目标绝对路径（两入口必须实际相同）。 */
function sharedTargetAbs(): string {
  return motionSkillDir();
}

/** 读取池当前发布内容（固定版本读取，live 目录不是权威）。 */
async function readPool(): Promise<string> {
  return (await poolVersions()).loadPublished(SKILL_NAME);
}

/** 目标父目录无协议工件残留；allowSnapshot=true 时容忍 loser 保留的来源快照（协议留证）。 */
function expectNoTargetResidue(opts?: { allowSnapshot?: boolean }): void {
  const parent = path.dirname(motionSkillDir());
  const residue = fs.readdirSync(parent).filter((n) => n.startsWith('.skill-'));
  const unexpected = opts?.allowSnapshot
    ? residue.filter((n) => !n.startsWith('.skill-srcsnap-'))
    : residue;
  expect(unexpected).toEqual([]);
}

/* ---------- Step C：本地/池到 Motion 混合来源竞争 ---------- */

describe('Step C：本地安装与池安装争同一 Motion 目标（真实子进程确定性时序）', () => {
  /**
   * C1：本地先取得 absent 目标。
   * 时序：池 child 先固定版本 vP（claim-acquired）→ 两 child 同到 target-attempt →
   * 本地先取得目标（target-acquired 暂停）→ 池占有冲突 → 本地完成。
   */
  it('C1：absent 目标 local 先取得——pool loser typed 冲突不覆盖，Motion/池 = 本地完整 payload', async () => {
    await prepublishPool('vP');
    // 目标回到 absent（池保留固定版本 vP）；prepublish 的 claim 已释放
    fs.rmSync(motionSkillDir(), { recursive: true, force: true });
    const payloadL = makeLocalSource('src-local', 'vL');
    expect(payloadL.files['run.sh']).not.toContain('vP'); // 本地与池源不同（>=2 文件）

    const barrierDir = path.join(tmpDir, 'barrier-c1');
    fs.mkdirSync(barrierDir, { recursive: true });

    // 池 child：先固定版本（claim-acquired post），再到目标占位前暂停
    const pool = runChild({
      actor: 'pool', mode: 'pool', skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [POOL_CLAIM_GATE, targetGate('target-attempt', 'pre')],
    });
    await waitEvent(barrierDir, 'pool', 'claim-acquired'); // 池版本选择已完成并被记录（vP）

    // 本地 child：目标占位前后各一道 barrier
    const local = runChild({
      actor: 'local', mode: 'local', source: payloadL.dir, skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [targetGate('target-attempt', 'pre'), targetGate('target-acquired', 'post')],
    });
    await waitEvent(barrierDir, 'local', 'target-attempt:pre');
    release(barrierDir, 'pool:claim-acquired');
    await waitEvent(barrierDir, 'pool', 'target-attempt:pre');

    // winner = local：先放行占位
    release(barrierDir, 'local:target-attempt:pre');
    await waitEvent(barrierDir, 'local', 'target-acquired');
    // loser = pool：占有必冲突
    release(barrierDir, 'pool:target-attempt:pre');
    await pool.done;

    expect(pool.result.code).not.toBe(0);
    const poolLine = resultLine(pool);
    expect(poolLine).toContain('RACE|ERROR|pool|CliError|');
    expect(poolLine).toMatch(/appeared concurrently/);
    expect(poolLine).toContain(sharedTargetAbs()); // 两进程实际目标相同
    // loser 证据保留：池 target-local claim 在、未被 winner 改写
    expect(fs.existsSync(poolClaimPath())).toBe(true);
    const loserClaim = JSON.parse(fs.readFileSync(poolClaimPath(), 'utf-8'));
    expect(loserClaim.source).toBe(`dispatch://${SKILL_NAME}`);

    // winner 完成
    release(barrierDir, 'local:target-acquired');
    await local.done;
    expect(local.result.code).toBe(0);
    expect(resultLine(local)).toBe('RACE|RESULT|local|ok');

    // 事件序列：池固定版本 → 双方 target-attempt → local acquired → pool settled:error → local settled:ok
    const stages = readEvents(barrierDir).map((e) => `${e.actor}:${e.stage}`);
    const idx = (s: string) => stages.indexOf(s);
    expect(idx('pool:claim-acquired')).toBeGreaterThanOrEqual(0);
    expect(idx('local:target-attempt:pre')).toBeGreaterThan(idx('pool:claim-acquired'));
    expect(idx('pool:target-attempt:pre')).toBeGreaterThan(idx('pool:claim-acquired'));
    expect(idx('local:target-acquired')).toBeGreaterThan(idx('local:target-attempt:pre'));
    expect(idx('pool:settled:error')).toBeGreaterThan(idx('local:target-acquired'));
    expect(idx('local:settled:ok')).toBeGreaterThan(idx('pool:settled:error'));

    // 最终事实：Motion 全文件 = 本地 vL；池随本地发布进度 = vL；loser 不动 winner
    expectMotionTargetIs(payloadL.files);
    expect(await readPool()).toContain(`# ${SKILL_NAME} vL`);
    expect(fs.existsSync(localClaimPath())).toBe(false);
    expect(fs.existsSync(parentSkillsDir())).toBe(false);
    // loser（pool）claim 与来源快照按协议留证；目标父目录无 staging/trash 残留
    expect(fs.existsSync(poolClaimPath())).toBe(true);
    expectNoTargetResidue({ allowSnapshot: true });
  }, 180_000);

  /**
   * C2：池先取得 absent 目标（反方向）。
   */
  it('C2：absent 目标 pool 先取得——local loser typed 冲突不覆盖，Motion/池保持池固定版本', async () => {
    await prepublishPool('vP');
    fs.rmSync(motionSkillDir(), { recursive: true, force: true });
    const payloadL = makeLocalSource('src-local', 'vL');

    const barrierDir = path.join(tmpDir, 'barrier-c2');
    fs.mkdirSync(barrierDir, { recursive: true });

    const pool = runChild({
      actor: 'pool', mode: 'pool', skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [POOL_CLAIM_GATE, targetGate('target-attempt', 'pre'), targetGate('target-acquired', 'post')],
    });
    await waitEvent(barrierDir, 'pool', 'claim-acquired');

    const local = runChild({
      actor: 'local', mode: 'local', source: payloadL.dir, skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [targetGate('target-attempt', 'pre')],
    });
    await waitEvent(barrierDir, 'local', 'target-attempt:pre');
    release(barrierDir, 'pool:claim-acquired');
    await waitEvent(barrierDir, 'pool', 'target-attempt:pre');

    // winner = pool
    release(barrierDir, 'pool:target-attempt:pre');
    await waitEvent(barrierDir, 'pool', 'target-acquired');
    // loser = local
    release(barrierDir, 'local:target-attempt:pre');
    await local.done;

    expect(local.result.code).not.toBe(0);
    const localLine = resultLine(local);
    expect(localLine).toContain('RACE|ERROR|local|CliError|');
    expect(localLine).toMatch(/appeared concurrently/);
    expect(localLine).toContain(sharedTargetAbs());
    // loser 证据：本地 claim 留在实例内新 namespace，source = 本地路径
    expect(fs.existsSync(localClaimPath())).toBe(true);
    const loserClaim = JSON.parse(fs.readFileSync(localClaimPath(), 'utf-8'));
    expect(loserClaim.source).toBe(payloadL.dir);

    release(barrierDir, 'pool:target-acquired');
    await pool.done;
    expect(pool.result.code).toBe(0);
    expect(resultLine(pool)).toBe('RACE|RESULT|pool|ok');

    const stages = readEvents(barrierDir).map((e) => `${e.actor}:${e.stage}`);
    const idx = (s: string) => stages.indexOf(s);
    expect(idx('pool:target-acquired')).toBeGreaterThan(idx('local:target-attempt:pre'));
    expect(idx('local:settled:error')).toBeGreaterThan(idx('pool:target-acquired'));
    expect(idx('pool:settled:ok')).toBeGreaterThan(idx('local:settled:error'));

    // 最终事实：Motion 全文件 = 池 vP；池未被本地升级为 vL（本地未提交 dispatch）
    const poolPayload = makeLocalSource('expected-vP', 'vP').files;
    expectMotionTargetIs(poolPayload);
    expect(await readPool()).toContain(`# ${SKILL_NAME} vP`);
    expect(fs.existsSync(poolClaimPath())).toBe(false);
    expect(fs.existsSync(parentSkillsDir())).toBe(false);
    // loser（local）来源快照按协议留证在本地 claim 同级，Motion skills 内只允许
    // 无 staging/trash/marker 残留（local 快照不在此目录）
    expectNoTargetResidue();
  }, 180_000);

  /**
   * C3：existing 目标让位窗口竞争。
   * 目标已有 V0（池安装）；本地进入 existing 分支真实 moveDir 让位点前暂停，
   * 池在此期间完整完成一次更新（合法串行）；释放后本地完成更新到 vL。
   * 仅断言完整性与证据语义，不编造「恰一成功」。
   */
  it('C3：existing 目标让位窗口——重叠期间池合法完成，本地随后完整更新，无混合无残留', async () => {
    await prepublishPool('v0'); // Motion 目标 = V0（existing），池 = v0
    expectMotionTargetIs(makeLocalSource('expected-v0', 'v0').files);
    const payloadL = makeLocalSource('src-local', 'vL');

    const barrierDir = path.join(tmpDir, 'barrier-c3');
    fs.mkdirSync(barrierDir, { recursive: true });

    // 本地 child：existing 分支让位（真实 moveDir）前暂停
    const local = runChild({
      actor: 'local', mode: 'local', source: payloadL.dir, skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir,
      intercepts: [{
        stage: 'target-yield', op: 'moveDir',
        baseDirSuffix: path.join('.chestnut', 'motion', 'skills'), rel: SKILL_NAME, when: 'pre',
      }],
    });
    await waitEvent(barrierDir, 'local', 'target-yield:pre'); // 到达点已记录，再控制释放

    // 池 child 在本地让位窗口内完整执行（V0→V0 合法串行更新）
    const pool = runChild({
      actor: 'pool', mode: 'pool', skill: SKILL_NAME,
      instanceParent: tmpDir, barrierDir, intercepts: [],
    });
    await pool.done;
    expect(pool.result.code).toBe(0);
    expect(resultLine(pool)).toBe('RACE|RESULT|pool|ok');
    // 池完成后目标仍是完整 V0（本地尚未让位）
    expectMotionTargetIs(makeLocalSource('expected2-v0', 'v0').files);

    // 释放本地让位：完成更新到 vL
    release(barrierDir, 'local:target-yield:pre');
    await local.done;
    expect(local.result.code).toBe(0);
    expect(resultLine(local)).toBe('RACE|RESULT|local|ok');

    // 事件序列证明真实重叠：本地到达让位窗口早于池完成
    const stages = readEvents(barrierDir).map((e) => `${e.actor}:${e.stage}`);
    const idx = (s: string) => stages.indexOf(s);
    expect(idx('local:target-yield:pre')).toBeGreaterThanOrEqual(0);
    expect(idx('pool:settled:ok')).toBeGreaterThan(idx('local:target-yield:pre'));
    expect(idx('local:settled:ok')).toBeGreaterThan(idx('pool:settled:ok'));

    // 最终目标 = 本地完整 vL（每个文件同源），池 = vL（本地实际提交进度）；无残留
    expectMotionTargetIs(payloadL.files);
    expect(await readPool()).toContain(`# ${SKILL_NAME} vL`);
    expect(fs.existsSync(localClaimPath())).toBe(false);
    expect(fs.existsSync(poolClaimPath())).toBe(false);
    expect(fs.existsSync(parentSkillsDir())).toBe(false);
    expectNoTargetResidue();
  }, 180_000);
});
