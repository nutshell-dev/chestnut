/**
 * `chestnut audit lookup` subcommand
 *
 * Look up full tool content by tool_use_id (4-level fallback).
 * Does NOT emit audit events (ML 5).
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../foundation/config/index.js';
import { getNamedSubrootDir } from '../../core/claw-topology/claw-instance-paths.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  lookupContentByToolUseId,
  DIALOG_DIR,
  type LookupResult,
  type LookupOptions,
} from '../../foundation/dialog-store/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';


interface AuditLookupOpts {
  claw: string;
  file: string;
  contentHash?: string;
  json?: boolean;
}

export async function auditLookupCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  toolUseId: string,
  opts: AuditLookupOpts,
): Promise<void> {
  // phase 682: caller 直 reach dialog-store/lookupContentByToolUseId、不走 audit reader facade。
  // opts.file 字段保留为 CLI 表面兼容（不再读 audit、但 --file 仍可接受不报错）。
  void opts.file;
  loadGlobalConfig(deps);

  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isMotion && !clawExists(deps, getClawConfigPath(opts.claw))) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const dialogDir = path.join(clawDir, DIALOG_DIR);

  // Validate contentHash format if provided (8-char hex)
  if (opts.contentHash && !/^[0-9a-fA-F]{8}$/.test(opts.contentHash)) {
    throw new CliError('--content-hash must be 8-character hex');
  }

  const lookupOpts: LookupOptions = {
    contentHash: opts.contentHash,
  };

  const result = lookupContentByToolUseId(fs, dialogDir, toolUseId, lookupOpts);
  emit(result, toolUseId, opts.json ?? false);

  // exit code strict semantics: 3 for unavailable
  if (result.source === 'unavailable') {
    process.exitCode = 3;
  }
}

function emit(result: LookupResult, toolUseId: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  switch (result.source) {
    case 'current': {
      process.stdout.write(`Source: current dialog session\n`);
      process.stdout.write(`Tool use ID: ${toolUseId}\n`);
      process.stdout.write(`Content size: ${Buffer.byteLength(result.content, 'utf-8')} bytes\n`);
      process.stdout.write(`---\n${result.content}\n`);
      break;
    }
    case 'archive': {
      process.stdout.write(`Source: archived dialog session\n`);
      process.stdout.write(`Tool use ID: ${toolUseId}\n`);
      process.stdout.write(`Archived at: ${result.archivedAt}\n`);
      if ('hashVerified' in result && result.hashVerified) {
        process.stdout.write(`Hash verified: yes\n`);
      }
      process.stdout.write(`Content size: ${Buffer.byteLength(result.content, 'utf-8')} bytes\n`);
      process.stdout.write(`---\n${result.content}\n`);
      break;
    }
    case 'unavailable': {
      process.stderr.write(`dialog content unavailable: tool_use_id=${toolUseId} reason=${result.reason}\n`);
      process.stderr.write(`Possible reasons:\n`);
      switch (result.reason) {
        case 'not_in_current':
          process.stderr.write(`  - tool_use_id 不在当前 dialog session（可能已 archived 或不存在）\n`);
          break;
        case 'not_in_archive':
          process.stderr.write(`  - tool_use_id 不在任何 archived dialog session\n`);
          break;
        case 'hash_mismatch':
          process.stderr.write(`  - 找到 tool_use_id 但 content hash 与提供的 --content-hash 不匹配（content tampered or wrong tool_use_id）\n`);
          break;
        case 'all_failed':
          process.stderr.write(`  - dialog session 全部失败：dialog dir 不存在 / current/archive 都不含 tool_use_id\n`);
          break;
        default:
          { const _exhaustiveReason: never = result.reason; void _exhaustiveReason; }
      }
      break;
    }
    default:
      { const _exhaustiveResult: never = result; void _exhaustiveResult; }
  }
}
