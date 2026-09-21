/**
 * `chestnut audit lookup` subcommand
 *
 * Look up original content by --tool-use-id or --block-id.
 * Does NOT create an AuditLog; lookup helpers may emit conditional audit events
 * on I/O error paths internally, but the CLI itself is read-only.
 */

import * as path from 'path';
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  lookupContentByToolUseId,
  lookupContentByBlockId,
  BlockIdIndex,
  DIALOG_DIR,
  type LookupResult,
  type LookupOptions,
  type BlockIdLookupResult,
} from '../../foundation/dialog-store/index.js';
import type { AuditCommandDeps } from './audit-command-deps.js';


interface AuditLookupOpts {
  claw: string;
  toolUseId?: string;
  blockId?: string;
  contentHash?: string;
  json?: boolean;
}

export async function auditLookupCommand(
  deps: AuditCommandDeps,
  opts: AuditLookupOpts,
): Promise<void> {
  // phase 682: caller 直 reach dialog-store/lookupContentByToolUseId、不走 audit reader facade。
  if (!opts.toolUseId && !opts.blockId) {
    throw new CliError('must provide --tool-use-id or --block-id');
  }
  if (opts.toolUseId && opts.blockId) {
    throw new CliError('--tool-use-id and --block-id are mutually exclusive');
  }

  deps.rootConfig.loadGlobal();

  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isMotion && deps.rootConfig.loadClaw(getClawConfigPath(opts.claw)) === undefined) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const dialogDir = path.join(clawDir, DIALOG_DIR);

  if (opts.blockId) {
    const blockIdIndex = new BlockIdIndex(fs, dialogDir);
    blockIdIndex.load();
    const result = lookupContentByBlockId(fs, dialogDir, opts.blockId, blockIdIndex);
    emitBlockId(result, opts.blockId, opts.json ?? false);
    if (result.source === 'unavailable') {
      process.exitCode = 3;
    }
    return;
  }

  // Validate contentHash format if provided (8-char hex)
  if (opts.contentHash && !/^[0-9a-fA-F]{8}$/.test(opts.contentHash)) {
    throw new CliError('--content-hash must be 8-character hex');
  }

  const lookupOpts: LookupOptions = {
    contentHash: opts.contentHash,
  };

  const result = lookupContentByToolUseId(fs, dialogDir, opts.toolUseId!, lookupOpts);
  emit(result, opts.toolUseId!, opts.json ?? false);

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
      if (result.degradationNotes && result.degradationNotes.length > 0) {
        for (const note of result.degradationNotes) {
          process.stdout.write(`\x1b[33mDegradation: ${note}\x1b[0m\n`);
        }
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
        case 'io_error':
          process.stderr.write(`  - dialog I/O error while reading current/archive (detail=${result.detail.join('; ')})\n`);
          break;
        case 'corrupted':
          process.stderr.write(`  - dialog session 文件腐化（JSON parse 失败）(detail=${result.detail.join('; ')})\n`);
          break;
        default:
          { const _exhaustiveReason: never = result; void _exhaustiveReason; }
      }
      break;
    }
    default:
      { const _exhaustiveResult: never = result; void _exhaustiveResult; }
  }
}

function emitBlockId(result: BlockIdLookupResult, shortBlockId: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  switch (result.source) {
    case 'archive': {
      process.stdout.write(`Source: archive\n`);
      process.stdout.write(`Block ID: ${result.blockId}\n`);
      process.stdout.write(`Block type: ${result.blockType}\n`);
      if (result.toolUseId) {
        process.stdout.write(`Tool use ID: ${result.toolUseId}\n`);
      }
      process.stdout.write(`Archived at: ${result.archivedAt}\n`);
      process.stdout.write(`---\n${result.content}\n`);
      break;
    }
    case 'unavailable': {
      const detail = result.detail === undefined
        ? ''
        : Array.isArray(result.detail) ? result.detail.join('; ') : result.detail;
      process.stderr.write(`Block ID not found: ${shortBlockId} reason=${result.reason}${detail ? ` detail=${detail}` : ''}\n`);
      break;
    }
    default:
      { const _exhaustiveResult: never = result; void _exhaustiveResult; }
  }
}
