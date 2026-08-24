import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const processControlSource = readFileSync(
  new URL('../../../src/foundation/process-exec/process-control.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-exec/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec Signal type deep surface', () => {
  it('keeps the neutral signal union local behind kill', () => {
    expect(processControlSource).not.toMatch(/export\s+type\s+Signal\s*=/);
    expect(processControlSource).toMatch(
      /(?:^|\n)type\s+Signal\s*=\s*'TERM'\s*\|\s*'KILL'\s*\|\s*'INT';/,
    );
    expect(processControlSource).toMatch(
      /const\s+SIGNAL_MAP:\s*Record<Signal,\s*NodeJS\.Signals>\s*=\s*\{/,
    );
    expect(processControlSource).toMatch(/TERM:\s*'SIGTERM',/);
    expect(processControlSource).toMatch(/KILL:\s*'SIGKILL',/);
    expect(processControlSource).toMatch(/INT:\s*'SIGINT',/);
    expect(processControlSource).toMatch(/export\s+function\s+kill\(pid:\s*number,\s*signal:\s*Signal\):\s*void\s*\{/);
    expect(barrelSource).toMatch(/export\s*\{\s*kill,\s*isAlive\s*\}\s*from\s*'\.\/process-control\.js';/);
    expect(barrelSource).not.toMatch(/\bSignal\b/);
  });
});
