/**
 * `chestnut audit lookup` subcommand
 *
 * Look up full tool content by tool_use_id (4-level fallback).
 * Does NOT emit audit events (ML 5).
 */

import * as path from 'path';
import {
  loadGlobalConfig,
  clawExists,
  getClawDir,
  getClawConfigPath,
} from '../../foundation/config/index.js';
import { getNamedSubrootDir } from '../../assembly/install-paths.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CliError } from '../errors.js';
import {
  createAuditReader,
  type LookupResult,
  type LookupOptions,
} from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { assertNever } from '../../foundation/utils/index.js';

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
  loadGlobalConfig(deps);

  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isMotion && !clawExists(deps, getClawConfigPath(opts.claw))) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const auditPath = path.join(clawDir, `${opts.file}.tsv`);

  // Validate contentHash format if provided (8-char hex)
  if (opts.contentHash && !/^[0-9a-fA-F]{8}$/.test(opts.contentHash)) {
    throw new CliError('--content-hash must be 8-character hex');
  }

  const reader = createAuditReader(fs, auditPath);
  const lookupOpts: LookupOptions = {
    contentHash: opts.contentHash,
  };

  const result = reader.lookupContent(toolUseId, lookupOpts);
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
          assertNever(result.reason);
      }
      break;
    }
    default:
      assertNever(result);
  }
}
