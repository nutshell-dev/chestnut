/**
 * @module L6.CLI.Claw.Read
 * Read a file from a Claw's clawspace via file-tool public API
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { resolveWorkspacePath } from '../../foundation/file-tool/index.js';
import { CliError } from '../errors.js';
import { importVisibility } from './claw-import.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export async function readCommand(
  deps: ClawCommandDeps,
  clawName: string,
  filePath: string,
  options?: { offset?: number; limit?: number },
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(clawName);
  // undefined 才是 missing；parse/corrupt/IO 异常原实例 fail-loud 上抛，不 catch。
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${clawName}" does not exist`);
  }

  const clawDir = getClawDir(clawName);
  const workspaceDir = path.join(clawDir, CLAWSPACE_DIR);
  // resolveWorkspacePath returns clawDir-relative path, so fs must be scoped to clawDir
  const fs = deps.fsFactory(clawDir);

  const resolved = resolveWorkspacePath({ clawDir, workspaceDir }, filePath);
  if (resolved.startsWith('..') || resolved.startsWith('/')) {
    throw new CliError(`Path escapes claw directory: "${filePath}"`);
  }

  // Phase 1913 Step B（RACE-PUBLISH-PRECOMMIT-VISIBILITY）：读侧发布门控——
  // 目标文件位于未提交 import 目录内 → typed not-published，不暴露半成品。
  const visibility = importVisibility(fs, resolved);
  if (visibility.state === 'in_progress') {
    throw new CliError(
      `"${filePath}" is not published yet in ${clawName}/clawspace/ ` +
      `(import in progress; claim: ${visibility.claimPath})`,
    );
  }
  if (visibility.state === 'invalid') {
    throw new CliError(
      `"${filePath}" has an unreadable import state in ${clawName}/clawspace/ ` +
      `(claim: ${visibility.claimPath}); inspect the evidence before retrying`,
    );
  }

  let content: string;
  try {
    content = await fs.read(resolved);
  } catch (error) {
    throw new CliError(`Error reading file: ${formatErr(error)}`, { cause: error });
  }

  // Phase 1915 Step D（RACE-VISIBILITY-CHECK-TOCTOU）：检查与 read 是两次独立
  // 观察，普通文件系统无事务快照。read 后复验发布态——期间 claim 出现/状态
  // 变化则本次读取可能观察到未提交内容：丢弃并返回 typed unknown/retry，
  // 不写入 stdout。残余平台限制：复验之后新出现的 claim 不可检测（已声明边界）。
  const after = importVisibility(fs, resolved);
  if (after.state !== 'published') {
    throw new CliError(
      `"${filePath}" import state changed while reading in ${clawName}/clawspace/ ` +
      `(now ${after.state}; claim: ${after.claimPath}); result discarded — retry`,
    );
  }

  if (options?.offset !== undefined || options?.limit !== undefined) {
    const lines = content.split('\n');
    let start = (options.offset ?? 1) - 1;
    if (start < 0) start = Math.max(0, lines.length + start + 1);
    const end = options.limit !== undefined ? start + options.limit : lines.length;
    content = lines.slice(start, end).join('\n');
  }

  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
}
