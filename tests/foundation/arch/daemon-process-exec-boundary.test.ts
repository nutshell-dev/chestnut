import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DAEMON_ROOT = fileURLToPath(new URL('../../../src/daemon', import.meta.url));

function daemonSources(): Array<{ file: string; source: string }> {
  return readdirSync(DAEMON_ROOT)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({
      file: name,
      source: readFileSync(`${DAEMON_ROOT}/${name}`, 'utf8'),
    }));
}

describe('Daemon / ProcessExec host capability boundary', () => {
  it('keeps raw process signalling, OS identity lookup, and host signal registration out of Daemon', () => {
    const offenders = daemonSources().filter(({ source }) =>
      /process\.kill\(|getProcessStartTime|from ['"](?:node:)?child_process['"]|process\.on\(['"](?:SIGTERM|SIGINT)['"]/.test(source),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('keeps host environment selection out of the Daemon spawn specification', () => {
    const spawnOptions = readFileSync(`${DAEMON_ROOT}/spawn-options.ts`, 'utf8');
    expect(spawnOptions).not.toMatch(/\.\.\.process\.env/);
    expect(spawnOptions).not.toContain('createSpawnEnvironment');
    expect(spawnOptions).not.toMatch(/process\.platform|node:child_process|from ['"]child_process['"]/);
  });
});
