import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

describe('phase 1340: Assembly global config path stays owner-internal', () => {
  it('production callers outside Assembly do not import the path helper', () => {
    const importers = walk(SRC)
      .filter((file) => !file.startsWith(path.join(SRC, 'assembly') + path.sep))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('assembly/config/global-config-path'))
      .map((file) => path.relative(SRC, file));
    expect(importers).toEqual([]);
  });

  it('legacy snapshots carry their owner resource reference', () => {
    const text = fs.readFileSync(path.join(SRC, 'assembly', 'config', 'config-load.ts'), 'utf8');
    expect(text).toContain('sourcePath: string;');
    // phase 1890 Step J：watchdog 族 legacy 段原语已删（Step L 将删 audit 族）。
    expect(text.match(/sourcePath: configPath/g)).toHaveLength(1);
  });
});
