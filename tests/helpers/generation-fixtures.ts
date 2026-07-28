/**
 * Generation directory fixtures for Phase 1204 Step E tests.
 *
 * Centralises construction of spawning/active generation records so tests
 * stay aligned with the canonical directory layout instead of legacy
 * status/pid files.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { DaemonDir } from '../../src/foundation/process-manager/index.js';
import {
  GENERATION_FILE,
  PID_FILE,
  READY_FILE,
  getActiveDir,
  getSpawningDir,
} from '../../src/foundation/process-manager/generation.js';

export interface GenerationFixtureOptions {
  generationId: string;
  pid: number;
  startTime?: string;
  parentPid?: number;
}

function generationRecord(daemonDir: DaemonDir, opts: GenerationFixtureOptions) {
  return {
    schema_version: 1,
    generation_id: opts.generationId,
    daemon_dir: daemonDir,
    parent_pid: opts.parentPid ?? process.pid,
    created_at: new Date().toISOString(),
  };
}

function pidRecord(opts: GenerationFixtureOptions) {
  return {
    schema_version: 1,
    generation_id: opts.generationId,
    pid: opts.pid,
    ...(opts.startTime ? { start_time: opts.startTime } : {}),
    created_at: new Date().toISOString(),
  };
}

export function writeActiveGenerationSync(
  daemonDir: DaemonDir,
  opts: GenerationFixtureOptions,
): void {
  const dir = getActiveDir(daemonDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, GENERATION_FILE), JSON.stringify(generationRecord(daemonDir, opts), null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, PID_FILE), JSON.stringify(pidRecord(opts), null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, READY_FILE), JSON.stringify(pidRecord(opts), null, 2), 'utf-8');
}

export function writeSpawningGenerationSync(
  daemonDir: DaemonDir,
  opts: GenerationFixtureOptions,
): void {
  const dir = getSpawningDir(daemonDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, GENERATION_FILE), JSON.stringify(generationRecord(daemonDir, opts), null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, PID_FILE), JSON.stringify(pidRecord(opts), null, 2), 'utf-8');
}
