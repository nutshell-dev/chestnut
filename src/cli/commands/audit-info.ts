/**
 * `chestnut audit info` subcommand
 *
 * Read-only audit metadata inspection.
 * Does NOT emit audit events (ML 5).
 *
 * Exit code semantics (per phase 269、与 audit-lookup phase 152 + audit-query phase 269 区分):
 * - 0 = success / 1 = CliError ONLY.
 * - No semantic exit code 3+ by-design — info command 是 reporting view、
 *   0 audit files 是 valid "fresh claw" state、非 "result unavailable"。
 *   future caller 若需 audit file presence check、应通过 stdout JSON output 解析、
 *   而非 exit code。
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  listAuditFiles,
  listPendingFallbackDumps,
  type AuditFileInfo,
} from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';


import _snapshotJson from '../../foundation/audit/audit-events.snapshot.json' with { type: 'json' };
const snapshotJson = _snapshotJson as SnapshotJson;

interface AuditInfoOpts {
  claw: string;
  json?: boolean;
}

export async function auditInfoCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  opts: AuditInfoOpts,
): Promise<void> {
  loadGlobalConfig(deps);

  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isMotion && !clawExists(deps, getClawConfigPath(opts.claw))) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const files = listAuditFiles(fs, clawDir);
  const pendingDumps = listPendingFallbackDumps();

  const enrichedFiles = files.map((f) => enrichFile(f, snapshotJson));

  const routing = snapshotJson.fileRouting
    ? { available: true, map: snapshotJson.fileRouting }
    : { available: false };

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      claw: opts.claw,
      base_dir: path.resolve(clawDir),
      files: enrichedFiles,
      pending_fallback_dumps: pendingDumps,
      schema_routing: routing,
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Claw: ${opts.claw}\n`);
  process.stdout.write(`Base dir: ${path.resolve(clawDir)}\n\n`);
  process.stdout.write(`Audit files (${enrichedFiles.length}):\n`);
  for (const f of enrichedFiles) {
    const star = f.is_business_main ? ' *' : '  ';
    process.stdout.write(`${star} ${f.name.padEnd(12)} ${f.path}\n`);
    process.stdout.write(`    owner_modules (${f.owner_modules.length}): ${f.owner_modules.slice(0, 5).join(', ')}${f.owner_modules.length > 5 ? '...' : ''}\n`);
    process.stdout.write(`    registered_types: ${f.registered_types_count}\n`);
  }
  process.stdout.write(`  (* = business main, cross-process literal contract)\n\n`);

  process.stdout.write(`Schema routing: ${routing.available ? 'enabled' : 'disabled (phase 122 ratify, impl pending)'}\n\n`);

  if (pendingDumps.length > 0) {
    process.stdout.write(`Pending fallback dumps (${pendingDumps.length}):\n`);
    for (const d of pendingDumps) {
      process.stdout.write(`  ${d.path} (pid=${d.pid}, size=${d.size})\n`);
    }
    process.stdout.write(`  → will be reconciled on next daemon boot (writer.ts:154)\n`);
  } else {
    process.stdout.write(`Pending fallback dumps: 0\n`);
  }
}

function enrichFile(f: AuditFileInfo, snapshot: SnapshotJson) {
  const owner_modules: string[] = [];
  let registered_types_count = 0;

  if (!snapshot.fileRouting) {
    if (f.name === 'audit') {
      owner_modules.push(...Object.keys(snapshot.modules));
      registered_types_count = Object.values(snapshot.modules).reduce(
        (sum, arr) => sum + arr.length, 0,
      );
    }
  } else {
    const typesInFile = new Set<string>();
    for (const [modName, types] of Object.entries(snapshot.modules)) {
      for (const t of types) {
        const typeName = typeof t === 'string' ? t : (t as { type: string }).type;
        const routedFile = snapshot.fileRouting[typeName] ?? 'audit';
        if (routedFile === f.name) {
          typesInFile.add(typeName);
          if (!owner_modules.includes(modName)) owner_modules.push(modName);
        }
      }
    }
    registered_types_count = typesInFile.size;
  }

  return {
    name: f.name,
    path: f.path,
    is_business_main: f.isBusinessMain,
    owner_modules,
    registered_types_count,
  };
}

interface SnapshotJson {
  modules: Record<string, (string | { type: string })[]>;
  fileRouting?: Record<string, string>;
}
