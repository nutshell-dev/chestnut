import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1354: Assembly-owned Daemon lifecycle session', () => {
  it('Assembly public session exposes only Daemon runtime handles plus same-origin dispose', () => {
    const types = read('src/assembly/types.ts');
    const body = types.match(/export interface Instances \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body).toContain('readonly dispose: (signal: string) => Promise<void>');
    for (const privateHandle of ['clawId', 'cronRunner', 'gateway', 'evolutionSystem', 'disposeContractSystems']) {
      expect(body).not.toContain(privateHandle);
    }
  });

  it('Assembly barrel does not expose the private disassembly operation', () => {
    expect(read('src/assembly/index.ts')).not.toMatch(/export \{\s*disassemble\s*\}/);
  });

  it('Daemon consumes the session disposal capability instead of a separate dependency', () => {
    const daemon = read('src/daemon/daemon.ts');
    expect(daemon).toContain('await instances.dispose(reason)');
    expect(daemon).not.toMatch(/^\s*disassemble:\s/m);
    expect(daemon).not.toContain('deps.disassemble');
  });

  it('Assembly captures private teardown resources in the returned session closure', () => {
    const assemble = read('src/assembly/assemble.ts');
    expect(assemble).toMatch(/dispose:\s*\(signal: string\)\s*=>\s*disassemble\(\{/);
    for (const captured of ['gateway', 'runtime', 'streamWriter', 'auditWriter', 'cronRunner', 'disposeContractSystems']) {
      expect(assemble).toMatch(new RegExp(`\\n\\s*${captured}[:,]`));
    }
  });
});
