import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { UnixDomainSocketTransport } from '../../../src/foundation/transport/unix-socket.js';

describe('Transport endpoint ownership contract (phase 1373)', () => {
  const typesSource = readFileSync('src/foundation/transport/types.ts', 'utf8');

  it('keeps the public lifecycle protocol-neutral', () => {
    expect(typesSource).toMatch(/listen\(\): Promise<void>;/);
    expect(typesSource).not.toMatch(/TransportOptions/);
    expect(typesSource).not.toMatch(/socketPath/);
  });

  it('rejects an empty concrete UDS endpoint at construction', () => {
    const fs = { delete: async () => undefined };
    expect(() => new UnixDomainSocketTransport({
      fs: fs as unknown as FileSystem,
      socketPath: '',
    })).toThrow('socketPath required');
  });
});
