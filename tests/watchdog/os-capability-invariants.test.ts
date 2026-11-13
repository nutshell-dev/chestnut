import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const WATCHDOG_ROOT = path.resolve(process.cwd(), 'src/watchdog');
const WATCHDOG_CLI = path.resolve(process.cwd(), 'src/cli/commands/watchdog-cli.ts');

function productionSources(): Array<{ file: string; source: string }> {
  return readdirSync(WATCHDOG_ROOT)
    .filter(file => file.endsWith('.ts'))
    .map(file => ({
      file,
      source: readFileSync(path.join(WATCHDOG_ROOT, file), 'utf8'),
    }));
}

describe('Watchdog OS capability ownership (Phase 2142)', () => {
  it('does not call native signals or host query commands', () => {
    const sources = [
      ...productionSources(),
      { file: 'watchdog-cli.ts', source: readFileSync(WATCHDOG_CLI, 'utf8') },
    ];
    const offenders = sources.filter(({ source }) =>
      /process\.kill\(|\bspawnSync\(|\bexecFileSync\(|from ['"](?:node:)?child_process['"]/.test(source));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('keeps legacy boolean and signal adapters at the internal capability boundary', () => {
    const offenders = productionSources().filter(({ file, source }) =>
      file !== 'process-capabilities.ts' && file !== 'types.ts'
      && /\bdefaultKill\b|\bdefaultIsAlive\b|\bdefaultIsPidArgvMatching\b/.test(source));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('keeps Watchdog CLI on the business control entry without ps parsing', () => {
    const source = readFileSync(WATCHDOG_CLI, 'utf8');
    expect(source).toContain('stopWatchdog(fsFactory, deps)');
    expect(source).not.toMatch(/foundation\/process-(?:exec|manager)/);
    const offenders = productionSources().filter(({ source }) =>
      /\.command\.split\(|\bspawnSync\(['"]ps['"]/.test(source));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});
