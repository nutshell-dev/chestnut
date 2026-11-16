import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

const productionFiles = listTsFiles(SRC_ROOT);
const syncOwners = new Set([
  'foundation/process-exec/find-by-pattern.ts',
  'foundation/process-manager/find.ts',
  'foundation/process-manager/manager.ts',
]);
const cliSyncAllowlist = [
  'cli/commands/stop.ts',
  'core/status-service/forum-aggregators.ts',
];

describe('Phase 2146 B8 process-list synchronization boundary', () => {
  it('daemon/Motion/Watchdog/PM and all other production files have no legacy synchronous API hits', () => {
    // Split the retired names so this guard does not itself become a source-scan hit.
    const legacyNames = [
      ['find', 'Processes'].join(''),
      ['find', 'ProcessesDetailed'].join(''),
      ['find', 'ByPattern'].join(''),
      ['find', 'ByLiteralPattern'].join(''),
    ];
    const offenders = productionFiles.filter((file) => {
      // ProcessExec owns the backend-neutral async contract with a similar name;
      // this guard targets legacy consumers outside that L1 implementation.
      if (relative(file).startsWith('foundation/process-exec/')) return false;
      const source = readFileSync(file, 'utf8');
      return legacyNames.some((name) => new RegExp(`\\b${name}\\b`).test(source));
    }).map(relative);

    expect(offenders).toEqual([]);
  });

  it('limits every synchronous process-list consumer to CLI stop and status forum', () => {
    const syncCall = /\b(?:findProcessesSyncForCli|findByPatternSyncForCli|findByLiteralPatternSyncForCli)\s*\(/;
    const consumers = productionFiles.filter((file) => {
      if (syncOwners.has(relative(file))) return false;
      return syncCall.test(readFileSync(file, 'utf8'));
    }).map(relative).sort();

    expect(consumers).toEqual(cliSyncAllowlist);
  });

  it('keeps Watchdog enumeration awaited on the async PM facade', () => {
    for (const file of ['watchdog/orphan-sweep.ts', 'watchdog/watchdog-control.ts']) {
      const source = readFileSync(path.join(SRC_ROOT, file), 'utf8');
      expect(source).toContain('await pm.findProcessesAsync(');
      expect(source).not.toMatch(/\bfindProcessesSyncForCli\s*\(/);
    }
  });
});
