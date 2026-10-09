/**
 * Phase 1931 Step B/C：真实 handler 子进程 fixture（同名/混合来源安装竞争）。
 *
 * 调用真实生产 handler（skillInstallUserCommand / skillInstallClawCommand），
 * 禁止手写安装状态机；fsFactory 依赖缝提供 NodeFileSystem 包装，只在指定的
 * 路径/操作边界等待持久 barrier，未拦截操作原样转发（正确 bind this）。
 *
 * barrier 为文件栅栏：事件经 appendFileSync 落盘（events.jsonl），释放经
 * release-<key> 文件有界轮询；同步 FS 钩子用 Atomics.wait 做有界同步等待，
 * 不 await 伪同步返回、不依赖被阻塞 child 的 IPC 事件循环。时间仅作挂死上限。
 *
 * 用法（父进程先用 esbuild 打包本文件为临时 .mjs）：
 *   node skill-install-race-child.mjs <scenarioJsonPath>
 *
 * stdout 结构化行（与生产 console.log 区分）：
 *   RACE|RESULT|<actor>|ok
 *   RACE|ERROR|<actor>|<ErrorClass>|<message>
 * stderr 完整保留原始堆栈。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import {
  skillInstallUserCommand,
  skillInstallClawCommand,
} from '../../../src/cli/commands/skill.js';

type InterceptOp = 'writeExclusiveSync' | 'mkdirExclusiveSync' | 'moveDir';

interface InterceptSpec {
  /** 事件阶段名（claim-acquired / target-attempt / target-acquired / target-yield 等）。 */
  stage: string;
  op: InterceptOp;
  /** 相对 instanceParent 的 baseDir 后缀（如 '.chestnut'、'.chestnut/motion/skills'）。 */
  baseDirSuffix: string;
  /** 相对路径精确匹配（如 'skill-install/local/.raceskill.installing'、'raceskill'）。 */
  rel: string;
  /** pre：委托前暂停；post：委托成功后暂停（委托抛错则不触发）。 */
  when: 'pre' | 'post';
}

interface Scenario {
  actor: string;
  mode: 'local' | 'pool';
  /** local 模式的 source 目录绝对路径。 */
  source?: string;
  skill: string;
  /** 实例父目录（child 内据此设置 CHESTNUT_ROOT）。 */
  instanceParent: string;
  barrierDir: string;
  intercepts: InterceptSpec[];
}

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error('usage: node skill-install-race-child.mjs <scenarioJsonPath>');
  process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8')) as Scenario;

process.env.CHESTNUT_ROOT = scenario.instanceParent;

const eventsFile = path.join(scenario.barrierDir, 'events.jsonl');
function emit(stage: string): void {
  fs.appendFileSync(
    eventsFile,
    JSON.stringify({ actor: scenario.actor, stage, pid: process.pid, at: Date.now() }) + '\n',
  );
}

/** 挂死上限（仅超时保护，不参与时序）。 */
const HANG_LIMIT_MS = 180_000;
const SYNC_POLL_MS = 5;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function waitRelease(key: string): void {
  const releaseFile = path.join(scenario.barrierDir, `release-${key}`);
  const deadline = Date.now() + HANG_LIMIT_MS;
  while (!fs.existsSync(releaseFile)) {
    if (Date.now() > deadline) {
      emit(`timeout:${key}`);
      console.log(`RACE|ERROR|${scenario.actor}|BarrierTimeout|${key}`);
      process.exit(2);
    }
    Atomics.wait(waitCell, 0, 0, SYNC_POLL_MS);
  }
}

function wrapFs(real: FileSystem, baseDir: string): FileSystem {
  for (const spec of scenario.intercepts) {
    const expectedBase = path.resolve(scenario.instanceParent, spec.baseDirSuffix);
    if (path.resolve(baseDir) !== expectedBase) continue;
    const orig = (real[spec.op] as (...args: unknown[]) => unknown).bind(real);
    (real as unknown as Record<string, unknown>)[spec.op] = (...args: unknown[]) => {
      if (args[0] !== spec.rel) return orig(...args);
      const key = `${scenario.actor}:${spec.stage}`;
      if (spec.when === 'pre') {
        emit(`${spec.stage}:pre`);
        waitRelease(`${key}:pre`);
      }
      const result = orig(...args);
      if (spec.when === 'post') {
        // async op（moveDir）：完成后再触发事件/等待
        if (
          (typeof result === 'object' && result !== null) || typeof result === 'function'
        ) {
          const then = (result as Promise<unknown>).then;
          if (typeof then === 'function') {
            return (result as Promise<unknown>).then((v) => {
              emit(spec.stage);
              waitRelease(key);
              return v;
            });
          }
        }
        emit(spec.stage);
        waitRelease(key);
      }
      return result;
    };
  }
  return real;
}

async function main(): Promise<void> {
  const deps = {
    fsFactory: (baseDir: string): FileSystem => wrapFs(new NodeFileSystem({ baseDir }), baseDir),
  };
  emit('ready');
  try {
    if (scenario.mode === 'local') {
      if (typeof scenario.source !== 'string') throw new Error('local mode requires source');
      await skillInstallUserCommand(deps, scenario.source);
    } else {
      await skillInstallClawCommand(deps, 'motion', scenario.skill);
    }
    emit('settled:ok');
    console.log(`RACE|RESULT|${scenario.actor}|ok`);
  } catch (err) {
    const e = err as Error;
    emit('settled:error');
    console.log(`RACE|ERROR|${scenario.actor}|${e.name}|${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exitCode = 1;
  }
}

await main();
