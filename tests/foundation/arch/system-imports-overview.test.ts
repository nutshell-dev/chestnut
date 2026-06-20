import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 499: comprehensive ratchet test that no other src files import
 * Node.js system modules outside their designated owner.
 *
 * Designated owners:
 *   - fs / fs/promises -> foundation/fs/* + audit/{writer,reader} + process-exec/spawn-detached
 *   - child_process     -> foundation/process-exec/*
 *   - net               -> foundation/transport/*
 *   - crypto            -> foundation/uuid + foundation/hash
 *   - os                -> foundation/audit/{writer,reader}
 *
 * Other system modules (http/https/tls/dns/stream/worker_threads/cluster/process)
 * must have 0 direct imports under src/.
 */
describe('system module imports overview ratchet (phase 499)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  function listImporters(moduleName: string): string[] {
    const cmd = `grep -rEln "from ['\\\"](?:node:)?${moduleName}['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  }

  it.each([
    ['http'],
    ['https'],
    ['tls'],
    ['dns'],
    ['stream'],
    ['worker_threads'],
    ['cluster'],
    ['process'],
  ])('no src file imports node:%s', (moduleName) => {
    const files = listImporters(moduleName);
    expect(files).toEqual([]);
  });
});
