/**
 * phase 2084 Step B：跨进程 open worker（仅 version-open-concurrent.test.ts 使用）。
 *
 * 只调用生产 createVersionStore，不放任何业务逻辑；通过 IPC 报告屏障点与结果：
 * - `initiator`：在首次 `git config user.name` 写入前 `send({type:'entered'})` 并等待
 *   `{type:'release'}`，其余 exec 原样转发生产 exec（屏障点位于完整初始化互斥区中段）。
 * - `follower`：`NodeFileSystem.writeExclusive` 命中 `.version-store-init.lock` 的 EEXIST
 *   时 `send({type:'lock-busy'})`（不吞错，仍把 EEXIST 交回生产的等待逻辑）。
 * - 结束：`{type:'ok'}` 或 `{type:'error', kind, message}`，退出码 0 / 1。
 *
 * argv：`<initiator|follower> <repositoryDir> <workspaceParent>`
 */
import { exec as defaultExec } from '../../../../src/foundation/process-exec/index.js';
import { noopAuditLog } from '../../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../../src/foundation/fs/index.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { createVersionStore } from '../../../../src/foundation/snapshot/index.js';

type WorkerMode = 'initiator' | 'follower';

const INIT_LOCK = '.version-store-init.lock';

interface WorkerMessage {
  type: string;
  pid?: number;
  kind?: string;
  message?: string;
}

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function') {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

async function main(): Promise<void> {
  const [modeArg, repositoryDir, workspaceParent] = process.argv.slice(2);
  const mode = modeArg as WorkerMode | undefined;
  if ((mode !== 'initiator' && mode !== 'follower') || repositoryDir === undefined || workspaceParent === undefined) {
    await send({
      type: 'error',
      kind: 'worker_usage',
      message: 'usage: <initiator|follower> <repositoryDir> <workspaceParent>',
    });
    process.exitCode = 2;
    return;
  }

  let releaseBarrier: () => void = () => {};
  const released = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  process.on('message', (raw: unknown) => {
    if ((raw as { type?: string } | null)?.type === 'release') releaseBarrier();
  });

  const inner = new NodeFileSystem({ baseDir: repositoryDir });
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'writeExclusive') {
        return async (rel: string, content: string): Promise<void> => {
          try {
            await target.writeExclusive(rel, content);
          } catch (error) {
            if (rel === INIT_LOCK && (error as NodeJS.ErrnoException)?.code === 'EEXIST') {
              await send({ type: 'lock-busy', pid: process.pid });
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;

  const execImpl: typeof defaultExec = async (command, args, options) => {
    // 归属验证后生产 gitExec 会加 `--git-dir <dir>` 前缀，故按包含关系识别
    // “首次写 user.name=chestnut”（不会误命 `--get` 读取）
    const isFirstConfigWrite =
      command === 'git' && args.includes('config') && args.includes('user.name') && args.includes('chestnut');
    if (mode === 'initiator' && isFirstConfigWrite) {
      await send({ type: 'entered', pid: process.pid });
      await released;
    }
    return defaultExec(command, args, options);
  };

  try {
    await createVersionStore({ repositoryDir, workspaceParent, fs, audit: noopAuditLog, exec: execImpl });
    await send({ type: 'ok', pid: process.pid });
  } catch (error) {
    const e = error as { kind?: string; message?: string };
    await send({
      type: 'error',
      kind: e.kind ?? 'unknown',
      message: e.message ?? String(error),
    });
    process.exitCode = 1;
  }
}

void main().finally(() => {
  // 不主动 exit：让已 flush 的 IPC 消息投递完，再断开通道结束进程
  if (process.connected) process.disconnect();
});
