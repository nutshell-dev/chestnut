/**
 * @module L6.CLI.Claw.Send
 * Send an inbox message to a Claw
 *
 * phase 1990 Step B：stdout 为 chestnut.launcher.v1 协议 stdout——
 * 成功写唯一 ack envelope，失败写 error envelope 后以非零退出；
 * 人类提示（status/contract hint）移至 stderr，不占用协议 stdout。
 */

import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { assertPublishedClaw } from './claw-target.js';
import { makeClawNotifyTargetResolver } from '../../core/claw-topology/index.js';
import { createClawNotifier } from '../../foundation/messaging/index.js';
import { formatNoActiveContractHint } from './claw-shared.js';
import {
  createLauncherSequencer,
  formatClawStatusHint,
  launcherErrorEnvelope,
  makeLauncherEnvelope,
  makeLauncherSessionId,
  writeLauncherEnvelope,
} from '../../cli-protocol/index.js';
import type { Priority } from '../../foundation/messaging/index.js';
import { actionAuditFor } from '../action-scope.js';

import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { hasActiveContract } from '../../core/contract/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export interface SendCommandOptions {
  priority?: Priority;
  /** launcher 传入的请求标识；ack envelope 原样回带，供 consumer 校验对应关系。 */
  requestId?: string;
}

export async function sendCommand(
  deps: ClawCommandDeps,
  name: string,
  message: string,
  options?: SendCommandOptions
): Promise<void> {
  const sessionId = makeLauncherSessionId();
  const nextSeq = createLauncherSequencer();
  try {
    await deliver(deps, name, message, options);
  } catch (err) {
    // 协议 stdout 写 error envelope（launcher 优先消费），原始错误继续抛（stderr + 非零退出）。
    writeLauncherEnvelope(
      process.stdout,
      launcherErrorEnvelope(nextSeq(), sessionId, 'rejected', formatErr(err)),
    );
    throw err;
  }
  // 成功路径唯一 stdout 行：ack envelope（ack 只表示 inbox 接收，不代表 Motion 已回复）。
  writeLauncherEnvelope(
    process.stdout,
    makeLauncherEnvelope(nextSeq(), sessionId, 'ack', {
      accepted: true,
      claw: name,
      ...(options?.requestId ? { requestId: options.requestId } : {}),
    }),
  );
}

async function deliver(
  deps: ClawCommandDeps,
  name: string,
  message: string,
  options?: SendCommandOptions
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const target = assertPublishedClaw(deps, name);

  const baseDir = getChestnutRoot();
  const clawDir = target.clawDir;
  const fileSystem = deps.fsFactory(baseDir);
  const audit = actionAuditFor(clawDir, deps);

  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  createClawNotifier({
    fs: fileSystem,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(baseDir),
  }).notify(name, {
    type: 'user_inbox_message',
    source: 'user',
    priority: options?.priority ?? 'normal',
    body: message,
  });

  const processManager = createProcessManagerForCLI({ ...deps, baseDir });
  const isAlive = processManager.isAlive(resolveClawDaemonDir(target.clawId));
  const statusHint = formatClawStatusHint(name, isAlive);
  if (statusHint) process.stderr.write(statusHint + '\n');

  // phase 241: active contract hint — no active contract → remind caller
  const clawFs = deps.fsFactory(clawDir);
  let hasContract = false;
  try {
    hasContract = hasActiveContract(clawFs, '.');
  } catch {
    // silent: contract dir scan failure is legitimate → treat as no active contract
    hasContract = false;
  }
  const contractHint = formatNoActiveContractHint(name, hasContract);
  if (contractHint) process.stderr.write(contractHint + '\n');
}
